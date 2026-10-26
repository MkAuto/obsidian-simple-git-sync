// No 'obsidian' imports here: test/git.test.mjs runs this file under plain Node.
import git from 'isomorphic-git';
import type { HttpClient, MergeDriverCallback, PromiseFsClient } from 'isomorphic-git';
import diff3Merge from 'diff3';

/** Everything a sync needs from git. The remote is always the current branch's upstream on origin. */
export interface Engine {
	/** Stages and commits every change. Returns false when there was nothing to commit. */
	commitAll(message: string): Promise<boolean>;
	fetch(): Promise<void>;
	/**
	 * Merges the fetched remote. Where both sides changed the same lines, the remote wins.
	 * `beforeOverwrite` gets the files about to lose local content, while the working tree still holds it.
	 */
	merge(beforeOverwrite: (paths: string[]) => Promise<void>): Promise<void>;
	/** Files whose local version differs from the fetched remote: what a reset throws away. */
	localChanges(): Promise<string[]>;
	resetToRemote(): Promise<void>;
	push(): Promise<void>;
	/** Drops a file from the index but keeps it on disk. */
	untrack(path: string): Promise<void>;
}

type Log = (text: string) => void;
type ExecFile = typeof import('child_process').execFile;

const split = (out: string) => out.split('\0').filter(Boolean);

/** Desktop: the installed git, with the user's own SSH setup. */
export class NativeGit implements Engine {
	private cwd: string;
	private execFile: ExecFile;
	private log: Log;

	/** `execFile` is passed in: this file can't import Node modules, or the plugin breaks on mobile. */
	constructor(cwd: string, execFile: ExecFile, log: Log) {
		this.cwd = cwd;
		this.execFile = execFile;
		this.log = log;
	}

	private run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
		return new Promise((resolve) => {
			this.execFile(
				'git',
				args,
				// ponytail: nothing can answer an SSH passphrase prompt here, so a hung command times out instead.
				// GIT_DIR: a broken .git is an error, not a reason to look for a repo in the folders above the vault.
				// eslint-disable-next-line no-undef -- desktop only, where Node's process exists
				{ cwd: this.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_DIR: '.git' }, timeout: 120_000, maxBuffer: 64 << 20, windowsHide: true },
				(error, out, err) => {
					this.log(`git ${args.join(' ')}\n${out}${err}`.replace(/\0/g, '\n').trimEnd());
					const timedOut = error?.killed ? 'git timed out (waiting for a password or passphrase?)' : '';
					resolve({
						code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
						out,
						err: err || timedOut || error?.message || '',
					});
				},
			);
		});
	}

	private async git(...args: string[]) {
		const result = await this.run(...args);
		if (result.code !== 0) throw new Error(result.err.trim() || `git ${args[0]} failed`);
		return result.out;
	}

	async commitAll(message: string) {
		await this.git('add', '-A');
		if ((await this.run('diff', '--cached', '--quiet')).code === 0) return false;
		await this.git('commit', '-q', '-m', message);
		return true;
	}

	async fetch() {
		await this.git('fetch', '-q');
	}

	async merge(beforeOverwrite: (paths: string[]) => Promise<void>) {
		// Dry run first: its conflict list is the set of files where the remote is about to win.
		const check = await this.run('merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', '@{u}');
		if (check.code !== 0 && check.code !== 1) throw new Error(check.err.trim() || 'git merge-tree failed');
		await beforeOverwrite(check.code === 1 ? split(check.out).slice(1) : []);

		const merge = await this.run('merge', '-q', '--no-edit', '-X', 'theirs', '@{u}');
		if (merge.code === 0) return;
		// -X theirs settles overlapping edits but not modify/delete: take the remote side by hand.
		const unmerged = split(await this.git('diff', '--name-only', '-z', '--diff-filter=U'));
		if (!unmerged.length) throw new Error(merge.err.trim() || 'git merge failed');
		for (const path of unmerged) {
			if ((await this.run('cat-file', '-e', `@{u}:${path}`)).code === 0) await this.git('checkout', '--theirs', '--', path);
			else await this.git('rm', '-qf', '--', path);
		}
		await this.git('add', '-A');
		await this.git('commit', '-q', '--no-edit');
	}

	async localChanges() {
		return split(await this.git('diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', '@{u}', 'HEAD'));
	}

	async resetToRemote() {
		await this.git('reset', '-q', '--hard', '@{u}');
	}

	async push() {
		await this.git('push', '-q');
	}

	async untrack(path: string) {
		await this.git('rm', '-q', '--cached', '--ignore-unmatch', '--', path);
	}

	/** A git config value, or '' when it isn't set. */
	async config(key: string) {
		return (await this.run('config', '--get', key)).out.trim();
	}
}

