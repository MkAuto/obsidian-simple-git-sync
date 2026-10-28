// No 'obsidian' imports here: test/git.test.mjs runs this file under plain Node.
import git from 'isomorphic-git';
import type { HttpClient, MergeDriverCallback, PromiseFsClient, TreeEntry } from 'isomorphic-git';
import diff3Merge from 'diff3';

/** A side's last change to a file: when, in ms, and on which device. */
export interface Change {
	time: number;
	device: string;
}

/** A file both sides changed in ways that overlap, settled for one side. */
export interface Conflict {
	path: string;
	kept: 'local' | 'remote';
	local: Change;
	remote: Change;
	/** The version that lost, or null where the losing side deleted the file. */
	lost: Uint8Array | null;
}

/**
 * A push the remote refused because it moved on: another device pushed after this one fetched. Merging again
 * fixes it. Never force: that would throw away the other device's work.
 */
export class PushRejected extends Error {
	constructor() {
		super('Another device pushed at the same time. The next sync merges its changes and pushes again.');
	}
}

/** Everything a sync needs from git. The remote is always the current branch's upstream on origin. */
export interface Engine {
	/** Stages and commits every change. Returns false when there was nothing to commit. */
	commitAll(message: string): Promise<boolean>;
	fetch(): Promise<void>;
	/**
	 * Merges the fetched remote. Where both sides changed the same lines, or one deleted what the other changed,
	 * the side that changed the file last wins (the remote on a tie), or always the remote without `newestWins`.
	 * Lines only one side changed are kept from both. `beforeOverwrite` gets the conflicts before any file is written.
	 */
	merge(newestWins: boolean, beforeOverwrite: (conflicts: Conflict[]) => Promise<void>): Promise<Conflict[]>;
	/** Files whose local version differs from the fetched remote: what a reset throws away. */
	localChanges(): Promise<string[]>;
	resetToRemote(): Promise<void>;
	push(): Promise<void>;
	/** Drops a file from the index but keeps it on disk. */
	untrack(path: string): Promise<void>;
}

type Log = (text: string) => void;

// Node's types, by hand and only as far as NativeGit uses them: Obsidian's plugin review type-checks without
// @types/node, so Node's own types read as unsafe there.
/** Environment variables, like `process.env`. */
export type Env = Record<string, string | undefined>;
/** Node's `child_process.execFile`, with `encoding: 'buffer'`. */
export type ExecFile = (
	file: string,
	args: string[],
	options: { cwd: string; env: Env; encoding: 'buffer'; timeout: number; maxBuffer: number; windowsHide: boolean },
	callback: (error: { code?: number | string | null; killed?: boolean; message: string } | null, stdout: Uint8Array, stderr: Uint8Array) => void,
) => { stdin: { end(data: Uint8Array): void } | null };

const split = (out: string) => out.split('\0').filter(Boolean);

// Same line split isomorphic-git uses for its own merges.
const lines = (text: string) => text.match(/^.*(\r?\n|$)/gm) ?? [];
const isBinary = (data: Uint8Array | null) => !!data?.includes(0);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : '');
const bytes = (data: Uint8Array | string) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

/** A line merge where overlapping changes come from the `kept` side. */
const mergeText = (base: string, ours: string, theirs: string, kept: Conflict['kept']) =>
	diff3Merge(lines(ours), lines(base), lines(theirs))
		.map((block) => (block.ok ?? (kept === 'local' ? block.conflict.a : block.conflict.b)).join(''))
		.join('');

/** The side whose last change is newer wins. Commit times are in seconds, so a tie is common: the remote takes it. */
const winner = (newestWins: boolean, local: Change, remote: Change): Conflict['kept'] =>
	newestWins && local.time > remote.time ? 'local' : 'remote';

// main.ts writes `Sync: {device} {YYYY-MM-DD HH:mm}`; other commits name their author instead.
const device = (message: string, author: string) => /^Sync: (.+) \d{4}-\d\d-\d\d \d\d:\d\d$/.exec(message.trim())?.[1] ?? author;

/** Desktop: the installed git, with the user's own SSH setup. */
export class NativeGit implements Engine {
	private cwd: string;
	private execFile: ExecFile;
	private env: Env;
	private log: Log;

	/** `execFile` and `env` are passed in: this file can't import Node modules, or the plugin breaks on mobile. */
	constructor(cwd: string, execFile: ExecFile, env: Env, log: Log) {
		this.cwd = cwd;
		this.execFile = execFile;
		this.env = env;
		this.log = log;
	}

