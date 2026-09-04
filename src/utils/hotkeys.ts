import type { Hotkey } from 'obsidian';
import { Platform } from 'obsidian';

/** Shape of a command entry from the internal `app.commands.commands`
 *  registry; the registry itself is omitted from the `App` typings. */
export interface CommandLike {
	id?: string;
	hotkeys?: Hotkey[];
	callback?: unknown;
	checkCallback?: unknown;
	editorCallback?: unknown;
	editorCheckCallback?: unknown;
}

/** One resolved binding: a hotkey and the command it should run. */
export interface HotkeyCommand {
	commandId: string;
	hotkey: Hotkey;
}

/** Match a KeyboardEvent against an Obsidian hotkey ({modifiers, key}).
 *  Modifier semantics follow Obsidian: 'Mod' is Cmd on macOS, Ctrl elsewhere.
 *  Key matching tries `event.key` first (digits, symbols, arrows, F-keys),
 *  then falls back to `event.code` for letter keys, which stays correct on
 *  non-Latin layouts where `event.key` is localized. */
export function matchesHotkey(evt: KeyboardEvent, hk: Hotkey): boolean {
	const want = hk.modifiers ?? [];
	const wantMod = want.includes('Mod');
	const wantCtrl = want.includes('Ctrl');
	const wantMeta = want.includes('Meta');
	if (evt.shiftKey !== want.includes('Shift')) return false;
	if (evt.altKey !== want.includes('Alt')) return false;
	const isMac = Platform.isMacOS;
	if (wantMod ? (isMac ? !evt.metaKey : !evt.ctrlKey) : ((evt.ctrlKey && !wantCtrl) || (evt.metaKey && !wantMeta))) return false;
	if (wantCtrl && !evt.ctrlKey) return false;
	if (wantMeta && !evt.metaKey) return false;
	const key = hk.key.toLowerCase();
	if (evt.key.toLowerCase() === key) return true;
	return evt.code === 'Key' + key.toUpperCase();
}

/** Modifierless hotkeys (plain letters/digits) are excluded from popover
 *  forwarding so the capture listener can never swallow normal typing. */
function hasRealModifier(hk: Hotkey): boolean {
	const mods = hk.modifiers ?? [];
	return mods.includes('Mod') || mods.includes('Ctrl') || mods.includes('Meta') || mods.includes('Alt');
}

function hotkeyIdentity(hk: Hotkey): string {
	// Normalize 'Mod' to its platform meaning so Mod+X and Ctrl+X (or Cmd+X
	// on macOS) are treated as the same binding when deduplicating.
	const modOf = (m: string): string => (m === 'Mod' ? (Platform.isMacOS ? 'Meta' : 'Ctrl') : m);
	const mods = [...(hk.modifiers ?? [])].map(modOf).sort().join('+');
	return `${mods}+${hk.key.toLowerCase()}`;
}

/** Build the hotkey → command bindings for the popover's hotkey forwarding.
 *  Resolution mirrors Obsidian's keymap: entries in `overrides` (read from
 *  `<configDir>/hotkeys.json`) replace the command's declared `hotkeys`; an
 *  override set to an empty array means the user unbound the command and
 *  nothing is forwarded. The first registered command wins for a duplicate
 *  hotkey, matching the dispatch order of Obsidian's own keymap. */
export function collectCommandHotkeys(
	commands: Record<string, CommandLike>,
	overrides: Record<string, Hotkey[]> | null,
): HotkeyCommand[] {
	const taken = new Set<string>();
	const result: HotkeyCommand[] = [];
	for (const id of Object.keys(commands)) {
		const cmd = commands[id];
		if (!cmd) continue;
		const hotkeys = overrides && id in overrides ? overrides[id] : cmd.hotkeys;
		if (!Array.isArray(hotkeys)) continue;
		for (const hk of hotkeys) {
			if (!hk || typeof hk.key !== 'string' || !hasRealModifier(hk)) continue;
			const identity = hotkeyIdentity(hk);
			if (taken.has(identity)) continue;
			taken.add(identity);
			result.push({ commandId: id, hotkey: hk });
		}
	}
	return result;
}
