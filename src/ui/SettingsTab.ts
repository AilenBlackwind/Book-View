import { App, PluginSettingTab, Setting } from 'obsidian';
import type BookViewPlugin from '../main';
import type { ScriptEntry } from '../settings';
import { CommandSuggestModal } from './CommandSuggestModal';

export class BookViewSettingTab extends PluginSettingTab {
	plugin: BookViewPlugin;

	constructor(app: App, plugin: BookViewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Table of contents width')
			.setDesc('Width of the toc panel in pixels.')
			.addSlider((slider) =>
				slider
					.setLimits(150, 500, 10)
					.setValue(this.plugin.settings.tocWidth)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
						this.plugin.settings.tocWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show file names in toc')
			.setDesc('Display file names as section headers in the table of contents.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tocShowFileNames)
					.onChange(async (value: boolean) => {
						this.plugin.settings.tocShowFileNames = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show nesting guides in toc')
			.setDesc('Display vertical guide lines from headings to show nesting depth.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tocGuides)
					.onChange(async (value: boolean) => {
						this.plugin.settings.tocGuides = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Render Markdown in toc')
			.setDesc('Render bold, italic, code and other inline Markdown in headings instead of showing raw syntax.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tocRenderMarkdown)
					.onChange(async (value: boolean) => {
						this.plugin.settings.tocRenderMarkdown = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Lazy load margin')
			.setDesc('How many pixels above and below the viewport to pre-load sections. Increase for slower devices, decrease for faster ones.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 3000, 50)
					.setValue(this.plugin.settings.loadMargin)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
						this.plugin.settings.loadMargin = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Wheel flick acceleration')
			.setDesc('Inside book view, turn mouse wheel notches into smooth accelerated flicks. Other scroll plugins are intercepted only within book view.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.wheelFlickEnabled)
					.onChange(async (value: boolean) => {
						this.plugin.settings.wheelFlickEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Wheel flick strength')
			.setDesc('Total scroll distance per notch, as a multiple of the native amount.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 5, 0.25)
					.setValue(this.plugin.settings.wheelFlickStrength)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
						this.plugin.settings.wheelFlickStrength = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Wheel flick smoothness')
			.setDesc('How long the flick glides. Higher values glide longer.')
			.addSlider((slider) =>
				slider
					.setLimits(0.85, 0.97, 0.01)
					.setValue(this.plugin.settings.wheelFlickFriction)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
						this.plugin.settings.wheelFlickFriction = value;
						await this.plugin.saveSettings();
					}),
			);

		this.renderScripts(containerEl);
	}

	private renderScripts(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Scripts' });
		containerEl.createEl('p', {
			text: 'Commands shown in the right-click menu inside Book View. External scripts (QuickAdd, Templater, etc.) can use the BookView API to read and modify atom text.',
			cls: 'setting-item-description',
		});

		const scripts = this.plugin.settings.scripts;

		const listDiv = containerEl.createDiv();

		const renderList = () => {
			listDiv.empty();

			for (let i = 0; i < scripts.length; i++) {
				const entry = scripts[i];
				if (!entry) continue;

				const row = listDiv.createDiv();
				row.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 4px;';

				const moveUp = row.createEl('button', { text: '\u25B2' });
				moveUp.style.cssText = 'width: 22px; height: 22px; padding: 0; border: 1px solid var(--background-modifier-border); border-radius: 3px; background: transparent; cursor: pointer; color: var(--text-muted); font-size: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;';
				moveUp.title = 'Move up';
				moveUp.disabled = i === 0;
			moveUp.onclick = async () => {
				if (i > 0) {
					const prev = scripts[i - 1];
					if (prev) {
						scripts[i - 1] = entry;
						scripts[i] = prev;
						await this.plugin.saveSettings();
						renderList();
					}
				}
			};

			const moveDown = row.createEl('button', { text: '\u25BC' });
			moveDown.style.cssText = 'width: 22px; height: 22px; padding: 0; border: 1px solid var(--background-modifier-border); border-radius: 3px; background: transparent; cursor: pointer; color: var(--text-muted); font-size: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;';
			moveDown.title = 'Move down';
			moveDown.disabled = i === scripts.length - 1;
			moveDown.onclick = async () => {
				if (i < scripts.length - 1) {
					const next = scripts[i + 1];
					if (next) {
						scripts[i + 1] = entry;
						scripts[i] = next;
						await this.plugin.saveSettings();
						renderList();
					}
				}
			};

				const labelInput = row.createEl('input', { type: 'text' });
				labelInput.value = entry.label;
				labelInput.style.cssText = 'flex: 1; background: var(--background-primary);';
				labelInput.placeholder = 'Label (e.g. Replace text)';
				labelInput.onchange = async () => {
					entry.label = labelInput.value;
					await this.plugin.saveSettings();
				};

				const cmdInput = row.createEl('input', { type: 'text' });
				cmdInput.value = entry.commandId;
				cmdInput.style.cssText = 'flex: 1; background: var(--background-primary);';
				cmdInput.placeholder = 'Command ID (e.g. quickadd:macro:MyMacro)';
				cmdInput.onchange = async () => {
					entry.commandId = cmdInput.value;
					await this.plugin.saveSettings();
				};

				const searchBtn = row.createEl('button', { text: 'Find...' });
				searchBtn.style.cssText = 'background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-size: 12px;';
				searchBtn.title = 'Search for a command';
				searchBtn.onclick = () => {
					new CommandSuggestModal(this.app, (command) => {
						labelInput.value = command.name;
						cmdInput.value = command.id;
						entry.label = command.name;
						entry.commandId = command.id;
						this.plugin.saveSettings();
					}).open();
				};

				const removeBtn = row.createEl('button', { text: '\u00D7' });
				removeBtn.style.cssText = 'background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-size: 16px;';
				removeBtn.onclick = async () => {
					scripts.splice(i, 1);
					await this.plugin.saveSettings();
					renderList();
				};
			}
		};

		renderList();

		const addRow = containerEl.createDiv();
		addRow.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';
		const addBtn = addRow.createEl('button', { text: '+ Add script' });
		addBtn.onclick = async () => {
			const newEntry: ScriptEntry = { label: 'New script', commandId: '' };
			scripts.push(newEntry);
			await this.plugin.saveSettings();
			renderList();
		};
	}
}
