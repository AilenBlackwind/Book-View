import { describe, expect, it } from 'vitest';
import type { Hotkey } from 'obsidian';
import { collectCommandHotkeys, matchesHotkey, type CommandLike } from '../src/utils/hotkeys';

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
	return {
		key: '',
		code: '',
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		defaultPrevented: false,
		...init,
	} as unknown as KeyboardEvent;
}

function hotkey(modifiers: string[], key: string): Hotkey {
	return { modifiers: modifiers as Hotkey['modifiers'], key };
}

describe('matchesHotkey', () => {
	it('matches Mod+letter via Ctrl on non-macOS', () => {
		const hk = hotkey(['Mod'], 'b');
		expect(matchesHotkey(keyEvent({ key: 'b', code: 'KeyB', ctrlKey: true }), hk)).toBe(true);
	});

	it('does not match Mod when the wrong platform modifier is held', () => {
		const hk = hotkey(['Mod'], 'b');
		expect(matchesHotkey(keyEvent({ key: 'b', code: 'KeyB', metaKey: true }), hk)).toBe(false);
	});

	it('rejects mismatched modifier sets', () => {
		const hk = hotkey(['Mod', 'Shift'], 'b');
		expect(matchesHotkey(keyEvent({ key: 'b', code: 'KeyB', ctrlKey: true }), hk)).toBe(false);
		expect(matchesHotkey(keyEvent({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }), hk)).toBe(true);
	});

	it('falls back to event.code for non-Latin layouts', () => {
		const hk = hotkey(['Mod'], 'b');
		expect(matchesHotkey(keyEvent({ key: 'и', code: 'KeyB', ctrlKey: true }), hk)).toBe(true);
	});
});

describe('collectCommandHotkeys', () => {
	const cmd = (hotkeys?: Hotkey[], extra: Partial<CommandLike> = {}): CommandLike => ({ hotkeys, ...extra });

	it('uses declared default hotkeys when no overrides exist', () => {
		const result = collectCommandHotkeys(
			{ 'editor:toggle-bold': cmd([hotkey(['Mod'], 'b')]) },
			null,
		);
		expect(result).toEqual([{ commandId: 'editor:toggle-bold', hotkey: hotkey(['Mod'], 'b') }]);
	});

	it('prefers user overrides over declared defaults', () => {
		const result = collectCommandHotkeys(
			{ 'editor:toggle-bold': cmd([hotkey(['Mod'], 'b')]) },
			{ 'editor:toggle-bold': [hotkey(['Ctrl', 'Shift'], 'b')] },
		);
		expect(result).toEqual([{ commandId: 'editor:toggle-bold', hotkey: hotkey(['Ctrl', 'Shift'], 'b') }]);
	});

	it('treats an override set to an empty array as unbound', () => {
		const result = collectCommandHotkeys(
			{ 'editor:toggle-bold': cmd([hotkey(['Mod'], 'b')]) },
			{ 'editor:toggle-bold': [] },
		);
		expect(result).toEqual([]);
	});

	it('skips hotkeys without non-Shift modifiers', () => {
		const result = collectCommandHotkeys(
			{ 'a:plain': cmd([hotkey([], 't')]), 'a:shift': cmd([hotkey(['Shift'], 't')]) },
			null,
		);
		expect(result).toEqual([]);
	});

	it('lets the first registered command win a duplicate hotkey', () => {
		const result = collectCommandHotkeys(
			{
				'first:cmd': cmd([hotkey(['Mod'], 'k')]),
				'second:cmd': cmd([hotkey(['Ctrl'], 'k')]),
			},
			null,
		);
		expect(result).toEqual([{ commandId: 'first:cmd', hotkey: hotkey(['Mod'], 'k') }]);
	});

	it('emits one binding per distinct hotkey of the same command', () => {
		const result = collectCommandHotkeys(
			// Mod+X and Ctrl+X normalize to the same binding on non-macOS, so
			// use Alt for the second one.
			{ 'editor:toggle-bold': cmd([hotkey(['Mod'], 'b'), hotkey(['Alt'], 'b')]) },
			null,
		);
		expect(result).toHaveLength(2);
	});
});
