import type { App, TFile } from 'obsidian';
import { buildTocEntries, type TocEntry } from './entries';
import { stripYamlFrontmatter } from '../utils/content';

/** Read a heading's subtree in book order, including notes without headings. */
export async function readTocSection(app: App, files: TFile[], selected: TocEntry): Promise<string> {
	// Refresh boundaries at selection time; never silently copy another heading
	// if the outline has changed while the context menu was open.
	const entries = buildTocEntries(app, files);
	const index = entries.findIndex((entry) =>
		entry.file.path === selected.file.path && entry.line === selected.line &&
		entry.text === selected.text && entry.level === selected.level &&
		entry.fileHeadingIndex === selected.fileHeadingIndex,
	);
	if (index < 0) throw new Error('The heading changed. Reopen the menu and try again.');
	const end = entries.slice(index + 1).find((entry) => entry.level <= selected.level);
	const firstFile = files.findIndex((file) => file.path === selected.file.path);
	const lastFile = end ? files.findIndex((file) => file.path === end.file.path) : files.length - 1;
	const parts: string[] = [];
	for (let i = firstFile; i <= lastFile; i++) {
		const file = files[i];
		if (!file) continue;
		// A boundary at the start of the next note contributes no content.
		if (i !== firstFile && i === lastFile && end?.line === 0) break;
		const content = await app.vault.cachedRead(file);
		const lines = content.split('\n');
		const startLine = i === firstFile ? selected.line : 0;
		const endLine = i === lastFile && end ? end.line : lines.length;
		let part = lines.slice(startLine, endLine).join('\n');
		if (i !== firstFile) part = stripYamlFrontmatter(part).replace(/^(?:\r?\n)+/, '');
		// Remove boundary blank lines only, preserving Markdown hard breaks.
		part = part.replace(/(?:\r?\n)+$/, '');
		if (part.trim().length > 0) parts.push(part);
	}
	return parts.join('\n\n');
}