/** isomorphic-git's fs, plus the calls this file makes on it directly. */
export type Fs = PromiseFsClient & {
	promises: {
		writeFile(path: string, data: Uint8Array): Promise<void>;
		mkdir(path: string, options: { recursive: true }): Promise<unknown>;
		unlink(path: string): Promise<void>;
		rename(from: string, to: string): Promise<void>;
	};
};

export interface BuiltinOptions {
	fs: Fs;
	dir: string;
	http: HttpClient;
	token: string;
	author: { name: string; email: string };
	log: Log;
}

// Same line split isomorphic-git uses for its own merges.
const lines = (text: string) => text.match(/^.*(\r?\n|$)/gm) ?? [];
// GitHub ignores the username when the password is a token; other hosts accept any non-empty one.
const auth = (token: string) => () => ({ username: 'x-access-token', password: token });

/** Mobile, and desktop on request: isomorphic-git over HTTPS with a token. */
export class BuiltinGit implements Engine {
	private o: BuiltinOptions;

	constructor(options: BuiltinOptions) {
		this.o = options;
	}

	private get repo() {
		return { fs: this.o.fs, dir: this.o.dir };
	}

	private get remote() {
		return { ...this.repo, http: this.o.http, onAuth: auth(this.o.token) };
	}

	private async branch() {
		const branch = await git.currentBranch(this.repo);
		if (!branch) throw new Error('HEAD is not on a branch');
		return { branch, remote: `refs/remotes/origin/${branch}` };
	}

	async commitAll(message: string) {
		// ponytail: statusMatrix hashes the whole vault; fine for thousands of notes, slow beyond that
		const changed = (await git.statusMatrix(this.repo)).filter(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1);
		if (!changed.length) return false;
		for (const [filepath, , workdir] of changed) {
			if (workdir === 0) await git.remove({ ...this.repo, filepath });
			else await git.add({ ...this.repo, filepath });
		}
		await git.commit({ ...this.repo, message, author: this.o.author });
		this.o.log(`commit ${changed.length} file(s): ${message}`);
		return true;
	}

	async fetch() {
		const { branch } = await this.branch();
		await git.fetch({ ...this.remote, ref: branch, singleBranch: true });
		this.o.log(`fetch origin ${branch}`);
	}

	async merge(beforeOverwrite: (paths: string[]) => Promise<void>) {
		const { branch, remote } = await this.branch();
		const merge = (mergeDriver: MergeDriverCallback, dryRun = false) =>
			git.merge({ ...this.repo, ours: branch, theirs: remote, author: this.o.author, mergeDriver, dryRun, noUpdateBranch: true });

		try {
			// A dry run that refuses every overlap. The merge driver only sees file names, so the
			// conflict error is the one place that lists the full paths where the remote will win.
			await merge(({ contents: [base = '', ours = '', theirs = ''] }) => ({
				cleanMerge: !ours.includes('\0') && !theirs.includes('\0') && diff3Merge(lines(ours), lines(base), lines(theirs)).every((block) => block.ok),
				mergedText: '',
			}), true);
		} catch (e) {
			if (!(e instanceof git.Errors.MergeConflictError)) throw e;
			const { bothModified, deleteByUs, deleteByTheirs } = e.data;
			await beforeOverwrite([...bothModified, ...deleteByUs, ...deleteByTheirs]);
			// The line merge below can't settle deletions or binary files: commit the remote side of those first.
			const whole = [...deleteByUs, ...deleteByTheirs];
			for (const filepath of bothModified) if (await this.isBinary(filepath, 'HEAD', remote)) whole.push(filepath);
			if (whole.length) {
				for (const filepath of whole) await this.takeRemote(remote, filepath);
				await git.commit({ ...this.repo, message: 'Take remote side of conflicts', author: this.o.author });
			}
		}

		const { oid } = await merge(({ contents: [base = '', ours = '', theirs = ''] }) => ({
			cleanMerge: true,
			mergedText: diff3Merge(lines(ours), lines(base), lines(theirs)).map((block) => (block.ok ?? block.conflict.b).join('')).join(''),
		}));
		await this.moveBranch(branch, oid!); // only a dry run leaves oid out
		this.o.log(`merge ${remote}`);
	}

