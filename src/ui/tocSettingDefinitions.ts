import type BookViewPlugin from '../main';
import type { BookSettingDefinition } from './settingDefinitions';
export function tocSettingDefinitions(plugin: BookViewPlugin): BookSettingDefinition[] {
	return [
		{
			name: 'Auto-open for books',
			desc: 'Show the table of contents in the right sidebar automatically whenever a book is open. When disabled, the toc opens only via the "toggle book toc in right sidebar" command.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.tocAutoOpen)
					.onChange(async (value: boolean) => {
					plugin.settings.tocAutoOpen = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Focus toc when opening a book',
			desc: 'Make the toc panel the active view when switching to a book. When disabled, the panel opens but the book stays active.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.tocFocusOnBook)
					.onChange(async (value: boolean) => {
					plugin.settings.tocFocusOnBook = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Show file names',
			desc: 'Display file names as section headers in the table of contents.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.tocShowFileNames)
					.onChange(async (value: boolean) => {
					plugin.settings.tocShowFileNames = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Nesting guides',
			desc: 'Display vertical guide lines from headings to show nesting depth.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.tocGuides)
					.onChange(async (value: boolean) => {
					plugin.settings.tocGuides = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Render Markdown',
			desc: 'Render bold, italic, code and other inline Markdown in headings instead of showing raw syntax.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.tocRenderMarkdown)
					.onChange(async (value: boolean) => {
					plugin.settings.tocRenderMarkdown = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Default collapsed level',
			desc: 'Headings at this level and deeper are collapsed when opening a book. Set to off to disable.',
			render: (setting) => {
				setting
					.addDropdown((dd) => dd
					.addOption('0', 'Off')
					.addOption('1', 'H1')
					.addOption('2', 'H2')
					.addOption('3', 'H3')
					.addOption('4', 'H4')
					.addOption('5', 'H5')
					.addOption('6', 'H6')
					.setValue(String(plugin.settings.tocCollapsedLevel))
					.onChange(async (value: string) => {
					plugin.settings.tocCollapsedLevel = parseInt(value, 10);
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Collapse rest to level',
			desc: 'Collapse headings at this level and deeper outside the active section when using the setting level mode.',
			render: (setting) => {
				setting
					.addDropdown((dd) => dd
					.addOption('0', 'Off')
					.addOption('1', 'H1')
					.addOption('2', 'H2')
					.addOption('3', 'H3')
					.addOption('4', 'H4')
					.addOption('5', 'H5')
					.addOption('6', 'H6')
					.setValue(String(plugin.settings.tocCollapseRestLevel))
					.onChange(async (value: string) => {
					plugin.settings.tocCollapseRestLevel = parseInt(value, 10);
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Auto expand',
			desc: 'Automatically expand and collapse headings as you scroll or move the cursor.',
			render: (setting) => {
				setting
					.addDropdown((dropdown) => dropdown
					.addOption('expand-collapse-default', 'Expand and collapse rest to default')
					.addOption('only-expand', 'Only expand')
					.addOption('expand-collapse-level', 'Expand and collapse rest to setting level')
					.addOption('disabled', 'Disabled')
					.setValue(plugin.settings.autoExpandMode)
					.onChange(async (value: string) => {
					plugin.settings.autoExpandMode = value as import('../settings').AutoExpandMode;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Animate expand/collapse',
			desc: 'Smoothly glide and fade toc rows when a section opens or closes, and briefly highlight the toggled heading.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.tocExpandAnim)
					.onChange(async (value: boolean) => {
					plugin.settings.tocExpandAnim = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Disable animation above scroll speed',
			desc: 'Above this book scroll speed, row glides are skipped and sections snap instead. Fast flicks stay clean; at low speeds the animation is kept. Set to 0 to always animate.',
			render: (setting) => {
				setting
					.addSlider((slider) => slider
					.setLimits(0, 10000, 100)
					.setValue(plugin.settings.tocExpandAnimSpeedLimit)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
					plugin.settings.tocExpandAnimSpeedLimit = value;
					await plugin.saveSettings();
				}));
			},
		}
	];
}
