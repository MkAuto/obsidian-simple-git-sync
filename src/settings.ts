import { Platform, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
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

type Keys<T> = { [K in keyof Settings]: T extends Settings[K] ? K : never }[keyof Settings];

export class SettingTab extends PluginSettingTab {
	private plugin: SimpleGitSync;

	constructor(plugin: SimpleGitSync) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl: el, plugin } = this;
		const s = plugin.settings;
		const save = () => plugin.saveSettings();
		const redraw = async () => {
			await save();
			this.display();
		};
		const toggle = (name: string, desc: string, key: Keys<boolean>, rerender = false) =>
			new Setting(el).setName(name).setDesc(desc).addToggle((t) =>
				t.setValue(s[key]).onChange(async (value) => {
					s[key] = value;
					await (rerender ? redraw() : save());
				}),
			);
		const text = (name: string, desc: string, key: Keys<string>) =>
			new Setting(el).setName(name).setDesc(desc).addText((t) =>
				t.setValue(s[key]).onChange(async (value) => {
					s[key] = value.trim();
					await save();
				}),
			);
		const number = (name: string, desc: string, key: Keys<number>) =>
			new Setting(el).setName(name).setDesc(desc).addText((t) => {
				t.inputEl.type = 'number';
				t.setValue(String(s[key])).onChange(async (value) => {
					s[key] = Math.max(0, Number(value) || 0);
					await save();
				});
			});

		el.empty();

		if (!plugin.hasRepo) {
			new Setting(el)
				.setName('No repository in this vault')
				.setDesc('Clone one to start syncing.')
				.addButton((b) => b.setButtonText('Clone').setCta().onClick(() => plugin.openClone()));
		}

		if (Platform.isDesktop) {
			new Setting(el)
				.setName('Engine')
				.setDesc('Native uses your installed Git and SSH keys. Built-in is what mobile uses: HTTPS and a token.')
				.addDropdown((d) =>
					d.addOptions({ native: 'Native git', builtin: 'Built-in' }).setValue(s.engine).onChange(async (value) => {
						s.engine = value as Settings['engine'];
						if (s.engine === 'builtin') await plugin.prefillBuiltin();
						await redraw();
					}),
				);
		}
		if (plugin.usesBuiltin) {
			text('Repository URL', 'HTTPS, for example https://github.com/you/notes.git', 'url');
			new Setting(el)
				.setName('Token')
				.setDesc('A fine-grained token with access to this repository only, and contents set to read and write.')
				.addComponent((c) =>
					new SecretComponent(this.app, c).setValue(s.token).onChange(async (value) => {
						s.token = value ?? '';
						await save();
					}),
				);
			text('Author name', 'Used for commits from this device.', 'authorName');
			text('Author email', 'Used for commits from this device.', 'authorEmail');
		}
		text('Device name', 'Shown in commit messages.', 'deviceName');

		new Setting(el).setName('Pull').setHeading();
		toggle('Pull on open and on return to the app', '', 'pullOnOpen');
		if (!s.discard) number('Pull every N minutes', '0 turns it off.', 'pullInterval');
		toggle(
			'Discard local changes once a day',
			'For a device you only read on, like a daily checklist. Once a day, resets this device to the remote, unpushed commits included. Discarded files are copied to .trash/simple-git-sync/ first. Pulls in between keep your changes. Turns push off.',
			'discard',
			true,
		);

		if (s.discard) {
			new Setting(el)
				.setName('Reset at')
				.setDesc('Every day at this time. If the app is closed then, the first pull after it resets.')
				.addText((t) => {
					t.inputEl.type = 'time';
					t.setValue(s.resetTime).onChange(async (value) => {
						if (!/^\d\d:\d\d$/.test(value)) return; // cleared or half typed: keep the last time
						s.resetTime = value;
						await save();
					});
				});
		} else {
			new Setting(el).setName('Push').setHeading();
			new Setting(el).setName('Push automatically').addDropdown((d) =>
				d
					.addOptions({ off: 'Off', idle: 'After I stop editing', interval: 'Every N minutes' })
					.setValue(s.pushMode)
					.onChange(async (value) => {
						s.pushMode = value as Settings['pushMode'];
						await redraw();
					}),
			);
			if (s.pushMode === 'idle') number('Seconds after you stop editing', '', 'pushIdle');
			if (s.pushMode === 'interval') number('Push every N minutes', '', 'pushInterval');
			if (s.pushMode !== 'off') toggle('Push when the app goes to the background', 'Best effort: the system may close the app first.', 'pushOnBackground');
		}

		new Setting(el).setName('Developer').setHeading();
		toggle('Show sync log', '', 'showLog', true);
		if (s.showLog) {
			const log = el.createEl('textarea', { cls: 'simple-git-sync-log', attr: { readonly: '', rows: '16' } });
			log.value = plugin.log.join('\n');
			log.scrollTop = log.scrollHeight;
		}
	}
}
