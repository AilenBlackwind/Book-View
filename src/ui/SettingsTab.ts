import { App, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type BookViewPlugin from '../main';
import type { ModifierConfig, MenuProfile } from '../settings';
import { CommandSuggestModal, IconSuggestModal } from './CommandSuggestModal';

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

	constructor(app: App, plugin: BookViewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Table of contents')
			.setHeading();

		new Setting(containerEl)
			.setName('Width')
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
			.setName('Show file names')
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
			.setName('Nesting guides')
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
			.setName('Render Markdown')
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
			.setName('Active heading color')
			.setDesc('Color of the highlight behind the active heading. Leave empty for the default accent color.')
			.addColorPicker((picker) =>
				picker
					.setValue(this.plugin.settings.tocActiveColor || '#000000')
					.onChange(async (value: string) => {
						this.plugin.settings.tocActiveColor = value;
						await this.plugin.saveSettings();
					}),
			)
			.addButton((btn) => {
				btn.setIcon('x').setTooltip('Reset to default').onClick(async () => {
					this.plugin.settings.tocActiveColor = '';
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('Default collapsed level')
			.setDesc('Headings at this level and deeper are collapsed when opening a book. Set to off to disable.')
			.addDropdown((dd) =>
				dd
					.addOption('0', 'Off')
					.addOption('1', 'H1')
					.addOption('2', 'H2')
					.addOption('3', 'H3')
					.addOption('4', 'H4')
					.addOption('5', 'H5')
					.addOption('6', 'H6')
					.setValue(String(this.plugin.settings.tocCollapsedLevel))
					.onChange(async (value: string) => {
						this.plugin.settings.tocCollapsedLevel = parseInt(value, 10);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Auto expand')
			.setDesc('Auto expand and collapse headings when scrolling and cursor position change.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('expand-collapse-default', 'Expand and collapse rest to default')
					.addOption('only-expand', 'Only expand')
					.addOption('expand-collapse-level', 'Expand and collapse rest to setting level')
					.addOption('disabled', 'Disabled')
					.setValue(this.plugin.settings.autoExpandMode)
					.onChange(async (value: string) => {
						this.plugin.settings.autoExpandMode = value as import('../settings').AutoExpandMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Reading')
			.setHeading();

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
			.setName('Wheel flick')
			.setHeading();

		new Setting(containerEl)
			.setName('Wheel flick acceleration')
			.setDesc('Inside book view, turn mouse wheel notches into smooth accelerated flicks.')
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

		this.renderSingleModifier(containerEl, 'Popout editor shortcut', 'Modifier keys required to open the native editor in a popout window on double-click.', 'editorModifiers');
		this.renderMenuProfiles(containerEl);
	}

	private renderSingleModifier(containerEl: HTMLElement, heading: string, description: string, key: 'editorModifiers'): void {
		new Setting(containerEl)
			.setName(heading)
			.setHeading();

		containerEl.createEl('p', {
			text: description,
			cls: 'setting-item-description',
		});

		const mod = this.plugin.settings[key];
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
		new Setting(containerEl)
			.setName('Menu profiles')
			.setHeading();

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
