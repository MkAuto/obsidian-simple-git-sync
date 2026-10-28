import { Modal, Notice, Setting } from 'obsidian';
import type { Conflict } from './git';
import type SimpleGitSync from './main';
import { format } from './time';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const day = (time: number) => format(time, 'YYYY-MM-DD');
const when = (time: number) => format(time, day(time) === day(Date.now()) ? 'HH:mm' : 'YYYY-MM-DD HH:mm');
const device = (c: Conflict, side: Conflict['kept']) => (side === 'local' ? 'this device' : c.remote.device);
const other = (side: Conflict['kept']) => (side === 'local' ? 'remote' : 'local');

/** The files syncs settled for one side this session, and each one's losing version, to keep or bring back. */
export class ConflictModal extends Modal {
	private plugin: SimpleGitSync;

	constructor(plugin: SimpleGitSync) {
		super(plugin.app);
		this.plugin = plugin;
		this.setTitle('Sync conflicts');
	}

	onOpen() {
		this.showList();
	}

	private showList() {
		const { contentEl: el } = this;
		el.empty();
		if (!this.plugin.conflicts.size) {
			this.close();
			return;
		}
		for (const c of this.plugin.conflicts.values()) {
			new Setting(el)
				.setName(c.path)
				.setDesc(`Kept ${device(c, c.kept)}'s version, ${when(c[c.kept].time)}.`)
				.addButton((b) => b.setButtonText('Show').onClick(() => this.showFile(c)));
		}
	}

	private showFile(c: Conflict) {
		const { contentEl: el } = this;
		const lost = other(c.kept);
		el.empty();
		new Setting(el)
			.setName(c.path)
			.setDesc(`Kept ${device(c, c.kept)}'s version, ${when(c[c.kept].time)}. The other version, from ${device(c, lost)} at ${when(c[lost].time)}:`);
		if (!c.lost) {
			el.createEl('p', { text: `Deleted on ${device(c, lost)}.` });
		} else if (c.lost.includes(0)) {
			el.createEl('p', { text: `Binary file, ${Math.ceil(c.lost.length / 1024)} KB.` });
		} else {
			const box = el.createEl('textarea', { cls: 'simple-git-sync-log', attr: { readonly: '', rows: '16' } });
			box.value = new TextDecoder().decode(c.lost);
		}
		new Setting(el)
			.addButton((b) => b.setButtonText('Back').onClick(() => this.showList()))
			.addButton((b) =>
				b.setButtonText('Keep current').onClick(() => {
					this.plugin.conflicts.delete(c.path);
					this.showList();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText('Use this version')
					.setCta()
					.onClick(async () => {
						try {
							await this.plugin.restore(c);
						} catch (e) {
							new Notice(`Couldn't bring back ${c.path}: ${errorText(e)}`);
							return;
						}
						this.showList();
					}),
			);
	}
}
