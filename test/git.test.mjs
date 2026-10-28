// The paths that can lose data: conflict merges (newest wins, or the remote), the .trash hand-off, and discard.
// Run with `npm test` (Node strips the types from src/git.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltinGit, NativeGit, PushRejected, clone as cloneVault, CLONING } from '../src/git.ts';
import { execFile } from 'node:child_process';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const read = (dir, file) => (fs.existsSync(join(dir, file)) ? fs.readFileSync(join(dir, file), 'utf8') : null);
const write = (dir, file, text) => fs.writeFileSync(join(dir, file), text);
const BASE = 'one\ntwo\nthree\nfour\nfive\n';
const author = { name: 'Test', email: 'test@example.com' };

function clone(remote, dir) {
	sh(join(remote, '..'), 'clone', '-q', '-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', remote, dir);
}

// A bare "GitHub" with note.md, gone.md, other.md and img.bin, and two clones: a (other device) and b (this one).
function setup() {
	const root = fs.mkdtempSync(join(tmpdir(), 'sgs-'));
	const remote = join(root, 'remote.git');
	const a = join(root, 'a');
	const b = join(root, 'b');
	sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
	clone(remote, a);
	sh(a, 'checkout', '-q', '-b', 'main');
	write(a, 'note.md', BASE);
	write(a, 'gone.md', 'keep me?\n');
	write(a, 'other.md', 'other\n');
	fs.mkdirSync(join(a, 'dir/sub'), { recursive: true });
	write(a, 'dir/sub/deep.md', BASE);
	fs.writeFileSync(join(a, 'img.bin'), Buffer.from([0, 1, 2]));
	sh(a, 'add', '-A');
	sh(a, 'commit', '-qm', 'base');
	sh(a, 'push', '-q', '-u', 'origin', 'main');
	clone(remote, b);
	// isomorphic-git trusts same-second, same-size stats. The plugin's vaultFs guards against that;
	// plain Node fs doesn't, so let a second pass before b edits what the clone just wrote.
	execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1100)']);
	return { a, b, remote };
}

// Node's fs, except that writing a file named `name` fails until heal(): the app killed partway through.
function failingWrites(name) {
	let failing = true;
	const writeFile = async (path, ...rest) => {
		if (failing && String(path).endsWith(name)) throw new Error('write failed');
		return fs.promises.writeFile(path, ...rest);
	};
	return { fs: { promises: { ...fs.promises, writeFile } }, heal: () => (failing = false) };
}

// isomorphic-git only talks HTTP: answer it with git's own upload-pack and receive-pack, as a git server would.
const serve = (remote) => ({
	async request({ url, body }) {
		const chunks = [];
		for await (const chunk of body ?? []) chunks.push(chunk);
		const service = /git-(upload|receive)-pack/.exec(url)[0];
		const refs = url.includes('?service=');
		const line = `# service=${service}\n`;
		const out = refs
			? Buffer.concat([Buffer.from(`${(line.length + 4).toString(16).padStart(4, '0')}${line}0000`), execFileSync('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', remote])])
			: execFileSync('git', [service.slice(4), '--stateless-rpc', remote], { input: Buffer.concat(chunks) });
		const type = refs ? 'advertisement' : 'result';
		return { url, method: refs ? 'GET' : 'POST', statusCode: 200, statusMessage: 'OK', headers: { 'content-type': `application/x-${service}-${type}` }, body: [out] };
	},
});

// Device a pushes; device b edits the same spots without committing.
function diverge(a, b) {
	write(a, 'note.md', BASE.replace('two', 'two-A'));
	fs.rmSync(join(a, 'gone.md'));
	fs.writeFileSync(join(a, 'img.bin'), Buffer.from([0, 9, 9]));
	sh(a, 'commit', '-qam', 'from a');
	sh(a, 'push', '-q');
	write(b, 'note.md', BASE.replace('two', 'two-B').replace('five', 'five-B'));
	write(b, 'gone.md', 'edited on b\n');
	fs.writeFileSync(join(b, 'img.bin'), Buffer.from([0, 7, 7]));
	write(b, 'new.md', 'only on b\n');
}