	/** Raw bytes in and out, for file contents. Logs nothing: callers log what's readable. */
	private exec(args: string[], input?: Uint8Array): Promise<{ code: number; out: Uint8Array; err: string }> {
		return new Promise((resolve) => {
			const child = this.execFile(
				'git',
				args,
				{
					cwd: this.cwd,
					// ponytail: nothing can answer an SSH passphrase prompt here, so a hung command times out instead.
					// GIT_DIR: a broken .git is an error, not a reason to look for a repo in the folders above the vault.
					env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_DIR: '.git' },
					encoding: 'buffer',
					timeout: 120_000,
					maxBuffer: 64 << 20,
					windowsHide: true,
				},
				(error, out, err) => {
					const timedOut = error?.killed ? 'git timed out (waiting for a password or passphrase?)' : '';
					resolve({
						code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
						out,
						err: text(err) || timedOut || error?.message || '',
					});
				},
			);
			if (input) child.stdin?.end(input);
		});
	}

	private async run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
		const result = await this.exec(args);
		const out = text(result.out);
		this.log(`git ${args.join(' ')}\n${out}${result.err}`.replace(/\0/g, '\n').trimEnd());
		return { ...result, out };
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

	async merge(newestWins: boolean, beforeOverwrite: (conflicts: Conflict[]) => Promise<void>) {
		// Dry run first: its conflict list is the set of files where one side is about to win.
		const check = await this.run('merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', '@{u}');
		if (check.code !== 0 && check.code !== 1) throw new Error(check.err.trim() || 'git merge-tree failed');
		const conflicts: Conflict[] = [];
		for (const path of check.code === 1 ? split(check.out).slice(1) : []) {
			const local = await this.lastChange('HEAD', path);
			const remote = await this.lastChange('@{u}', path);
			const kept = winner(newestWins, local, remote);
			conflicts.push({ path, kept, local, remote, lost: await this.blob(kept === 'local' ? '@{u}' : 'HEAD', path) });
		}
		await beforeOverwrite(conflicts);

		// -X theirs settles the overlapping lines of a remote win. What's left: modify/delete, and the local wins.
		const merge = await this.run('merge', '-q', '--no-edit', '--no-commit', '-X', 'theirs', '@{u}');
		if ((await this.run('rev-parse', '-q', '--verify', 'MERGE_HEAD')).code !== 0) {
			if (merge.code !== 0) throw new Error(merge.err.trim() || 'git merge failed');
			return conflicts; // a fast-forward: there was nothing local to merge
		}
		const unmerged = new Set(split(await this.git('diff', '--name-only', '-z', '--diff-filter=U')));
		const base = (await this.git('merge-base', 'HEAD', '@{u}')).trim();
		for (const { path, kept } of conflicts) {
			if (kept === 'remote' && !unmerged.has(path)) continue;
			const ours = await this.blob('HEAD', path);
			const theirs = await this.blob('@{u}', path);
			const both = ours && theirs && !isBinary(ours) && !isBinary(theirs);
			const result = both ? new TextEncoder().encode(mergeText(text(await this.blob(base, path)), text(ours), text(theirs), kept)) : kept === 'local' ? ours : theirs;
			if (result) {
				const oid = text((await this.exec(['hash-object', '-w', '--stdin'], result)).out).trim();
				await this.git('update-index', '--add', '--cacheinfo', `100644,${oid},${path}`);
				await this.git('checkout', '--', path);
			} else {
				await this.git('rm', '-qf', '--ignore-unmatch', '--', path);
			}
		}
		await this.git('commit', '-q', '--no-edit');
		return conflicts;
	}

	/** The commit that brought `rev`'s version of a file, or its deletion, as `git log -1` finds it. */
	private async lastChange(rev: string, path: string): Promise<Change> {
		const [time = '0', message = '', author = ''] = (await this.git('log', '-1', '--format=%ct%x00%s%x00%an', rev, '--', path)).trim().split('\0');
		return { time: Number(time) * 1000, device: device(message, author) };
	}

	/** A file's content at `rev`, or null where it doesn't exist. */
	private async blob(rev: string, path: string) {
		const result = await this.exec(['cat-file', 'blob', `${rev}:${path}`]);
		this.log(`git cat-file blob ${rev}:${path}${result.code ? `\n${result.err.trimEnd()}` : ''}`);
		return result.code === 0 ? new Uint8Array(result.out) : null;
	}

	async localChanges() {
		return split(await this.git('diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', '@{u}', 'HEAD'));
	}

	async resetToRemote() {
		await this.git('reset', '-q', '--hard', '@{u}');
	}

	async push() {
		const result = await this.run('push', '-q');
		if (/\[rejected\].*\((fetch first|non-fast-forward)\)/.test(result.err)) throw new PushRejected();
		if (result.code !== 0) throw new Error(result.err.trim() || 'git push failed');
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
		readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string>;
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
		await this.finishUpdate();
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
		const { branch, remote } = await this.branch();
		// With singleBranch, `ref` is the one commit the server is told this device already has. The local branch
		// usually holds a commit the server has never seen (a sync commits first), and then it sends the whole
		// repo, which piles up in .git as another copy. The remote's last fetched state is one it knows.
		await git.fetch({ ...this.remote, remote: 'origin', ref: remote, remoteRef: `refs/heads/${branch}`, singleBranch: true });
		this.o.log(`fetch origin ${branch}`);
	}

	async merge(newestWins: boolean, beforeOverwrite: (conflicts: Conflict[]) => Promise<void>) {
		const { branch, remote } = await this.branch();
		const ours = await git.resolveRef({ ...this.repo, ref: branch });
		const theirs = await git.resolveRef({ ...this.repo, ref: remote });
		const merge = (a: string, b: string, mergeDriver: MergeDriverCallback, dryRun = false) =>
			git.merge({ ...this.repo, ours: a, theirs: b, message: `Merge branch 'origin/${branch}' into ${branch}`, author: this.o.author, mergeDriver, dryRun, noUpdateBranch: true });

		const conflicts: Conflict[] = [];
		try {
			// A dry run that refuses every overlap. The merge driver only sees file names, so the
			// conflict error is the one place that lists the full paths where one side will win.
			await merge(ours, theirs, ({ contents: [base = '', a = '', b = ''] }) => ({
				cleanMerge: !a.includes('\0') && !b.includes('\0') && diff3Merge(lines(a), lines(base), lines(b)).every((block) => block.ok),
				mergedText: '',
			}), true);
		} catch (e) {
			if (!(e instanceof git.Errors.MergeConflictError)) throw e;
			const { bothModified, deleteByUs, deleteByTheirs } = e.data;
			for (const path of [...bothModified, ...deleteByUs, ...deleteByTheirs]) {
				const local = await this.lastChange(ours, path);
				const change = await this.lastChange(theirs, path);
				const kept = winner(newestWins, local, change);
				conflicts.push({ path, kept, local, remote: change, lost: await this.blob(kept === 'local' ? theirs : ours, path) });
			}
			await beforeOverwrite(conflicts);
		}

		// Each conflict is settled here, not in the merge driver: the driver only gets a file's name, not its folder.
		// Both sides get the settled version in throwaway commits, so the merge agrees on those files, and the merge
		// commit then gets the real parents. A deletion or a binary file takes the winner's side whole.
		const settled: [string, TreeEntry | null][] = [];
		const base = conflicts.length ? ((await git.findMergeBase({ ...this.repo, oids: [ours, theirs] })) as string[])[0] : undefined;
		for (const { path, kept } of conflicts) {
			const [a, b] = [await this.blob(ours, path), await this.blob(theirs, path)];
			const entry = await this.entry(kept === 'local' ? ours : theirs, path);
			if (!a || !b || isBinary(a) || isBinary(b) || !entry) {
				settled.push([path, entry]);
				continue;
			}
			const merged = mergeText(text(base ? await this.blob(base, path) : null), text(a), text(b), kept);
			settled.push([path, { ...entry, oid: await git.writeBlob({ ...this.repo, blob: new TextEncoder().encode(merged) }) }]);
		}
		// What's left merges without overlaps, so the side the driver favours never matters.
		const driver: MergeDriverCallback = ({ contents: [base = '', a = '', b = ''] }) => ({ cleanMerge: true, mergedText: mergeText(base, a, b, 'remote') });
		let { oid } = settled.length
			? await merge(await this.withEntries(ours, settled), await this.withEntries(theirs, settled), driver)
			: await merge(ours, theirs, driver);
		if (settled.length) {
			const { commit } = await git.readCommit({ ...this.repo, oid: oid! });
			oid = await git.commit({ ...this.repo, message: commit.message, tree: commit.tree, parent: [ours, theirs], author: this.o.author, noUpdateBranch: true });
		}
		await this.moveBranch(branch, oid!); // only a dry run leaves oid out
		this.o.log(`merge ${remote}`);
		return conflicts;
	}

	/**
	 * Updates the files first, then moves the branch. If the update stops halfway (app killed, failed write),
	 * the branch hasn't moved: the files already updated look like local edits that agree with the remote,
	 * instead of the ones not yet updated looking like local edits that revert it. The marker names the commit
	 * being written, for finishUpdate() to complete a file the app died writing.
	 */
	private async moveBranch(branch: string, oid: string, force = false) {
		await this.o.fs.promises.writeFile(this.marker, new TextEncoder().encode(oid));
		await git.checkout({ ...this.repo, ref: oid, force, noUpdateHead: true });
		await git.writeRef({ ...this.repo, ref: `refs/heads/${branch}`, value: oid, force: true });
		await this.o.fs.promises.unlink(this.marker);
	}

	private get marker() {
		return `${this.o.dir.replace(/\/$/, '')}/.git/simple-git-sync-update`;
	}

	/**
	 * A write isn't atomic: an update the app didn't live through can leave a file cut short, and the next commit
	 * would take that for a local edit, newer than the remote's. A changed file that is the start of the version
	 * being written (empty included) gets the rest of it.
	 */
	private async finishUpdate() {
		let target;
		try {
			target = String(await this.o.fs.promises.readFile(this.marker, 'utf8')).trim();
		} catch {
			return; // no update was cut short
		}
		for (const [filepath, , workdir] of await git.statusMatrix(this.repo)) {
			if (workdir !== 2) continue;
			const wanted = await this.blob(target, filepath);
			const path = `${this.o.dir.replace(/\/$/, '')}/${filepath}`;
			const mine = wanted && bytes(await this.o.fs.promises.readFile(path));
			if (!wanted || !mine || mine.length >= wanted.length || mine.some((byte, i) => byte !== wanted[i])) continue;
			await this.o.fs.promises.writeFile(path, wanted);
			this.o.log(`finished ${filepath}: the app closed while writing it`);
		}
		await this.o.fs.promises.unlink(this.marker);
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

	/** A file's tree entry at `commit`, or null where it doesn't exist. */
	private async entry(commit: string, filepath: string) {
		const slash = filepath.lastIndexOf('/');
		try {
			const { tree } = await git.readTree({ ...this.repo, oid: commit, filepath: slash < 0 ? undefined : filepath.slice(0, slash) });
			return tree.find((e) => e.path === filepath.slice(slash + 1)) ?? null;
		} catch (e) {
			if (e instanceof git.Errors.NotFoundError) return null;
			throw e;
		}
	}

	/**
	 * The commit that brought `tip`'s version of a file, or its deletion, as `git log -1` finds it: from a commit,
	 * follow a parent that has the same version, until none does.
	 */
	private async lastChange(tip: string, filepath: string): Promise<Change> {
		let oid = tip;
		for (;;) {
			const { commit } = await git.readCommit({ ...this.repo, oid });
			const mine = (await this.entry(oid, filepath))?.oid;
			const parents = await Promise.all(commit.parent.map(async (parent) => ({ parent, version: (await this.entry(parent, filepath))?.oid })));
			const same = parents.find(({ version }) => version === mine)?.parent;
			if (!same) return { time: commit.committer.timestamp * 1000, device: device(commit.message, commit.author.name) };
			oid = same;
		}
	}

	/** A throwaway commit on top of `commit`, with `entries` put in (null removes the file). */
	private async withEntries(commit: string, entries: [string, TreeEntry | null][]) {
		let { tree } = (await git.readCommit({ ...this.repo, oid: commit })).commit;
		for (const [path, entry] of entries) tree = (await this.setEntry(tree, path.split('/'), entry)) ?? (await git.writeTree({ ...this.repo, tree: [] }));
		return git.commit({ ...this.repo, message: 'Settle conflicts', tree, parent: [commit], author: this.o.author, noUpdateBranch: true });
	}

	/** A copy of `tree` with `entry` at `path`, or null when that leaves it empty. */
	private async setEntry(tree: string | null, [name = '', ...rest]: string[], entry: TreeEntry | null): Promise<string | null> {
		const entries = tree ? (await git.readTree({ ...this.repo, oid: tree })).tree : [];
		let child = entry && { ...entry, path: name };
		if (rest.length) {
			const sub = await this.setEntry(entries.find((e) => e.path === name && e.type === 'tree')?.oid ?? null, rest, entry);
			child = sub ? { mode: '040000', path: name, oid: sub, type: 'tree' } : null;
		}
		const result = [...entries.filter((e) => e.path !== name), ...(child ? [child] : [])];
		return result.length ? git.writeTree({ ...this.repo, tree: result }) : null;
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
		let result;
		try {
			result = await git.push(this.remote);
		} catch (e) {
			// isomorphic-git checks before sending; its own message suggests "force: true", which loses work.
			if (e instanceof git.Errors.PushRejectedError && e.data.reason === 'not-fast-forward') throw new PushRejected();
			throw e;
		}
		// The server can refuse too, when the other device's push lands between that check and this one.
		if (Object.values(result.refs).some(({ error }) => /fast-forward|fetch first|failed to update ref/.test(error ?? ''))) throw new PushRejected();
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
