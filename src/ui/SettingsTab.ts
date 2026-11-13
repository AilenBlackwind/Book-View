import { App, PluginSettingTab, setIcon } from 'obsidian';
import type BookViewPlugin from '../main';
import type { ModifierConfig, MenuProfile, ScriptEntry } from '../settings';
import { generalSettingDefinitions } from './generalSettingDefinitions';
import { tocSettingDefinitions } from './tocSettingDefinitions';
import { renderSettingDefinitions } from './settingDefinitions';
import type { BookSettingDefinition, BookSettingPage } from './settingDefinitions';
import { listCommands, CommandSuggestModal, IconSuggestModal } from './CommandSuggestModal';

function renderMenuIcon(element: HTMLElement, icon: string): boolean {
	element.empty();
	setIcon(element, icon);
	return element.querySelector('svg') !== null;
}

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
	private commandNames = new Map<string, string>();
	private activeSection: SettingsSection = 'general';

	constructor(app: App, plugin: BookViewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): BookSettingPage[] {
		return [
			{ type: 'page', name: 'General', items: this.getGeneralDefinitions() },
			{ type: 'page', name: 'Table of contents', items: tocSettingDefinitions(this.plugin) },
			{ type: 'page', name: 'Context menus', items: [{
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
				name: 'Startup diagnostics',
				desc: 'Record the first 60 seconds after Book View loads; restart Obsidian after changing this. Keeps 20 local reports in the plugin folder with tab types, caller stacks and errors. No note text is recorded or sent. Use the Copy startup reports command to share them.',
				render: (setting) => {
					setting.addToggle((toggle) => toggle
						.setValue(this.plugin.settings.startupDiagnosticsEnabled)
						.onChange(async (value) => {
							this.plugin.settings.startupDiagnosticsEnabled = value;
							if (!value) this.plugin.startupDiagnostics?.stop('disabled in settings');
							await this.plugin.saveSettings();
						}));
				},
			},
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
		this.commandNames = new Map(listCommands(this.app).map(({ id, name }) => [id, name]));
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

				this.renderProfileScripts(card, profile);
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

	private renderProfileScripts(card: HTMLElement, profile: MenuProfile): void {
		const listDiv = card.createDiv({ cls: 'bv-profile-scripts bv-command-settings' });
		const rows = listDiv.createDiv();
		const scripts = profile.scripts;
		const render = () => {
			rows.empty();
			for (let i = 0; i < scripts.length; i++) {
				this.renderEntryRow(rows, scripts, i, render);
			}
		};
		render();

		const actions = listDiv.createDiv({ cls: 'bv-add-row' });
		this.renderAddCommand(actions, scripts, render);
		const separator = actions.createEl('button', { text: '+ separator' });
		separator.onclick = async () => {
			scripts.push({ label: '', commandId: '', isSeparator: true });
			await this.plugin.saveSettings();
			render();
		};
	}

	private renderAddCommand(container: HTMLElement, list: ScriptEntry[], render: () => void): void {
		const button = container.createEl('button', { text: '+ add command' });
		button.onclick = () => {
			new CommandSuggestModal(this.app, async ({ id, name }) => {
				this.commandNames.set(id, name);
				list.push({ label: name, commandId: id, commandName: name });
				await this.plugin.saveSettings();
				render();
			}).open();
		};
	}

	private renderEntryRow(
		container: HTMLElement,
		list: ScriptEntry[],
		index: number,
		render: () => void
	): void {
		const entry = list[index];
		if (!entry) return;
		const row = container.createDiv({ cls: entry.isSeparator ? 'bv-cmd-entry-row bv-cmd-entry-separator' : 'bv-cmd-entry-row' });
		const order = row.createDiv({ cls: 'bv-cmd-entry-controls' });

		const action = (parent: HTMLElement, text: string, title: string, cls = '') => {
			const button = parent.createEl('button', {
				text,
				cls: 'bv-cmd-entry-action ' + cls,
				attr: { title, 'aria-label': title },
			});
			return button;
		};

		for (const [offset, title] of [[-1, 'Move up'], [1, 'Move down']] as const) {
			const button = action(order, '', title, 'bv-cmd-item-icon-btn');
			const icon = offset < 0 ? 'chevron-up' : 'chevron-down';
			if (!renderMenuIcon(button, icon)) button.setText(offset < 0 ? '↑' : '↓');
			const next = index + offset;
			button.disabled = next < 0 || next >= list.length;
			button.onclick = async () => {
				const target = list[next];
				if (!target) return;
				list[index] = target;
				list[next] = entry;
				await this.plugin.saveSettings();
				render();
			};
		}

		const details = row.createDiv({ cls: 'bv-cmd-entry-details' });
		const controls = row.createDiv({ cls: 'bv-cmd-entry-controls' });

		if (entry.isSeparator) {
			details.createDiv({ cls: 'bv-cmd-entry-separator-line', attr: { role: 'separator' } });
		} else {
			const labelButton = details.createEl('button', {
				cls: 'bv-cmd-entry-label',
				attr: { type: 'button' },
			});
			const description = details.createDiv({ cls: 'bv-cmd-entry-description bv-cmd-entry-command-name' });
			const renderLabel = () => {
				const name = this.commandNames.get(entry.commandId);
				const original = name ?? entry.commandName;
				const label = entry.label || original || 'Menu label';
				const distinctName = original && original.trim() !== label.trim() ? original : '';
				const status = name ? '' : entry.commandId ? 'Command unavailable' : 'No command selected';
				const subtitle = [distinctName, status].filter(Boolean).join(' · ');
				labelButton.setText(label);
				labelButton.title = label + ' — click to edit';
				labelButton.setAttribute('aria-label', 'Edit menu label: ' + label);
				description.setText(subtitle);
				description.title = subtitle;
				description.hidden = !subtitle;
			};
			renderLabel();

			labelButton.onclick = () => {
				labelButton.hidden = true;
				const input = details.createEl('input', {
					type: 'text',
					cls: 'bv-cmd-entry-label-input',
					attr: { 'aria-label': 'Menu label', placeholder: 'Menu label' },
				});
				details.insertBefore(input, description);
				input.value = entry.label;

				const finish = (save: boolean, restoreFocus: boolean) => {
					if (!labelButton.hidden) return;
					labelButton.hidden = false;
					input.remove();
					if (restoreFocus) labelButton.focus();
					if (!save || input.value === entry.label) return;
					entry.label = input.value;
					renderLabel();
					void this.plugin.saveSettings();
				};

				input.onblur = () => finish(true, false);
				input.onkeydown = (event) => {
					if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
					event.preventDefault();
					event.stopPropagation();
					finish(event.key === 'Enter', true);
				};
				input.focus();
				input.select();
			};

			const iconBtn = action(controls, '', 'Choose icon', 'bv-cmd-item-icon-btn');
			const renderIcon = () => {
				if (!entry.icon || !renderMenuIcon(iconBtn, entry.icon)) iconBtn.setText('?');
			};
			renderIcon();
			iconBtn.onclick = () => {
				new IconSuggestModal(this.app, async (iconName) => {
					entry.icon = iconName;
					renderIcon();
					await this.plugin.saveSettings();
				}).open();
			};

			const colorInput = controls.createEl('input', {
				type: 'color',
				cls: 'bv-cmd-entry-color',
				attr: { title: 'Item color', 'aria-label': 'Item color' },
			});
			colorInput.value = entry.color || getDefaultColor();
			colorInput.onchange = async () => {
				entry.color = colorInput.value;
				await this.plugin.saveSettings();
			};

			const clearColor = action(controls, '', 'Restore default color', 'bv-cmd-item-icon-btn');
			if (!renderMenuIcon(clearColor, 'rotate-ccw')) clearColor.setText('↺');
			clearColor.onclick = async () => {
				delete entry.color;
				colorInput.value = getDefaultColor();
				await this.plugin.saveSettings();
			};

			const replaceCommand = action(controls, '', 'Change command', 'bv-cmd-item-icon-btn');
			if (!renderMenuIcon(replaceCommand, 'search')) replaceCommand.setText('…');
			replaceCommand.onclick = () => {
				new CommandSuggestModal(this.app, async ({ id, name }) => {
					const previousName = this.commandNames.get(entry.commandId) ?? entry.commandName;
					if (!entry.commandId || !entry.label || entry.label === previousName) {
						entry.label = name;
					}
					entry.commandId = id;
					entry.commandName = name;
					this.commandNames.set(id, name);
					renderLabel();
					await this.plugin.saveSettings();
				}).open();
			};
		}

		const remove = action(controls, '', entry.isSeparator ? 'Remove separator' : 'Remove command', 'bv-cmd-item-icon-btn');
		if (!renderMenuIcon(remove, 'trash-2')) remove.setText('×');
		remove.onclick = async () => {
			list.splice(index, 1);
			await this.plugin.saveSettings();
			render();
		};
	}
}
