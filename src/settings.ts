import { Platform, PluginSettingTab } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type SimpleGitSync from './main';

/** All per-device: data.json is gitignored. */
export interface Settings {
	engine: 'native' | 'builtin'; // desktop only; mobile is always built-in
	deviceName: string;
	pullOnOpen: boolean;
	pullInterval: number; // minutes, 0 = off
	discard: boolean;
	resetTime: string; // HH:mm, when discard mode resets this device each day
	lastReset: number; // when discard mode last reset this device, in ms; not shown
	pushMode: 'off' | 'idle' | 'interval';
	pushIdle: number; // seconds
	pushInterval: number; // minutes
	pushOnBackground: boolean;
	url: string;
	token: string; // a SecretStorage id, not the token itself
	authorName: string;
	authorEmail: string;
	showLog: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	engine: 'native',
	deviceName: '',
	pullOnOpen: true,
	pullInterval: 0,
	discard: false,
	resetTime: '00:00',
	lastReset: 0,
	pushMode: 'idle',
	pushIdle: 60,
	pushInterval: 10,
	pushOnBackground: true,
	url: '',
	token: '',
	authorName: '',
	authorEmail: '',
	showLog: false,
};

export class SettingTab extends PluginSettingTab {
	private plugin: SimpleGitSync;

	constructor(plugin: SimpleGitSync) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { plugin } = this;
		const s = plugin.settings;
		const builtin = () => plugin.usesBuiltin;
		return [
			{
				name: 'No repository in this vault',
				desc: 'Clone one to start syncing.',
				visible: () => !plugin.hasRepo,
				render: (setting) => {
					setting.addButton((b) => b.setButtonText('Clone').setCta().onClick(() => plugin.openClone()));
				},
			},
			{
				name: 'Engine',
				desc: 'Native uses your installed Git and SSH keys. Built-in is what mobile uses: HTTPS and a token.',
				visible: Platform.isDesktop,
				control: { type: 'dropdown', key: 'engine', options: { native: 'Native git', builtin: 'Built-in' } },
			},
			{ name: 'Repository URL', desc: 'HTTPS, for example https://github.com/you/notes.git', visible: builtin, control: { type: 'text', key: 'url' } },
			{
				name: 'Token',
				desc: 'A fine-grained token with access to this repository only, and contents set to read and write.',
				visible: builtin,
				control: { type: 'secret', key: 'token' },
			},
			{ name: 'Author name', desc: 'Used for commits from this device.', visible: builtin, control: { type: 'text', key: 'authorName' } },
			{ name: 'Author email', desc: 'Used for commits from this device.', visible: builtin, control: { type: 'text', key: 'authorEmail' } },
			{ name: 'Device name', desc: 'Shown in commit messages.', control: { type: 'text', key: 'deviceName' } },
			{
				type: 'group',
				heading: 'Pull',
				items: [
					{ name: 'Pull on open and on return to the app', control: { type: 'toggle', key: 'pullOnOpen' } },
					{ name: 'Pull every N minutes', desc: '0 turns it off.', visible: () => !s.discard, control: { type: 'number', key: 'pullInterval', min: 0 } },
					{
						name: 'Discard local changes once a day',
						desc: 'For a device you only read on, like a daily checklist. Once a day, resets this device to the remote, unpushed commits included. Discarded files are copied to .trash/simple-git-sync/ first. Pulls in between keep your changes. Turns push off.',
						control: { type: 'toggle', key: 'discard' },
					},
					{
						name: 'Reset at',
						desc: 'Every day at this time. If the app is closed then, the first pull after it resets.',
						visible: () => s.discard,
						// A time picker: the text control has no input type.
						render: (setting) => {
							setting.addText((t) => {
								t.inputEl.type = 'time';
								t.setValue(s.resetTime).onChange(async (value) => {
									if (!/^\d\d:\d\d$/.test(value)) return; // cleared or half typed: keep the last time
									s.resetTime = value;
									await plugin.saveSettings();
								});
							});
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Push',
				visible: () => !s.discard,
				items: [
					{
						name: 'Push automatically',
						control: { type: 'dropdown', key: 'pushMode', options: { off: 'Off', idle: 'After I stop editing', interval: 'Every N minutes' } },
					},
					{ name: 'Seconds after you stop editing', visible: () => s.pushMode === 'idle', control: { type: 'number', key: 'pushIdle', min: 0 } },
					{ name: 'Push every N minutes', visible: () => s.pushMode === 'interval', control: { type: 'number', key: 'pushInterval', min: 0 } },
					{
						name: 'Push when the app goes to the background',
						desc: 'Best effort: the system may close the app first.',
						visible: () => s.pushMode !== 'off',
						control: { type: 'toggle', key: 'pushOnBackground' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Developer',
				items: [
					{ name: 'Show sync log', control: { type: 'toggle', key: 'showLog' } },
					{
						name: 'Sync log',
						visible: () => s.showLog,
						searchable: false,
						render: (setting) => {
							setting.settingEl.addClass('simple-git-sync-log-row'); // full width, no name
							// In controlEl: a redraw empties it, so the old box doesn't stay behind.
							const log = setting.controlEl.createEl('textarea', { cls: 'simple-git-sync-log', attr: { readonly: '', rows: '16' } });
							log.value = plugin.log.join('\n');
							// Next frame: a row that's being shown is still hidden while it renders, with nothing to scroll.
							log.win.requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
						},
					},
				],
			},
		];
	}

	/** Saved as PluginSettingTab saves it, trimmed, then the timers restart to match. */
	async setControlValue(key: string, value: unknown) {
		const { plugin } = this;
		if (key === 'engine' && value === 'builtin') await plugin.prefillBuiltin();
		// null: the token was cleared.
		await super.setControlValue(key, typeof value === 'string' ? value.trim() : (value ?? ''));
		plugin.applyTimers();
		// Redrawn for what prefillBuiltin() filled in, and for the log as it is now.
		if (key === 'engine' || key === 'showLog') this.update();
	}
}
