import { App, PluginSettingTab, setIcon } from 'obsidian';
import type BookViewPlugin from '../main';
import type { ModifierConfig, MenuProfile } from '../settings';
import { generalSettingDefinitions } from './generalSettingDefinitions';
import { tocSettingDefinitions } from './tocSettingDefinitions';
import { renderSettingDefinitions } from './settingDefinitions';
import type { BookSettingDefinition, BookSettingGroup } from './settingDefinitions';
import { CommandSuggestModal, IconSuggestModal } from './CommandSuggestModal';

type SettingsSection = 'toc' | 'menus' | 'general';

let _defaultColor: string | null = null;

function getDefaultColor(): string {
	if (_defaultColor) return _defaultColor;
	const temp = createDiv();
	temp.addClass('bv-color-probe');
	document.body.appendChild(temp);
	const rgb = getComputedStyle(temp).color;
	temp.remove();
	const m = rgb.match(/\d+/g);
	if (m && m.length >= 3) {
		_defaultColor = '#' + [0, 1, 2].map((i) => parseInt(m[i]!).toString(16).padStart(2, '0')).join('');
	} else {
		_defaultColor = '#000000';
	}
	return _defaultColor;
}

export class BookViewSettingTab extends PluginSettingTab {
	plugin: BookViewPlugin;
	private activeSection: SettingsSection = 'general';

	constructor(app: App, plugin: BookViewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): (BookSettingDefinition | BookSettingGroup)[] {
		return [
			...this.getGeneralDefinitions(),
			{ type: 'group', heading: 'Table of contents', items: tocSettingDefinitions(this.plugin) },
			{ type: 'group', heading: 'Context menus', items: [{
				name: 'Menu profiles',
				desc: 'Configure modifier shortcuts and commands for each context menu.',
				render: (setting) => {
					const container = setting.settingEl.createDiv({ cls: 'bv-menu-settings' });
					setting.settingEl.addClass('bv-menu-setting-row');
					this.renderMenuProfiles(container);
				},
			}] },
		];
	}

	private getGeneralDefinitions(): BookSettingDefinition[] {
		return [
			...generalSettingDefinitions(this.plugin, () => this.refreshSettings()),
			{
				name: 'Editor shortcut modifiers',
				desc: 'Modifier keys required to open the editor on double-click.',
				render: (setting) => this.renderSingleModifier(setting.controlEl),
			},
		];
	}

	private refreshSettings(): void {
		// Older versions use display(); 1.13+ must rebuild definitions via update().
		const tab = this as unknown as { update?: () => void };
		if (typeof tab.update === 'function') tab.update();
		else this.display();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const tabBar = containerEl.createDiv({ cls: 'bv-settings-tabs' });

		const sections: Array<{ id: SettingsSection; label: string }> = [
			{ id: 'general', label: 'General' },
			{ id: 'toc', label: 'Table of contents' },
			{ id: 'menus', label: 'Context menus' },
		];

		const sectionEls: Record<SettingsSection, HTMLElement> = {
			toc: containerEl.createDiv({ cls: 'bv-settings-section' }),
			menus: containerEl.createDiv({ cls: 'bv-settings-section' }),
			general: containerEl.createDiv({ cls: 'bv-settings-section' }),
		};

		for (const section of sections) {
			const tab = tabBar.createEl('button', { cls: 'bv-settings-tab', text: section.label });
			tab.dataset.tab = section.id;
			tab.addEventListener('click', () => this.showSection(section.id, tabBar, sectionEls));
		}

		renderSettingDefinitions(sectionEls.toc, tocSettingDefinitions(this.plugin));
		this.renderMenuSettings(sectionEls.menus);
		renderSettingDefinitions(sectionEls.general, this.getGeneralDefinitions());

		this.showSection(this.activeSection, tabBar, sectionEls);
	}

	private showSection(
		id: SettingsSection,
		tabBar: HTMLElement,
		sectionEls: Record<SettingsSection, HTMLElement>,
	): void {
		this.activeSection = id;
		tabBar.querySelectorAll<HTMLElement>('.bv-settings-tab').forEach((tab) => {
			tab.toggleClass('is-active', tab.dataset.tab === id);
		});
		for (const [secId, el] of Object.entries(sectionEls) as Array<[SettingsSection, HTMLElement]>) {
			el.toggleClass('is-active', secId === id);
		}
	}

	private renderMenuSettings(el: HTMLElement): void {
		this.renderMenuProfiles(el);
	}

