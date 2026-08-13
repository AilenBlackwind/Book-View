import { App, TFile } from 'obsidian';

export interface TocEntry {
	level: number;
	text: string;
	file: TFile;
	line: number;
	fileHeadingIndex: number;
}

/** Flattened heading list across all book files, in render order. The DOM
 *  builder decides whether files get wrapper elements (tocShowFileNames); the
 *  entries themselves are file-agnostic. */
export function buildTocEntries(app: App, files: TFile[]): TocEntry[] {
	const entries: TocEntry[] = [];
	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		if (!cache?.headings) continue;
		for (let i = 0; i < cache.headings.length; i++) {
			const heading = cache.headings[i];
			if (!heading) continue;
			entries.push({
				level: heading.level,
				text: heading.heading,
				file,
				line: heading.position.start.line,
				fileHeadingIndex: i,
			});
		}
	}
	return entries;
}

/** Lookup from `${path}#${line}` to ToC entry index (built once per build). */
export function buildEntryByPathLine(entries: TocEntry[]): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		map.set(`${entry.file.path}#${entry.line}`, i);
	}
	return map;
}