// Both devices commit, at the given times: every conflict kind, and lines only one side changed.
function divergeAt(a, aTime, b, bTime) {
	const commitAt = (dir, time, message) => {
		sh(dir, 'add', '-A');
		execFileSync('git', ['commit', '-qm', message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: time, GIT_COMMITTER_DATE: time } });
	};
	write(a, 'note.md', BASE.replace('two', 'two-A').replace('five', 'five-A'));
	fs.rmSync(join(a, 'gone.md'));
	write(a, 'other.md', 'other, edited on a\n');
	write(a, 'dir/sub/deep.md', BASE.replace('two', 'two-A'));
	fs.writeFileSync(join(a, 'img.bin'), Buffer.from([0, 9, 9]));
	commitAt(a, aTime, 'Sync: Phone 2026-01-01 10:00');
	sh(a, 'push', '-q');
	write(b, 'note.md', BASE.replace('two', 'two-B'));
	write(b, 'gone.md', 'edited on b\n');
	fs.rmSync(join(b, 'other.md'));
	write(b, 'dir/sub/deep.md', BASE.replace('two', 'two-B'));
	fs.writeFileSync(join(b, 'img.bin'), Buffer.from([0, 7, 7]));
	write(b, 'new.md', 'only on b\n');
	commitAt(b, bTime, 'Sync: Laptop 2026-01-01 11:00');
}

const text = (data) => (data ? Buffer.from(data).toString() : null);
const parents = (dir) => sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1);

const engines = {
	native: (dir) => new NativeGit(dir, execFile, process.env, () => {}),
	builtin: (dir) => new BuiltinGit({ fs, dir, http: null, token: '', author, log: () => {} }),
};
// isomorphic-git can't fetch from a local path, so the built-in engine gets the remote ref copied in.
const fetch = (name, engine, dir) => (name === 'native' ? engine.fetch() : sh(dir, 'fetch', '-q'));

