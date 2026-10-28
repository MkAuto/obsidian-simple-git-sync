// vault-io against a fake vault. 'obsidian' only exists inside the app, so it's stubbed with what vault-io imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const stub = String.raw`
export const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';
export class TFile {}
export class TFolder {}
export const requestUrl = () => {};
`;
registerHooks({
	resolve: (specifier, context, next) =>
		specifier === 'obsidian' ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : next(specifier, context),
});
const { ensureFolder } = await import('../src/vault-io.ts');

test('ensureFolder creates the folder and its missing parents, nothing else', async () => {
	const folders = new Set(['a']);
	const created = [];
	const make = async (path) => {
		folders.add(path);
		created.push(path);
	};
	const vault = { adapter: { exists: async (path) => folders.has(path), mkdir: make }, createFolder: make };

	await ensureFolder(vault, '.git-cloning');
	await ensureFolder(vault, 'a/b/c');
	await ensureFolder(vault, 'Projects');

	// Not '.g', '.gi', '.git', … or 'P', 'Pr', …: a top-level name used to lose a letter per step.
	assert.deepEqual(created, ['.git-cloning', 'a/b', 'a/b/c', 'Projects']);
});

test('ensureFolder copes with calls racing to create the same parent, as isomorphic-git makes them', async () => {
	// Like Obsidian: every call takes a moment, and creating a folder that exists throws.
	const folders = new Set();
	const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
	const make = async (path) => {
		await tick();
		if (folders.has(path)) throw new Error('Folder already exists.');
		folders.add(path);
	};
	const vault = { adapter: { exists: async (path) => (await tick(), folders.has(path)), mkdir: make }, createFolder: make };

	// A pull bringing Projets/Été 2026/Résumés/note.md: checkout makes all three folders at once.
	await Promise.all(['Projets', 'Projets/Été 2026', 'Projets/Été 2026/Résumés'].map((path) => ensureFolder(vault, path)));
	await Promise.all(['.obsidian/plugins', '.obsidian/plugins/x'].map((path) => ensureFolder(vault, path)));

	assert.deepEqual([...folders].sort(), ['.obsidian', '.obsidian/plugins', '.obsidian/plugins/x', 'Projets', 'Projets/Été 2026', 'Projets/Été 2026/Résumés']);
});

test('ensureFolder still fails when the folder really could not be made', async () => {
	const vault = { adapter: { exists: async () => false, mkdir: async () => {} }, createFolder: async () => Promise.reject(new Error('disk full')) };
	await assert.rejects(ensureFolder(vault, 'Notes'), /disk full/);
});
