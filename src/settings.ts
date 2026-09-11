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

/** Which editor double-click opens a note in: the in-window popup (a detached
 *  native WorkspaceLeaf embedded in the modal — real Live Preview, no separate
 *  window) or the native editor in a separate popout window (full Obsidian
 *  Editor API, so editor scripts run). */
export type EditorMode = 'popup' | 'native';

/** Book container width source: 'obsidian' follows the vault's readable line
 *  length (--file-line-width, the same variable regular notes use), 'custom'
 *  overrides it with bookWidth px. */
export type BookWidthMode = 'obsidian' | 'custom';

/** Sane limits for the custom book width (px). */
export const BOOK_WIDTH_MIN = 400;
export const BOOK_WIDTH_MAX = 1600;

import type { AutoExpandMode } from './toc/types';

export type { AutoExpandMode } from './toc/types';

export interface BookViewSettings {
	tocShowFileNames: boolean;
	tocGuides: boolean;
	tocRenderMarkdown: boolean;
	tocCollapsedLevel: number;
	autoExpandMode: AutoExpandMode;
	tocCollapseRestLevel: number;
	tocAutoOpen: boolean;
	tocFocusOnBook: boolean;
	loadMargin: number;
	wheelFlickEnabled: boolean;
	wheelFlickStrength: number;
	wheelFlickFriction: number;
	wheelFlickPrecision: boolean;
	wheelShieldEnabled: boolean;
	menuProfiles: MenuProfile[];
	editorModifiers: ModifierConfig;
	editorMode: EditorMode;
	popupHideFrontmatter: boolean;
	cssHasWarningEnabled: boolean;
	bookWidthMode: BookWidthMode;
	bookWidth: number;
	tocExpandAnim: boolean;
}

export const DEFAULT_SETTINGS: BookViewSettings = {
	tocShowFileNames: true,
	tocGuides: true,
	tocRenderMarkdown: true,
	tocCollapsedLevel: 0,
	autoExpandMode: 'disabled',
	tocCollapseRestLevel: 0,
	tocAutoOpen: true,
	tocFocusOnBook: true,
	loadMargin: 400,
	wheelFlickEnabled: true,
	wheelFlickStrength: 2,
	wheelFlickFriction: 0.92,
	wheelFlickPrecision: true,
	wheelShieldEnabled: true,
	menuProfiles: [
		{ name: 'Main', modifiers: { alt: false, ctrl: false, shift: false, meta: false }, scripts: [] },
	],
	editorModifiers: { alt: false, ctrl: true, shift: false, meta: false },
	editorMode: 'popup',
	popupHideFrontmatter: false,
	cssHasWarningEnabled: true,
	bookWidthMode: 'obsidian',
	bookWidth: 750,
	tocExpandAnim: true,
};
