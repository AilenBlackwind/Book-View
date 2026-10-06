import { Setting } from 'obsidian';

// Structural subset of Obsidian 1.13's declarative API. Type-only compatibility
// keeps the plugin buildable with older Obsidian typings and runtimes.
export interface BookSettingDefinition {
	name: string;
	desc?: string;
	visible?: () => boolean;
	render: (setting: Setting) => void;
}

export interface BookSettingGroup {
	type: 'group';
	heading: string;
	items: BookSettingDefinition[];
}

/** Legacy settings UI uses the very same names, descriptions and callbacks. */
export function renderSettingDefinitions(container: HTMLElement, definitions: BookSettingDefinition[]): void {
	for (const definition of definitions) {
		if (definition.visible && !definition.visible()) continue;
		const setting = new Setting(container).setName(definition.name);
		if (definition.desc) setting.setDesc(definition.desc);
		definition.render(setting);
	}
}