for (const [name, make] of Object.entries(engines)) {
	test(`${name}: without newest wins, the remote wins on overlaps, local edits elsewhere survive, losers are handed over first`, async () => {
		const { a, b } = setup();
		diverge(a, b);
		const git = make(b);
		const handedOver = {};

		await git.commitAll('local'); // the newer side: it still loses
		await fetch(name, git, b);
		await git.merge(false, async (conflicts) => {
			for (const { path, kept, lost } of conflicts) {
				assert.equal(kept, 'remote');
				// Nothing written yet: the file on disk is still this device's version, the one that lost.
				assert.equal(read(b, path), path === 'img.bin' ? read(b, path) : text(lost));
				handedOver[path] = path === 'img.bin' ? [...lost] : text(lost);
			}
		});

		assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A').replace('five', 'five-B'));
		assert.equal(read(b, 'gone.md'), null);
		assert.deepEqual([...fs.readFileSync(join(b, 'img.bin'))], [0, 9, 9]);
		assert.equal(read(b, 'new.md'), 'only on b\n');
		// The callback got b's own versions, the ones that lost.
		assert.deepEqual(Object.keys(handedOver).sort(), ['gone.md', 'img.bin', 'note.md']);
		assert.equal(handedOver['note.md'], BASE.replace('two', 'two-B').replace('five', 'five-B'));
		assert.equal(handedOver['gone.md'], 'edited on b\n');
		assert.deepEqual(handedOver['img.bin'], [0, 7, 7]);
		assert.equal(sh(b, 'status', '--porcelain'), '');
	});

	test(`${name}: newest wins: a later edit here beats an earlier one there, the remote's losers are handed over`, async () => {
		const { a, b } = setup();
		divergeAt(a, '2026-01-01T10:00:00', b, '2026-01-01T11:00:00');
		const git = make(b);
		const local = sh(b, 'rev-parse', 'HEAD').trim();
		await fetch(name, git, b);
		const conflicts = await git.merge(true, async () => {});

		assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-B').replace('five', 'five-A')); // five: only a changed it
		assert.equal(read(b, 'gone.md'), 'edited on b\n'); // the edit is newer than a's delete
		assert.equal(read(b, 'other.md'), null); // the delete is newer than a's edit
		assert.deepEqual([...fs.readFileSync(join(b, 'img.bin'))], [0, 7, 7]);
		assert.equal(read(b, 'new.md'), 'only on b\n');
		assert.equal(read(b, 'dir/sub/deep.md'), BASE.replace('two', 'two-B')); // in a folder too
		const byPath = Object.fromEntries(conflicts.map((c) => [c.path, c]));
		assert.deepEqual(Object.keys(byPath).sort(), ['dir/sub/deep.md', 'gone.md', 'img.bin', 'note.md', 'other.md']);
		assert.equal(text(byPath['dir/sub/deep.md'].lost), BASE.replace('two', 'two-A'));
		for (const c of conflicts) assert.equal(c.kept, 'local');
		assert.equal(text(byPath['note.md'].lost), BASE.replace('two', 'two-A').replace('five', 'five-A'));
		assert.equal(byPath['gone.md'].lost, null); // a deleted it
		assert.equal(text(byPath['other.md'].lost), 'other, edited on a\n');
		assert.deepEqual([...byPath['img.bin'].lost], [0, 9, 9]);
		assert.deepEqual(byPath['note.md'].remote, { time: Date.parse('2026-01-01T10:00:00'), device: 'Phone' });
		assert.deepEqual(byPath['note.md'].local, { time: Date.parse('2026-01-01T11:00:00'), device: 'Laptop' });
		// A real merge of both sides, committed, nothing left over.
		assert.deepEqual(parents(b), [local, sh(b, 'rev-parse', 'origin/main').trim()]);
		assert.equal(sh(b, 'status', '--porcelain'), '');
		assert.doesNotMatch(sh(b, 'log', '--format=%s'), /Settle conflicts|Take remote side/);
	});

	test(`${name}: a push refused because another device pushed first says so, and never suggests forcing`, async () => {
		const { a, b, remote } = setup();
		const git = name === 'native' ? make(b) : new BuiltinGit({ fs, dir: b, http: serve(remote), token: '', author, log: () => {} });
		if (name === 'builtin') sh(b, 'remote', 'set-url', 'origin', 'https://example.com/remote.git');
		write(b, 'note.md', BASE.replace('one', 'one-B'));
		await git.commitAll('local');
		// Between this device's merge and its push, the other one pushes.
		write(a, 'note.md', BASE.replace('five', 'five-A'));
		sh(a, 'commit', '-qam', 'from a');
		sh(a, 'push', '-q');

		const error = await git.push().then(() => null, (e) => e);
		assert.ok(error instanceof PushRejected, `got ${error}`);
		assert.doesNotMatch(error.message, /force/i);
		// Merging again lets the next push through, with both devices' work.
		await git.fetch();
		await git.merge(true, async () => {});
		await git.push();
		sh(a, 'pull', '-q');
		assert.equal(read(a, 'note.md'), BASE.replace('one', 'one-B').replace('five', 'five-A'));
	});

	for (const [when, aTime] of [['an earlier', '2026-01-01T12:00:00'], ['an equally old', '2026-01-01T11:00:00']]) {
		test(`${name}: newest wins: ${when} edit here loses to the remote, this device's losers are handed over`, async () => {
			const { a, b } = setup();
			divergeAt(a, aTime, b, '2026-01-01T11:00:00');
			const git = make(b);
			await fetch(name, git, b);
			const conflicts = await git.merge(true, async () => {});

			assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A').replace('five', 'five-A'));
			assert.equal(read(b, 'gone.md'), null);
			assert.equal(read(b, 'other.md'), 'other, edited on a\n');
			assert.deepEqual([...fs.readFileSync(join(b, 'img.bin'))], [0, 9, 9]);
			assert.equal(read(b, 'new.md'), 'only on b\n');
			assert.equal(read(b, 'dir/sub/deep.md'), BASE.replace('two', 'two-A'));
			const byPath = Object.fromEntries(conflicts.map((c) => [c.path, c]));
			for (const c of conflicts) assert.equal(c.kept, 'remote');
			assert.equal(text(byPath['dir/sub/deep.md'].lost), BASE.replace('two', 'two-B'));
			assert.equal(text(byPath['note.md'].lost), BASE.replace('two', 'two-B'));
			assert.equal(text(byPath['gone.md'].lost), 'edited on b\n');
			assert.equal(byPath['other.md'].lost, null); // b deleted it
			assert.deepEqual([...byPath['img.bin'].lost], [0, 7, 7]);
			assert.equal(sh(b, 'status', '--porcelain'), '');
		});
	}

	test(`${name}: discard lists local changes, then resets to the remote`, async () => {
		const { a, b } = setup();
		diverge(a, b);
		const git = make(b);

		await git.commitAll('local');
		await fetch(name, git, b);
		assert.deepEqual((await git.localChanges()).sort(), ['gone.md', 'img.bin', 'new.md', 'note.md']);
		await git.resetToRemote();

		assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A'));
		assert.equal(read(b, 'gone.md'), null);
		assert.equal(read(b, 'new.md'), null);
		assert.equal(sh(b, 'rev-parse', 'HEAD'), sh(b, 'rev-parse', 'origin/main'));
	});
}

