import { Modal, Notice, SecretComponent, Setting } from 'obsidian';
import type { ButtonComponent } from 'obsidian';
import { clone, CLONING, listBranches } from './git';
import type SimpleGitSync from './main';
import { http, vaultFs } from './vault-io';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shown when the vault has no .git: clones over HTTPS with the built-in engine, on any device. */
export class CloneModal extends Modal {
	private plugin: SimpleGitSync;
	private branches: string[] = [];
	private branch = '';

	constructor(plugin: SimpleGitSync) {
		super(plugin.app);
		this.plugin = plugin;
		this.setTitle('Clone a repository');
	}

	onOpen() {
		this.render();
	}

	private render() {
		const { contentEl: el } = this;
		const s = this.plugin.settings;
		el.empty();
		el.createEl('p', {
			text: `This vault has no Git repository yet. Cloning brings in the repository's files, and its ${this.app.vault.configDir} folder replaces this one. Local files it replaces are copied to .trash/simple-git-sync/ first.`,
		});
		new Setting(el)
			.setName('Repository URL')
			.setDesc('HTTPS, for example https://github.com/you/notes.git')
			.addText((t) => t.setValue(s.url).onChange((value) => (s.url = value.trim())));
		new Setting(el)
			.setName('Token')
			.setDesc('A fine-grained token with access to this repository only, and contents set to read and write.')
			.addComponent((c) => new SecretComponent(this.app, c).setValue(s.token).onChange((value) => (s.token = value ?? '')));
		new Setting(el).setName('Author name').addText((t) => t.setValue(s.authorName).onChange((value) => (s.authorName = value.trim())));
		new Setting(el).setName('Author email').addText((t) => t.setValue(s.authorEmail).onChange((value) => (s.authorEmail = value.trim())));
		new Setting(el)
			.setName('Branch')
			.addDropdown((d) => {
				for (const branch of this.branches) d.addOption(branch, branch);
				d.setValue(this.branch).onChange((value) => (this.branch = value));
			})
			.addButton((b) => b.setButtonText('Load branches').onClick(() => void this.loadBranches()));
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Clone')
				.setCta()
				.setDisabled(!this.branch)
				.onClick(() => void this.clone(b)),
		);
	}

	private async loadBranches() {
		try {
			const { branches, head } = await listBranches(http, this.plugin.settings.url, this.plugin.token());
			this.branches = branches;
			this.branch = head && branches.includes(head) ? head : (branches[0] ?? '');
			this.render();
		} catch (e) {
			new Notice(`Couldn't list branches: ${errorText(e)}`);
		}
	}

	private async clone(button: ButtonComponent) {
		const { plugin } = this;
		const { adapter } = this.app.vault;
		const s = plugin.settings;
		if (!s.authorName || !s.authorEmail) {
			new Notice('Fill in the author name and email: commits from this device need them.');
			return;
		}
		button.setDisabled(true).setButtonText('Cloning…');
		const dropPartial = async () => {
			if (await adapter.exists(CLONING)) await adapter.rmdir(CLONING, true);
		};
		try {
			await plugin.saveSettings();
			await dropPartial(); // left by an attempt the app didn't live through
			await clone(vaultFs(this.app), '/', http, s.url, plugin.token(), this.branch, (paths) => plugin.toTrash(paths));
			// The repo now talks HTTPS with the token. Native git would go through the system's own credentials.
			s.engine = 'builtin';
			await plugin.saveSettings();
			// The cloned .obsidian may come from a device that never enabled this plugin.
			const list = `${this.app.vault.configDir}/community-plugins.json`;
			const ids = (await adapter.exists(list)) ? (JSON.parse(await adapter.read(list)) as string[]) : [];
			if (!ids.includes(plugin.manifest.id)) await adapter.write(list, JSON.stringify([...ids, plugin.manifest.id], null, 2));
			plugin.reloadApp();
		} catch (e) {
			// No half-cloned repo left behind. A finished one, already renamed to .git, stays.
			await dropPartial();
			new Notice(`Clone failed: ${errorText(e)}`);
			button.setDisabled(false).setButtonText('Clone');
		}
	}
}
