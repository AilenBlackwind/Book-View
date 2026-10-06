import type { Vault } from 'obsidian';

/** Find a free output path without replacing any existing file or folder. */
export function uniqueMarkdownPath(vault: Vault, preferredPath: string): string {
	const base = preferredPath.replace(/\.md$/, '');
	let candidate = preferredPath;
	for (let suffix = 2; vault.getAbstractFileByPath(candidate); suffix++) {
		candidate = `${base} (${suffix}).md`;
	}
	return candidate;
}