	private renderSingleModifier(containerEl: HTMLElement): void {
		const mod = this.plugin.settings.editorModifiers;
		const row = containerEl.createDiv({ cls: 'bv-mod-row' });

		const renderCheckbox = (label: string, modKey: keyof ModifierConfig) => {
			const labelEl = row.createEl('label');
			labelEl.addClass('bv-mod-label');
			const cb = labelEl.createEl('input', { type: 'checkbox' });
			cb.checked = mod[modKey];
			cb.onchange = async () => {
				mod[modKey] = cb.checked;
				await this.plugin.saveSettings();
			};
			labelEl.append(` ${label}`);
		};

		renderCheckbox('Alt', 'alt');
		renderCheckbox('Ctrl', 'ctrl');
		renderCheckbox('Shift', 'shift');
		renderCheckbox('Meta', 'meta');
	}

	private renderMenuProfiles(containerEl: HTMLElement): void {
		containerEl.createEl('p', {
			text: 'Each profile is an independent right-click menu with its own modifier shortcut and scripts. Right-click with the matching modifiers to open that profile\'s menu.',
			cls: 'setting-item-description',
		});

		const profiles = this.plugin.settings.menuProfiles;
		const listDiv = containerEl.createDiv();

		const renderAll = () => {
			listDiv.empty();

			for (let pi = 0; pi < profiles.length; pi++) {
				const profile = profiles[pi];
				if (!profile) continue;

				const card = listDiv.createDiv({ cls: 'bv-profile-card' });

				const header = card.createDiv({ cls: 'bv-profile-header' });

				const nameInput = header.createEl('input', { type: 'text', cls: 'bv-profile-name' });
				nameInput.value = profile.name;
				nameInput.placeholder = 'Profile name';
				nameInput.onchange = async () => {
					profile.name = nameInput.value;
					await this.plugin.saveSettings();
				};

				const removeProfileBtn = header.createEl('button', { text: '\u00D7', cls: 'bv-remove-btn' });
				removeProfileBtn.title = 'Remove profile';
				removeProfileBtn.onclick = async () => {
					profiles.splice(pi, 1);
					await this.plugin.saveSettings();
					renderAll();
				};

				card.createEl('p', { text: 'Modifier shortcut:', cls: 'bv-profile-mod-label' });
				const modRow = card.createDiv({ cls: 'bv-mod-row' });

				const renderModCheckbox = (label: string, modKey: keyof ModifierConfig) => {
					const labelEl = modRow.createEl('label');
					labelEl.addClass('bv-mod-label');
					const cb = labelEl.createEl('input', { type: 'checkbox' });
					cb.checked = profile.modifiers[modKey];
					cb.onchange = async () => {
						profile.modifiers[modKey] = cb.checked;
						await this.plugin.saveSettings();
					};
					labelEl.append(` ${label}`);
				};

				renderModCheckbox('Alt', 'alt');
				renderModCheckbox('Ctrl', 'ctrl');
				renderModCheckbox('Shift', 'shift');
				renderModCheckbox('Meta', 'meta');

				this.renderProfileScripts(card, profile, renderAll);
			}
		};

		renderAll();

		const addBtn = listDiv.createEl('button', { text: '+ add profile' });
		addBtn.onclick = async () => {
			profiles.push({ name: 'New profile', modifiers: { alt: false, ctrl: false, shift: false, meta: false }, scripts: [] });
			await this.plugin.saveSettings();
			renderAll();
		};
	}

