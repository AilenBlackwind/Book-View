export interface ScriptEntry {
	label: string;
	commandId: string;
	icon?: string;
	color?: string;
	isSeparator?: boolean;
}

export interface ModifierConfig {
	alt: boolean;
	ctrl: boolean;
	shift: boolean;
	meta: boolean;
}

export interface MenuProfile {
	name: string;
	modifiers: ModifierConfig;
	scripts: ScriptEntry[];
}

export type AutoExpandMode = 'expand-collapse-default' | 'only-expand' | 'expand-collapse-level' | 'disabled';

export interface BookViewSettings {
	tocShowFileNames: boolean;
	tocGuides: boolean;
	tocRenderMarkdown: boolean;
	tocActiveColor: string;
	tocCollapsedLevel: number;
	autoExpandMode: AutoExpandMode;
	tocAutoOpen: boolean;
	tocFocusOnBook: boolean;
	loadMargin: number;
	wheelFlickEnabled: boolean;
	wheelFlickStrength: number;
	wheelFlickFriction: number;
	menuProfiles: MenuProfile[];
	editorModifiers: ModifierConfig;
}

export const DEFAULT_SETTINGS: BookViewSettings = {
	tocShowFileNames: true,
	tocGuides: true,
	tocRenderMarkdown: true,
	tocActiveColor: '',
	tocCollapsedLevel: 0,
	autoExpandMode: 'disabled',
	tocAutoOpen: true,
	tocFocusOnBook: true,
	loadMargin: 800,
	wheelFlickEnabled: true,
	wheelFlickStrength: 2,
	wheelFlickFriction: 0.92,
	menuProfiles: [
		{ name: 'Main', modifiers: { alt: false, ctrl: false, shift: false, meta: false }, scripts: [] },
	],
	editorModifiers: { alt: false, ctrl: true, shift: false, meta: false },
};
