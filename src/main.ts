import { debounce, FileSystemAdapter, MarkdownView, normalizePath, Notice, Platform, Plugin } from 'obsidian';
import type { Debouncer } from 'obsidian';
import { CloneModal } from './clone-modal';
import { ConflictModal } from './conflict-modal';
import { BuiltinGit, NativeGit, PushRejected } from './git';
import type { Conflict, Engine, Env, ExecFile } from './git';
import { DEFAULT_SETTINGS, SettingTab } from './settings';
import type { Settings } from './settings';
import { ago, format } from './time';
import { ensureFolder, http, vaultFs } from './vault-io';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Offline is routine: stay quiet, the next trigger retries. A held index.lock is not: it may be left over
// from a crashed git, and git's own message says to delete it.
const isQuiet = (e: unknown) =>
	(e as { network?: boolean } | null)?.network === true ||
	/Could not resolve host|Connection (timed out|refused|reset)|Network is unreachable|Temporary failure in name resolution/i.test(errorText(e));

// To the millisecond: two syncs in the same second mustn't share a folder and overwrite each other's copies.
const backupFolder = () => `.trash/simple-git-sync/${format(Date.now(), 'YYYY-MM-DD_HH-mm-ss-SSS')}`;

/** Node's modules, as far as this file uses them. Typed by hand, like ExecFile in git.ts. */
interface NodeModules {
	child_process: { execFile: ExecFile };
	os: { hostname(): string };
	process: { env: Env };
}

// Desktop only. Required when needed, not imported: mobile has no Node modules, and Obsidian's renderer can't import() them.
const node = <K extends keyof NodeModules>(id: K) => (window as unknown as { require(id: K): NodeModules[K] }).require(id);

