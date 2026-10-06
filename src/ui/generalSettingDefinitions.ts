import type BookViewPlugin from '../main';
import type { BookSettingDefinition } from './settingDefinitions';
import type { BookWidthMode, EditorMode } from '../settings';
import { BOOK_WIDTH_MIN, BOOK_WIDTH_MAX } from '../settings';
export function generalSettingDefinitions(plugin: BookViewPlugin, refresh: () => void): BookSettingDefinition[] {
	return [
		{
			name: 'Reading',
			render: (setting) => {
				setting
					.setHeading();
			},
		},
		{
			name: 'Book width',
			desc: 'Container width for book content. Match notes follows the vault readable line length setting, the same width regular notes use.',
			render: (setting) => {
				setting
					.addDropdown((drop) => drop
					.addOption('obsidian', 'Match notes')
					.addOption('custom', 'Custom')
					.setValue(plugin.settings.bookWidthMode)
					.onChange(async (value: string) => {
					plugin.settings.bookWidthMode = value as BookWidthMode;
					await plugin.saveSettings();
					plugin.applyBookWidthSetting();
					// Re-render so the custom-width slider only appears in
					// custom mode.
					refresh();
				}));
			},
		},
		{
			name: 'Custom book width',
			desc: 'Book container width in pixels.',
			visible: () => plugin.settings.bookWidthMode === 'custom',
			render: (setting) => {
				setting
					.addSlider((slider) => slider
					.setLimits(BOOK_WIDTH_MIN, BOOK_WIDTH_MAX, 10)
					.setValue(plugin.settings.bookWidth)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
					plugin.settings.bookWidth = value;
					await plugin.saveSettings();
					plugin.applyBookWidthSetting();
				}));
			},
		},
		{
			name: 'Lazy load margin',
			desc: 'How many pixels above and below the viewport to pre-load sections. Increase for slower devices, decrease for faster ones.',
			render: (setting) => {
				setting
					.addSlider((slider) => slider
					.setLimits(0, 3000, 50)
					.setValue(plugin.settings.loadMargin)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
					plugin.settings.loadMargin = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Warn about expensive CSS :has() selectors',
			desc: 'Scan your enabled CSS snippets for :has() selectors that make Obsidian recalculate styles across the whole app on every section mount, and warn once per session when one is found. Sibling-scoped :has(+ X) selectors are safe and are not reported. Selectors from themes and other plugins are only logged to the console.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.cssHasWarningEnabled)
					.onChange(async (value: boolean) => {
					plugin.settings.cssHasWarningEnabled = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Wheel flick',
			render: (setting) => {
				setting
					.setHeading();
			},
		},
		{
			name: 'Wheel flick acceleration',
			desc: 'Inside book view, turn mouse wheel notches into smooth accelerated flicks. Off uses native scrolling (precision mode does not apply).',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.wheelFlickEnabled)
					.onChange(async (value: boolean) => {
					plugin.settings.wheelFlickEnabled = value;
					await plugin.saveSettings();
					refresh();
				}));
			},
		},
		{
			name: 'Wheel flick precision mode',
			desc: 'Disable combo stacking: every notch travels exactly the same distance regardless of timing. Best for precise short scrolls. Applies only when wheel flick acceleration is on.',
			render: (setting) => {
				setting
					.setDisabled(!plugin.settings.wheelFlickEnabled)
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.wheelFlickPrecision)
					.onChange(async (value: boolean) => {
					plugin.settings.wheelFlickPrecision = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Shield wheel from other plugins',
			desc: 'Hide wheel events over the book from other plugins (smooth-scroll tools) that animate scrolling and break it. Keep this on while such plugins are installed: their writes are blocked inside the book anyway, so without the shield they would cancel native scrolling and freeze it instead.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.wheelShieldEnabled)
					.onChange(async (value: boolean) => {
					plugin.settings.wheelShieldEnabled = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Wheel flick strength',
			desc: 'Total scroll distance per notch, as a multiple of the native amount.',
			render: (setting) => {
				setting
					.addSlider((slider) => slider
					.setLimits(1, 5, 0.25)
					.setValue(plugin.settings.wheelFlickStrength)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
					plugin.settings.wheelFlickStrength = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Wheel flick smoothness',
			desc: 'How long the flick glides. Higher values glide longer.',
			render: (setting) => {
				setting
					.addSlider((slider) => slider
					.setLimits(0.85, 0.97, 0.01)
					.setValue(plugin.settings.wheelFlickFriction)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
					plugin.settings.wheelFlickFriction = value;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Editor',
			render: (setting) => {
				setting
					.setHeading();
			},
		},
		{
			name: 'Editor used on double-click',
			desc: 'Open a section note in the in-window popup editor, or in the native editor in a separate popout window. The native editor in a popout window is available in case of unexpected issues.',
			render: (setting) => {
				setting
					.addDropdown((dd) => dd
					.addOption('popup', 'Popup editor (in-window)')
					.addOption('native', 'Native editor (popout)')
					.setValue(plugin.settings.editorMode)
					.onChange(async (value: string) => {
					plugin.settings.editorMode = value as EditorMode;
					await plugin.saveSettings();
				}));
			},
		},
		{
			name: 'Hide frontmatter in popup editor',
			desc: 'Hide the YAML frontmatter block while editing in the popup editor, so notes start from the first heading.',
			render: (setting) => {
				setting
					.addToggle((toggle) => toggle
					.setValue(plugin.settings.popupHideFrontmatter)
					.onChange(async (value: boolean) => {
					plugin.settings.popupHideFrontmatter = value;
					await plugin.saveSettings();
				}));
			},
		}
	];
}