	/**
	 * Updates the files first, then moves the branch. If the update stops halfway (app killed, failed write),
	 * the branch hasn't moved: the files already updated look like local edits that agree with the remote,
	 * instead of the ones not yet updated looking like local edits that revert it.
	 */
	private async moveBranch(branch: string, oid: string, force = false) {
		await git.checkout({ ...this.repo, ref: oid, force, noUpdateHead: true });
		await git.writeRef({ ...this.repo, ref: `refs/heads/${branch}`, value: oid, force: true });
	}

	private async blob(ref: string, filepath: string) {
		const oid = await git.resolveRef({ ...this.repo, ref });
		try {
			return (await git.readBlob({ ...this.repo, oid, filepath })).blob;
		} catch (e) {
			if (e instanceof git.Errors.NotFoundError) return null;
			throw e;
		}
	}

	private async isBinary(filepath: string, ...refs: string[]) {
		for (const ref of refs) if ((await this.blob(ref, filepath))?.includes(0)) return true;
		return false;
	}

	private async takeRemote(remote: string, filepath: string) {
		const blob = await this.blob(remote, filepath);
		const path = `${this.o.dir.replace(/\/$/, '')}/${filepath}`;
		if (blob) {
			await this.o.fs.promises.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
			await this.o.fs.promises.writeFile(path, blob);
			await git.add({ ...this.repo, filepath });
		} else {
			await this.o.fs.promises.unlink(path);
			await git.remove({ ...this.repo, filepath });
		}
	}

	async localChanges() {
		const { remote } = await this.branch();
		const rows = await git.statusMatrix({ ...this.repo, ref: remote });
		return rows.filter(([, , workdir]) => workdir === 2).map(([filepath]) => filepath);
	}

	async resetToRemote() {
		const { branch, remote } = await this.branch();
		await this.moveBranch(branch, await git.resolveRef({ ...this.repo, ref: remote }), true);
		this.o.log(`reset to ${remote}`);
	}

	async push() {
		const result = await git.push(this.remote);
		if (!result.ok) throw new Error(result.error ?? 'push rejected');
		this.o.log('push');
	}

	async untrack(filepath: string) {
		await git.remove({ ...this.repo, filepath });
	}
}

export async function listBranches(http: HttpClient, url: string, token: string) {
	const info = await git.getRemoteInfo({ http, url, onAuth: auth(token) });
	// Branch names with slashes come back as nested objects.
	const names = (tree: object, prefix: string): string[] =>
		Object.entries(tree).flatMap(([name, value]) => (typeof value === 'string' ? [prefix + name] : names(value as object, `${prefix}${name}/`)));
	const heads = (info.refs as { heads?: object } | undefined)?.heads ?? {};
	return { branches: names(heads, ''), head: info.HEAD?.replace('refs/heads/', '') };
}

/** Where a clone is built, next to the vault's files. */
export const CLONING = '.git-cloning';

/** `beforeOverwrite` gets the vault's files that the repo's differing versions are about to replace, as in merge. */
export async function clone(
	fs: Fs,
	dir: string,
	http: HttpClient,
	url: string,
	token: string,
	branch: string,
	beforeOverwrite: (paths: string[]) => Promise<void>,
) {
	// Built under another name and renamed to .git once every file is written. A clone the app didn't live
	// through must not look like a repo with files missing: the first sync would commit them as deleted.
	const root = dir.replace(/\/$/, '');
	const gitdir = `${root}/${CLONING}`;
	await git.clone({ fs, dir, gitdir, http, url, ref: branch, singleBranch: true, noCheckout: true, onAuth: auth(token) });
	const rows = await git.statusMatrix({ fs, dir, gitdir });
	await beforeOverwrite(rows.filter(([, head, workdir]) => head === 1 && workdir === 2).map(([filepath]) => filepath));
	// force: the vault already has an .obsidian folder, and the repo's version replaces it.
	await git.checkout({ fs, dir, gitdir, ref: branch, force: true });
	await fs.promises.rename(gitdir, `${root}/.git`);
}