export default class SimpleGitSync extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	/** In memory only, newest last. */
	log: string[] = [];
	hasRepo = false;
	/** Files syncs settled for one side, one entry per file, until settled in the conflicts window. In memory only. */
	conflicts = new Map<string, Conflict>();
	private syncing = false;
	private unloaded = false;
	private queued: boolean | null = null; // push flag of the one sync waiting behind the running one
	private lastSync = 0;
	private resetTry = 0; // when the daily-reset timer last started a sync
	private statusEl: HTMLElement | null = null;
	private timers: number[] = [];
	private pushSoon: Debouncer<[], void> | null = null;

	async onload() {
		await this.loadSettings();
		this.hasRepo = await this.app.vault.adapter.exists('.git');
		this.addSettingTab(new SettingTab(this));
		this.addCommand({ id: 'pull', name: 'Pull', callback: () => void this.sync(false, 'command') });
		this.addCommand({ id: 'sync', name: 'Sync now', callback: () => void this.sync(true, 'command') });
		this.addCommand({
			id: 'conflicts',
			name: 'Show sync conflicts',
			checkCallback: (checking) => {
				if (!this.conflicts.size) return false;
				if (!checking) this.openConflicts();
				return true;
			},
		});
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
		push &&= !this.settings.discard; // a discard device never pushes, not even on Sync now
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
			await this.saveEditors();
			const committed = await git.commitAll(`Sync: ${s.deviceName} ${format(Date.now(), 'YYYY-MM-DD HH:mm')}`);
			await git.fetch();
			if (s.discard && this.resetDue) {
				await this.toTrash(await git.localChanges());
				await git.resetToRemote();
				s.lastReset = Date.now();
				await this.saveData(s);
			} else {
				// Another device can push between this merge and this push. Then merge what it pushed and try again.
				for (let attempt = 1; ; attempt++) {
					const conflicts = await git.merge(!s.discard, (found) => this.backUpLosers(found));
					// The discard device takes the remote's side without a word: it resets every day anyway.
					if (conflicts.length && !s.discard) this.notifyConflicts(conflicts);
					if (!push) {
						// What saveEditors() wrote was saved mid-sync, so it never started the idle push.
						if (committed) this.pushSoon?.();
						break;
					}
					try {
						await git.push();
						break;
					} catch (e) {
						if (!(e instanceof PushRejected) || attempt === 3) throw e;
						this.addLog('push refused: another device pushed first, merging again');
						await git.fetch();
					}
				}
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

	/**
	 * Obsidian saves a note about 2 seconds after the last keystroke. Saving now puts that typing in the commit,
	 * so a pull that changes or deletes the note handles it like any other local edit: merged, or copied to .trash.
	 * Markdown only: other views (canvas, plugins') may write on every save. save() skips unchanged notes.
	 */
	private async saveEditors() {
		// Background tabs that were never shown hold a placeholder view, with nothing unsaved.
		const views = this.app.workspace
			.getLeavesOfType('markdown')
			.map((leaf) => leaf.view)
			.filter((view) => view instanceof MarkdownView);
		await Promise.all(views.map((view) => view.save()));
	}

	get usesBuiltin() {
		return !Platform.isDesktop || this.settings.engine === 'builtin';
	}

	private get pushEnabled() {
		return this.settings.pushMode !== 'off' && !this.settings.discard;
	}

	/** Discard mode resets once a day: due when the last reset is older than the latest reset time. */
	private get resetDue() {
		const [hours = 0, minutes = 0] = this.settings.resetTime.split(':').map(Number);
		const at = new Date();
		at.setHours(hours, minutes, 0, 0);
		if (at.getTime() > Date.now()) at.setDate(at.getDate() - 1);
		return this.settings.lastReset < at.getTime();
	}

	private native() {
		if (!Platform.isDesktop) return null;
		const { adapter } = this.app.vault;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return new NativeGit(adapter.getBasePath(), node('child_process').execFile, node('process').env, (text) => this.addLog(text));
	}

	private engine(): Engine {
		const s = this.settings;
		return (
			(this.usesBuiltin ? null : this.native()) ??
			new BuiltinGit({
				fs: vaultFs(this.app),
				dir: '/',
				http,
				url: s.url,
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
		const time = format(Date.now(), 'HH:mm:ss');
		for (let line of text.split('\n')) {
			if (token) line = line.split(token).join('***');
			this.log.push(`${time} ${line.replace(/\/\/[^/\s@]+@/g, '//***@')}`);
		}
		this.log.splice(0, this.log.length - 1000);
	}

	/** Copies the local version of files about to be overwritten. */
	async toTrash(paths: string[]) {
		const { adapter } = this.app.vault;
		const folder = backupFolder();
		for (const path of paths) if (await adapter.exists(path)) await this.backUp(folder, path, await adapter.readBinary(path));
	}

	/** Copies the version that lost each conflict, from whichever side, before the merge writes anything. */
	private async backUpLosers(conflicts: Conflict[]) {
		const folder = backupFolder();
		for (const { path, lost } of conflicts) if (lost) await this.backUp(folder, path, lost.slice().buffer);
	}

	/** Writes a copy to `folder`/`path`. */
	private async backUp(folder: string, path: string, data: ArrayBuffer) {
		const copy = normalizePath(`${folder}/${path}`);
		await ensureFolder(this.app.vault, copy.slice(0, copy.lastIndexOf('/')));
		await this.app.vault.adapter.writeBinary(copy, data);
		this.addLog(`copied ${path} to ${copy}`);
	}

	/** One notice per sync, until dismissed. Each file stays listed until it's settled in the conflicts window. */
	private notifyConflicts(found: Conflict[]) {
		for (const c of found) this.conflicts.set(c.path, c);
		const names = found.map(({ path }) => path.slice(path.lastIndexOf('/') + 1));
		const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
		const message = createFragment((f) => {
			f.appendText(`Sync conflict: kept the newest version of ${list}. `);
			f.createEl('button', { text: 'Show' }).addEventListener('click', () => this.openConflicts());
		});
		new Notice(message, 0);
	}

	openConflicts() {
		new ConflictModal(this).open();
	}

	/** "Use this version": the current file goes to .trash, and the version the sync overwrote takes its place. */
	async restore({ path, lost }: Conflict) {
		await this.toTrash([path]);
		const fs = vaultFs(this.app).promises;
		if (lost) {
			await ensureFolder(this.app.vault, path.slice(0, Math.max(0, path.lastIndexOf('/'))));
			await fs.writeFile(path, lost);
		} else if (await this.app.vault.adapter.exists(path)) {
			await fs.unlink(path);
		}
		this.conflicts.delete(path);
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
		if (s.discard) {
			// Checked every minute, so the reset lands on time while the app stays open, or soon after the computer
			// wakes up. A reset that fails (offline, expired token) is retried every 10 minutes, not every minute.
			const check = () => {
				if (!this.resetDue || Date.now() - this.resetTry < 600_000) return;
				this.resetTry = Date.now();
				void this.sync(false, 'daily reset');
			};
			this.timers.push(this.registerInterval(window.setInterval(check, 60_000)));
		} else {
			every(s.pullInterval, false, 'pull timer');
		}
		if (this.pushEnabled && s.pushMode === 'interval') every(s.pushInterval, true, 'push timer');
		this.pushSoon = this.pushEnabled && s.pushMode === 'idle' ? debounce(() => void this.sync(true, 'stopped editing'), s.pushIdle * 1000, true) : null;
	}

	private showStatus() {
		this.statusEl?.setText(this.syncing ? 'Syncing…' : this.lastSync ? `Synced ${ago(this.lastSync)}` : '');
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
			this.settings.deviceName = node('os').hostname();
		} else {
			this.settings.deviceName = 'Mobile';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyTimers();
	}
}
