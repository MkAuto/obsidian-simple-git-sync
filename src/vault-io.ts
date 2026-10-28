import { normalizePath, requestUrl, TFile, TFolder } from 'obsidian';
import type { App, Vault } from 'obsidian';
import type { HttpClient } from 'isomorphic-git';
import type { Fs } from './git';

const fsError = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

// Obsidian doesn't index hidden paths (.git, .obsidian, dotfiles), so those go through the raw adapter.
const isHidden = (path: string) => path.split('/').some((part) => part.startsWith('.') && part !== '.');

/** Creates a folder and any missing parents. */
export async function ensureFolder(vault: Vault, path: string) {
	path = normalizePath(path);
	if (path === '/' || (await vault.adapter.exists(path))) return;
	const slash = path.lastIndexOf('/');
	if (slash > 0) await ensureFolder(vault, path.slice(0, slash));
	try {
		if (isHidden(path)) await vault.adapter.mkdir(path);
		else await vault.createFolder(path);
	} catch (e) {
		// isomorphic-git makes a checkout's folders all at once, so another call may have made this one since
		// the check above, and Obsidian refuses to create a folder twice.
		if (!(await vault.adapter.exists(path))) throw e;
	}
}

/**
 * isomorphic-git's file system on top of the vault, with the repo at dir '/'.
 * Notes are written through the Vault API so open editors and the file list see pulled changes.
 * Deletions follow the user's trash preference; .trash/ is gitignored so they never get committed.
 */
export function vaultFs(app: App): Fs {
	const { vault, fileManager } = app;
	const { adapter } = vault;

	const stat = async (raw: string) => {
		const path = normalizePath(raw);
		const s = await adapter.stat(path);
		if (!s) throw fsError('ENOENT', path);
		const dir = s.type === 'folder';
		// isomorphic-git reuses a cached hash when size and mtime *seconds* match, so a same-size edit saved
		// in the same second as a pull would go unseen and be overwritten later. gid carries the milliseconds
		// to catch that (uid/gid are compared on every platform). The other ids are fixed: missing ones
		// become NaN and the cache would never hit.
		return {
			mode: dir ? 0o40000 : 0o100644,
			size: s.size,
			mtimeMs: s.mtime,
			ctimeMs: s.ctime,
			uid: 0,
			gid: Math.floor(s.mtime) % 1000,
			ino: 0,
			dev: 0,
			isFile: () => !dir,
			isDirectory: () => dir,
			isSymbolicLink: () => false,
		};
	};

	return {
		promises: {
			async readFile(raw: string, options?: string | { encoding?: string }) {
				const path = normalizePath(raw);
				if (!(await adapter.exists(path))) throw fsError('ENOENT', path);
				const encoding = typeof options === 'string' ? options : options?.encoding;
				return encoding ? adapter.read(path) : new Uint8Array(await adapter.readBinary(path));
			},
			async writeFile(raw: string, data: string | Uint8Array) {
				const path = normalizePath(raw);
				const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
				const buffer = bytes.slice().buffer; // Obsidian wants a standalone ArrayBuffer
				const file = vault.getAbstractFileByPath(path);
				if (file instanceof TFile) await vault.modifyBinary(file, buffer);
				else if (isHidden(path)) await adapter.writeBinary(path, buffer);
				else await vault.createBinary(path, buffer);
			},
			async unlink(raw: string) {
				const path = normalizePath(raw);
				if (!(await adapter.exists(path))) throw fsError('ENOENT', path);
				const file = vault.getAbstractFileByPath(path);
				if (file instanceof TFile) await fileManager.trashFile(file);
				else await adapter.remove(path);
			},
			async rename(from: string, to: string) {
				await adapter.rename(normalizePath(from), normalizePath(to));
			},
			async readdir(raw: string) {
				const { files, folders } = await adapter.list(normalizePath(raw));
				return [...files, ...folders].map((path) => path.slice(path.lastIndexOf('/') + 1));
			},
			async mkdir(raw: string) {
				await ensureFolder(vault, raw);
			},
			async rmdir(raw: string) {
				const path = normalizePath(raw);
				if (!(await adapter.exists(path))) throw fsError('ENOENT', path);
				const { files, folders } = await adapter.list(path);
				// isomorphic-git tidies folders it emptied and expects ENOTEMPTY for the rest.
				if (files.length || folders.length) throw fsError('ENOTEMPTY', path);
				const folder = vault.getAbstractFileByPath(path);
				if (folder instanceof TFolder) await fileManager.trashFile(folder);
				else await adapter.rmdir(path, false);
			},
			stat,
			lstat: stat,
			readlink: () => Promise.reject(new Error('symlinks are not supported')),
			symlink: () => Promise.reject(new Error('symlinks are not supported')),
		},
	};
}

/** isomorphic-git's HTTP client on Obsidian's requestUrl, which isn't bound by CORS on mobile. */
export const http: HttpClient = {
	async request({ url, method, headers, body }) {
		const chunks: Uint8Array[] = [];
		if (body) for await (const chunk of body) chunks.push(chunk);
		let res;
		try {
			res = await requestUrl({
				url,
				method,
				// The packfile parser needs raw bytes; a gzipped body would be stored corrupted.
				headers: { ...headers, 'Accept-Encoding': 'identity' },
				body: body ? await new Blob(chunks as BlobPart[]).arrayBuffer() : undefined,
				throw: false,
			});
		} catch (e) {
			// Offline: flagged so the sync stays quiet and retries on the next trigger.
			throw Object.assign(new Error(`Network error: ${e instanceof Error ? e.message : String(e)}`), { network: true });
		}
		const data = new Uint8Array(res.arrayBuffer);
		return {
			url,
			method,
			statusCode: res.status,
			statusMessage: String(res.status),
			headers: res.headers,
			body: (async function* () {
				yield data;
			})(),
		};
	},
};
