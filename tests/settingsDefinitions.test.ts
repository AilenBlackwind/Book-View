import { describe, expect, it, vi } from 'vitest';
import { App, Setting } from 'obsidian';
import { BookViewSettingTab } from '../src/ui/SettingsTab';
import { DEFAULT_SETTINGS } from '../src/settings';
import type BookViewPlugin from '../src/main';
import { generalSettingDefinitions } from '../src/ui/generalSettingDefinitions';

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<object>(),
	PluginSettingTab: class {},
}));
vi.mock('../src/ui/CommandSuggestModal', () => ({ CommandSuggestModal: class {}, IconSuggestModal: class {} }));

function plugin() {
	return { settings: structuredClone(DEFAULT_SETTINGS), saveSettings: vi.fn(() => Promise.resolve()),
		applyBookWidthSetting: vi.fn() };
}

describe('searchable settings', () => {
	it('exposes each settings section without accessing the DOM or saving during indexing', () => {
		const owner = plugin();
		const tab = new BookViewSettingTab(new App(), owner as unknown as BookViewPlugin);
		const definitions = tab.getSettingDefinitions();
		expect(definitions.map(({ type, name }) => ({ type, name }))).toEqual([
			{ type: 'page', name: 'General' },
			{ type: 'page', name: 'Table of contents' },
			{ type: 'page', name: 'Context menus' },
		]);
		const rows = definitions.flatMap((definition) => definition.items);
		expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining([
			'Book width', 'Wheel flick acceleration', 'Editor used on double-click',
			'Auto expand', 'Default collapsed level', 'Editor shortcut modifiers', 'Menu profiles',
		]));
		expect(owner.saveSettings).not.toHaveBeenCalled();
	});

	it('preserves plugin persistence and width side effects when a searched setting changes', async () => {
		const owner = plugin();
		const refresh = vi.fn();
		const definitions = generalSettingDefinitions(owner as unknown as BookViewPlugin, refresh);
		const width = definitions.find((row) => row.name === 'Book width')!;
		const custom = definitions.find((row) => row.name === 'Custom book width')!;
		expect(custom.visible?.()).toBe(false);
		let change: (value: string) => Promise<void> = async () => {};
		const dropdown = {
			addOption: () => dropdown, setValue: () => dropdown,
			onChange: (callback: typeof change) => { change = callback; return dropdown; },
		};
		width.render({ addDropdown: (build: (control: typeof dropdown) => void) => build(dropdown) } as unknown as Setting);
		await change('custom');
		expect(owner.settings.bookWidthMode).toBe('custom');
		expect(custom.visible?.()).toBe(true);
		expect(owner.saveSettings).toHaveBeenCalledOnce();
		expect(owner.applyBookWidthSetting).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it.each([false, true])('refreshes the appropriate UI for modern API support=%s', (modern) => {
		const tab = new BookViewSettingTab(new App(), plugin() as unknown as BookViewPlugin);
		const display = vi.spyOn(tab, 'display').mockImplementation(() => {});
		const update = vi.fn();
		if (modern) Object.assign(tab, { update });
		const refresh = (tab as unknown as { refreshSettings: () => void }).refreshSettings.bind(tab);
		refresh();
		expect(update).toHaveBeenCalledTimes(modern ? 1 : 0);
		expect(display).toHaveBeenCalledTimes(modern ? 0 : 1);
	});
});