test('builtin: a merge whose file update dies halfway leaves nothing for the next sync to revert', async () => {
	const { a, b } = setup();
	write(a, 'note.md', BASE.replace('two', 'two-A'));
	fs.writeFileSync(join(a, 'img.bin'), Buffer.from([0, 9, 9]));
	sh(a, 'commit', '-qam', 'from a');
	sh(a, 'push', '-q');
	sh(b, 'fetch', '-q');
	const flaky = failingWrites('note.md');
	const git = new BuiltinGit({ fs: flaky.fs, dir: b, http: null, token: '', author, log: () => {} });
	await assert.rejects(git.merge(true, async () => {}));
	flaky.heal();

	await git.commitAll('next sync');
	await git.merge(true, async () => {});

	assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A'));
	assert.equal(sh(b, 'diff', '--stat', 'origin/main', 'HEAD'), '');
	assert.equal(sh(b, 'status', '--porcelain'), '');
});

test('builtin: a fetch after a local commit downloads only what is new, not the whole repo', async () => {
	const { a, b, remote } = setup();
	fs.writeFileSync(join(a, 'big.bin'), randomBytes(1_000_000));
	sh(a, 'add', '-A');
	sh(a, 'commit', '-qm', 'big');
	sh(a, 'push', '-q');
	sh(b, 'pull', '-q');
	sh(b, 'remote', 'set-url', 'origin', 'https://example.com/remote.git'); // isomorphic-git only fetches over HTTP
	write(a, 'note.md', BASE.replace('one', 'one-A'));
	sh(a, 'commit', '-qam', 'small');
	sh(a, 'push', '-q');
	write(b, 'other.md', 'edited on b\n');
	const server = serve(remote);
	let received = 0;
	const http = {
		async request(req) {
			const res = await server.request(req);
			for (const chunk of res.body) received += chunk.length;
			return res;
		},
	};
	const git = new BuiltinGit({ fs, dir: b, http, token: '', author, log: () => {} });

	await git.commitAll('local'); // a sync commits before it fetches: a commit the server has never seen
	await git.fetch();

	assert.equal(sh(b, 'rev-parse', 'origin/main'), sh(a, 'rev-parse', 'HEAD'));
	assert.ok(received < 100_000, `downloaded ${received} bytes for a one-line change`);
});