	private renderProfileScripts(card: HTMLElement, profile: MenuProfile, onReorder: () => void): void {
		const scripts = profile.scripts;
		const listDiv = card.createDiv({ cls: 'bv-profile-scripts' });

		const renderList = () => {
			listDiv.empty();

			for (let i = 0; i < scripts.length; i++) {
				const entry = scripts[i];
				if (!entry) continue;

				if (entry.isSeparator) {
					const row = listDiv.createDiv({ cls: 'bv-script-row' });
					this.renderMoveButtons(row, scripts, i, renderList);

					const sepIcon = row.createSpan({ cls: 'bv-sep-icon' });
					sepIcon.setText('\u2014');

					row.createSpan({ cls: 'bv-sep-label', text: 'Separator' });

					const removeBtn = row.createEl('button', { text: '\u00D7', cls: 'bv-remove-btn' });
					removeBtn.onclick = async () => {
						scripts.splice(i, 1);
						await this.plugin.saveSettings();
						renderList();
					};

					continue;
				}

				const row = listDiv.createDiv({ cls: 'bv-script-row' });
				this.renderMoveButtons(row, scripts, i, renderList);

				const labelInput = row.createEl('input', { type: 'text', cls: 'bv-script-input' });
				labelInput.value = entry.label;
				labelInput.placeholder = 'Label (e.g. Replace text)';
				labelInput.onchange = async () => {
					entry.label = labelInput.value;
					await this.plugin.saveSettings();
				};

				const iconBtn = row.createEl('button', { cls: 'bv-icon-btn' });
				iconBtn.title = 'Choose icon';
				const renderIcon = () => {
					iconBtn.empty();
					if (entry.icon) {
						setIcon(iconBtn, entry.icon);
					} else {
						iconBtn.setText('?');
					}
				};
				renderIcon();
				iconBtn.onclick = () => {
					new IconSuggestModal(this.app, (iconName) => {
						entry.icon = iconName;
						renderIcon();
						void this.plugin.saveSettings();
					}).open();
				};

				const colorInput = row.createEl('input', { type: 'color', cls: 'bv-color-input' });
				colorInput.value = entry.color || getDefaultColor();
				colorInput.title = 'Item color';
				colorInput.onchange = () => {
					entry.color = colorInput.value;
					void this.plugin.saveSettings();
				};

				const clearColorBtn = row.createEl('button', { text: '\u00D7', cls: 'bv-clear-color-btn' });
				clearColorBtn.title = 'Clear color';
				clearColorBtn.onclick = async () => {
					entry.color = undefined;
					colorInput.value = getDefaultColor();
					await this.plugin.saveSettings();
				};

				const cmdInput = row.createEl('input', { type: 'text', cls: 'bv-script-input' });
				cmdInput.value = entry.commandId;
				cmdInput.placeholder = 'Command ID (e.g. Quickadd:macro:mymacro)';
				cmdInput.onchange = async () => {
					entry.commandId = cmdInput.value;
					await this.plugin.saveSettings();
				};

				const searchBtn = row.createEl('button', { text: 'Find...', cls: 'bv-find-btn' });
				searchBtn.title = 'Search for a command';
				searchBtn.onclick = () => {
					new CommandSuggestModal(this.app, (command) => {
						labelInput.value = command.name;
						cmdInput.value = command.id;
						entry.label = command.name;
						entry.commandId = command.id;
						void this.plugin.saveSettings();
					}).open();
				};

				const removeBtn = row.createEl('button', { text: '\u00D7', cls: 'bv-remove-btn' });
				removeBtn.onclick = async () => {
					scripts.splice(i, 1);
					await this.plugin.saveSettings();
					renderList();
				};
			}
		};

		renderList();

		const addRow = listDiv.createDiv({ cls: 'bv-add-row' });
		const addBtn = addRow.createEl('button', { text: '+ add script' });
		addBtn.onclick = async () => {
			scripts.push({ label: 'New script', commandId: '' });
			await this.plugin.saveSettings();
			renderList();
		};
		const addSepBtn = addRow.createEl('button', { text: '+ separator' });
		addSepBtn.onclick = async () => {
			scripts.push({ label: '', commandId: '', isSeparator: true });
			await this.plugin.saveSettings();
			renderList();
		};
	}

	private renderMoveButtons(row: HTMLElement, list: unknown[], index: number, onReorder: () => void): void {
		const moveUp = row.createEl('button', { text: '\u25B2', cls: 'bv-move-btn' });
		moveUp.title = 'Move up';
		moveUp.disabled = index === 0;
		moveUp.onclick = async () => {
			if (index > 0) {
				const prev = list[index - 1];
				const curr = list[index];
				if (prev !== undefined && curr !== undefined) {
					list[index - 1] = curr;
					list[index] = prev;
					await this.plugin.saveSettings();
					onReorder();
				}
			}
		};

		const moveDown = row.createEl('button', { text: '\u25BC', cls: 'bv-move-btn' });
		moveDown.title = 'Move down';
		moveDown.disabled = index === list.length - 1;
		moveDown.onclick = async () => {
			if (index < list.length - 1) {
				const next = list[index + 1];
				const curr = list[index];
				if (next !== undefined && curr !== undefined) {
					list[index + 1] = curr;
					list[index] = next;
					await this.plugin.saveSettings();
					onReorder();
				}
			}
		};
	}
}
