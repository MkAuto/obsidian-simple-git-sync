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
