import { debounce, FileSystemAdapter, moment, normalizePath, Notice, Platform, Plugin } from 'obsidian';
import type { Debouncer } from 'obsidian';
import { CloneModal } from './clone-modal';
import { BuiltinGit, NativeGit } from './git';
import type { Engine } from './git';
import { DEFAULT_SETTINGS, SettingTab } from './settings';
import type { Settings } from './settings';
import { ensureFolder, http, vaultFs } from './vault-io';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Offline is routine: stay quiet, the next trigger retries. A held index.lock is not: it may be left over
// from a crashed git, and git's own message says to delete it.
const isQuiet = (e: unknown) =>
	(e as { network?: boolean } | null)?.network === true ||
	/Could not resolve host|Connection (timed out|refused|reset)|Network is unreachable|Temporary failure in name resolution/i.test(errorText(e));

export default class SimpleGitSync extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	/** In memory only, newest last. */
	log: string[] = [];
	hasRepo = false;
	private syncing = false;
	private unloaded = false;
	private queued: boolean | null = null; // push flag of the one sync waiting behind the running one
	private lastSync = 0;
	private statusEl: HTMLElement | null = null;
	private timers: number[] = [];
	private pushSoon: Debouncer<[], void> | null = null;

	async onload() {
		await this.loadSettings();
		this.hasRepo = await this.app.vault.adapter.exists('.git');
		this.addSettingTab(new SettingTab(this));
		this.addCommand({ id: 'pull', name: 'Pull', callback: () => void this.sync(false, 'command') });
		this.addCommand({ id: 'sync', name: 'Sync now', callback: () => void this.sync(true, 'command') });
		this.addRibbonIcon('refresh-cw', 'Sync now', () => void this.sync(true, 'ribbon'));
		this.statusEl = this.addStatusBarItem(); // desktop only: mobile has no status bar
		this.registerInterval(window.setInterval(() => this.showStatus(), 30_000));
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	onunload() {
		// Obsidian drops the intervals and events. A pending idle push, a queued run, or anything a
		// half-finished start() set up would still call sync(): this stops them. A running sync finishes.
		this.unloaded = true;
	}

	private async start() {
		if (!this.hasRepo) {
			this.openClone();
			return;
		}
		await this.ignoreOwnFiles();
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				if (this.settings.pullOnOpen) void this.sync(false, 'return to app');
			} else if (this.pushEnabled && this.settings.pushOnBackground) {
				void this.sync(true, 'app in background');
			}
		});
		// Registered after layout ready, so the vault's startup 'create' flood doesn't count.
		// A pull writes files too; those aren't edits.
		const onEdit = () => {
			if (!this.syncing) this.pushSoon?.();
		};
		this.registerEvent(this.app.vault.on('create', onEdit));
		this.registerEvent(this.app.vault.on('modify', onEdit));
		this.registerEvent(this.app.vault.on('delete', onEdit));
		this.registerEvent(this.app.vault.on('rename', onEdit));
		this.applyTimers();
		if (this.settings.pullOnOpen) await this.sync(false, 'app open');
	}

	async sync(push: boolean, reason: string) {
		if (!this.hasRepo || this.unloaded) return;
		if (this.syncing) {
			this.queued = this.queued === true || push;
			return;
		}
		this.syncing = true;
		this.showStatus();
		this.addLog(`sync: ${reason}${push ? ', with push' : ''}`);
		try {
			const s = this.settings;
			const git = this.engine();
			await git.commitAll(`Sync: ${s.deviceName} ${moment().format('YYYY-MM-DD HH:mm')}`);
			await git.fetch();
			if (s.discard) {
				await this.toTrash(await git.localChanges());
				await git.resetToRemote();
			} else {
				await git.merge((paths) => this.toTrash(paths));
				if (push) await git.push();
			}
			this.lastSync = Date.now();
		} catch (e) {
			this.addLog(`error: ${errorText(e)}`);
			if (!isQuiet(e)) new Notice(`Simple Git Sync: ${errorText(e)}`);
		} finally {
			this.syncing = false;
			this.showStatus();
			const next = this.queued;
			this.queued = null;
			if (next !== null) void this.sync(next, 'queued');
		}
	}

	get usesBuiltin() {
		return !Platform.isDesktop || this.settings.engine === 'builtin';
	}

	private get pushEnabled() {
		return this.settings.pushMode !== 'off' && !this.settings.discard;
	}

	private native() {
		if (!Platform.isDesktop) return null;
		const { adapter } = this.app.vault;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		// Required here, not imported: mobile has no Node modules, and Obsidian's renderer can't import() them.
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- desktop-only require, see above
		const { execFile } = require('child_process') as typeof import('child_process');
		return new NativeGit(adapter.getBasePath(), execFile, (text) => this.addLog(text));
	}

	private engine(): Engine {
		const s = this.settings;
		return (
			(this.usesBuiltin ? null : this.native()) ??
			new BuiltinGit({
				fs: vaultFs(this.app),
				dir: '/',
				http,
				token: this.token(),
				author: { name: s.authorName, email: s.authorEmail },
				log: (text) => this.addLog(text),
			})
		);
	}

	token() {
		return (this.settings.token && this.app.secretStorage.getSecret(this.settings.token)) || '';
	}

	/** Desktop switching to built-in: start from what the native setup already knows. */
	async prefillBuiltin() {
		const native = this.native();
		if (!native) return;
		const s = this.settings;
		s.url ||= (await native.config('remote.origin.url')).replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$1/');
		s.authorName ||= await native.config('user.name');
		s.authorEmail ||= await native.config('user.email');
	}

	addLog(text: string) {
		const token = this.token();
		const time = moment().format('HH:mm:ss');
		for (let line of text.split('\n')) {
			if (token) line = line.split(token).join('***');
			this.log.push(`${time} ${line.replace(/\/\/[^/\s@]+@/g, '//***@')}`);
		}
		this.log.splice(0, this.log.length - 1000);
	}

	/** Copies the local version of files about to be overwritten. */
	async toTrash(paths: string[]) {
		const { adapter } = this.app.vault;
		const folder = `.trash/simple-git-sync/${moment().format('YYYY-MM-DD_HH-mm-ss')}`;
		for (const path of paths) {
			if (!(await adapter.exists(path))) continue;
			const copy = normalizePath(`${folder}/${path}`);
			await ensureFolder(this.app.vault, copy.slice(0, copy.lastIndexOf('/')));
			await adapter.writeBinary(copy, await adapter.readBinary(path));
			this.addLog(`copied ${path} to ${copy}`);
		}
	}

	/**
	 * Settings and the open-tabs layout stay per-device (the layout changes on every click, and would bounce
	 * between devices); trash (backups, and files a pull deleted) stays local.
	 */
	private async ignoreOwnFiles() {
		const { adapter, configDir } = this.app.vault;
		const data = `${this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`}/data.json`;
		const ignore = (await adapter.exists('.gitignore')) ? await adapter.read('.gitignore') : '';
		const lines = ignore.split(/\r?\n/);
		const missing = [data, `${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`, '.trash/'].filter(
			(line) => !lines.includes(line) && !lines.includes(line.replace(/\/$/, '')),
		);
		if (!missing.length) return;
		await adapter.write('.gitignore', `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
		const git = this.engine();
		for (const path of missing.filter((line) => !line.endsWith('/'))) {
			try {
				await git.untrack(path);
			} catch (e) {
				this.addLog(`untrack ${path} failed: ${errorText(e)}`);
			}
		}
	}

	applyTimers() {
		for (const id of this.timers) window.clearInterval(id);
		this.timers = [];
		this.pushSoon?.cancel();
		const s = this.settings;
		const every = (minutes: number, push: boolean, reason: string) => {
			if (minutes > 0) this.timers.push(this.registerInterval(window.setInterval(() => void this.sync(push, reason), minutes * 60_000)));
		};
		every(s.pullInterval, false, 'pull timer');
		if (this.pushEnabled && s.pushMode === 'interval') every(s.pushInterval, true, 'push timer');
		this.pushSoon = this.pushEnabled && s.pushMode === 'idle' ? debounce(() => void this.sync(true, 'stopped editing'), s.pushIdle * 1000, true) : null;
	}

	private showStatus() {
		this.statusEl?.setText(this.syncing ? 'Syncing…' : this.lastSync ? `Synced ${moment(this.lastSync).fromNow()}` : '');
	}

	openClone() {
		new CloneModal(this).open();
	}

	reloadApp() {
		// Not in the public API: it's the "Reload app without saving" command.
		(this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById('app:reload');
	}

	async loadSettings() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<Settings> | null) };
		if (this.settings.deviceName) return;
		if (Platform.isDesktop) {
			// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- desktop-only, like native()
			this.settings.deviceName = (require('os') as typeof import('os')).hostname();
		} else {
			this.settings.deviceName = 'Mobile';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyTimers();
	}
}