test('builtin: a file cut short by an update the app died in is finished, never taken for a newer local edit', async () => {
	const { a, b } = setup();
	write(a, 'note.md', BASE.replace('two', 'two-A'));
	sh(a, 'commit', '-qam', 'from a');
	sh(a, 'push', '-q');
	sh(b, 'fetch', '-q');
	// The app dies while note.md is being written: only its start is on disk.
	let dying = true;
	const writeFile = async (path, data, ...rest) => {
		if (dying && String(path).endsWith('note.md')) {
			await fs.promises.writeFile(path, data.slice(0, 5));
			throw new Error('app killed');
		}
		return fs.promises.writeFile(path, data, ...rest);
	};
	const git = new BuiltinGit({ fs: { promises: { ...fs.promises, writeFile } }, dir: b, http: null, token: '', author, log: () => {} });
	await assert.rejects(git.merge(true, async () => {}));
	assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A').slice(0, 5));
	dying = false;

	// The next sync, a minute later: its commit would be newer than a's.
	await git.commitAll('next sync');
	const conflicts = await git.merge(true, async () => {});

	assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A'));
	assert.deepEqual(conflicts, []);
	assert.equal(sh(b, 'diff', '--stat', 'origin/main', 'HEAD'), '');
});

test('builtin: a clone that dies halfway leaves no .git, and the next attempt works', async () => {
	const { remote } = setup();
	const vault = fs.mkdtempSync(join(tmpdir(), 'sgs-vault-'));
	const url = 'https://example.com/remote.git';

	await assert.rejects(cloneVault(failingWrites('note.md').fs, vault, serve(remote), url, '', 'main', async () => {}));
	// No .git: the plugin offers the clone again, instead of syncing a repo whose files are missing.
	assert.equal(fs.existsSync(join(vault, '.git')), false);

	fs.rmSync(join(vault, CLONING), { recursive: true }); // what the clone dialog does first
	await cloneVault(fs, vault, serve(remote), url, '', 'main', async () => {});
	assert.equal(read(vault, 'note.md'), BASE);
	assert.equal(fs.existsSync(join(vault, CLONING)), false);
	assert.equal(sh(vault, 'status', '--porcelain'), '');
});

test('builtin: a clone hands over the local files it replaces, and only those', async () => {
	const { remote } = setup();
	const vault = fs.mkdtempSync(join(tmpdir(), 'sgs-vault-'));
	write(vault, 'note.md', 'written before the clone\n'); // differs from the repo
	write(vault, 'gone.md', 'keep me?\n'); // same as the repo
	write(vault, 'extra.md', 'not in the repo\n');
	const handedOver = {};

	await cloneVault(fs, vault, serve(remote), 'https://example.com/remote.git', '', 'main', async (paths) => {
		for (const path of paths) handedOver[path] = read(vault, path);
	});

	assert.deepEqual(handedOver, { 'note.md': 'written before the clone\n' });
	assert.equal(read(vault, 'note.md'), BASE);
	assert.equal(read(vault, 'extra.md'), 'not in the repo\n');
});

test('native: a broken .git is an error, never a reason to use a repo further up', async () => {
	const outer = fs.mkdtempSync(join(tmpdir(), 'sgs-outer-'));
	sh(outer, 'init', '-q');
	const vault = join(outer, 'vault');
	fs.mkdirSync(join(vault, '.git'), { recursive: true }); // empty, as a failed clone left it
	write(vault, 'note.md', BASE);

	await assert.rejects(engines.native(vault).commitAll('local'));
	assert.equal(sh(outer, 'status', '--porcelain'), '?? vault/\n');
});

test('native: commitAll with nothing to commit, then push after a merge', async () => {
	const { a, b } = setup();
	const git = engines.native(b);
	assert.equal(await git.commitAll('nothing'), false);

	write(a, 'note.md', BASE.replace('one', 'one-A'));
	sh(a, 'commit', '-qam', 'from a');
	sh(a, 'push', '-q');
	write(b, 'note.md', BASE.replace('five', 'five-B'));
	assert.equal(await git.commitAll('local'), true);
	await git.fetch();
	await git.merge(true, async () => {});
	await git.push();

	sh(a, 'pull', '-q');
	assert.equal(read(a, 'note.md'), BASE.replace('one', 'one-A').replace('five', 'five-B'));
});
