// The paths that can lose data: remote-wins merges, the .trash hand-off, and discard.
// Run with `npm test` (Node strips the types from src/git.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltinGit, NativeGit, clone as cloneVault, CLONING } from '../src/git.ts';
import { execFile } from 'node:child_process';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const read = (dir, file) => (fs.existsSync(join(dir, file)) ? fs.readFileSync(join(dir, file), 'utf8') : null);
const write = (dir, file, text) => fs.writeFileSync(join(dir, file), text);
const BASE = 'one\ntwo\nthree\nfour\nfive\n';
const author = { name: 'Test', email: 'test@example.com' };

function clone(remote, dir) {
	sh(join(remote, '..'), 'clone', '-q', '-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', remote, dir);
}

// A bare "GitHub" with note.md, gone.md and img.bin, and two clones: a (other device) and b (this one).
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

// isomorphic-git only clones over HTTP: answer it with git's own upload-pack, as a git server would.
const serve = (remote) => ({
	async request({ url, body }) {
		const chunks = [];
		for await (const chunk of body ?? []) chunks.push(chunk);
		const refs = url.endsWith('?service=git-upload-pack');
		const out = refs
			? Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', remote])])
			: execFileSync('git', ['upload-pack', '--stateless-rpc', remote], { input: Buffer.concat(chunks) });
		const type = refs ? 'advertisement' : 'result';
		return { url, method: refs ? 'GET' : 'POST', statusCode: 200, statusMessage: 'OK', headers: { 'content-type': `application/x-git-upload-pack-${type}` }, body: [out] };
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

const engines = {
	native: (dir) => new NativeGit(dir, execFile, () => {}),
	builtin: (dir) => new BuiltinGit({ fs, dir, http: null, token: '', author, log: () => {} }),
};
// isomorphic-git can't fetch from a local path, so the built-in engine gets the remote ref copied in.
const fetch = (name, engine, dir) => (name === 'native' ? engine.fetch() : sh(dir, 'fetch', '-q'));

for (const [name, make] of Object.entries(engines)) {
	test(`${name}: remote wins on overlaps, local edits elsewhere survive, overwritten files are handed over first`, async () => {
		const { a, b } = setup();
		diverge(a, b);
		const git = make(b);
		const handedOver = {};

		await git.commitAll('local');
		await fetch(name, git, b);
		await git.merge(async (paths) => {
			for (const path of paths) handedOver[path] = read(b, path);
		});

		assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A').replace('five', 'five-B'));
		assert.equal(read(b, 'gone.md'), null);
		assert.deepEqual([...fs.readFileSync(join(b, 'img.bin'))], [0, 9, 9]);
		assert.equal(read(b, 'new.md'), 'only on b\n');
		// The callback saw b's own versions, before the remote replaced them.
		assert.deepEqual(Object.keys(handedOver).sort(), ['gone.md', 'img.bin', 'note.md']);
		assert.equal(handedOver['note.md'], BASE.replace('two', 'two-B').replace('five', 'five-B'));
		assert.equal(handedOver['gone.md'], 'edited on b\n');
		assert.equal(sh(b, 'status', '--porcelain'), '');
	});

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
	await assert.rejects(git.merge(async () => {}));
	flaky.heal();

	await git.commitAll('next sync');
	await git.merge(async () => {});

	assert.equal(read(b, 'note.md'), BASE.replace('two', 'two-A'));
	assert.equal(sh(b, 'diff', '--stat', 'origin/main', 'HEAD'), '');
	assert.equal(sh(b, 'status', '--porcelain'), '');
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
	await git.merge(async () => {});
	await git.push();

	sh(a, 'pull', '-q');
	assert.equal(read(a, 'note.md'), BASE.replace('one', 'one-A').replace('five', 'five-B'));
});
