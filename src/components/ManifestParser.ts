import { App, TFile } from 'obsidian';

export type ManifestLink =
	| { type: 'file'; file: TFile }
	| { type: 'broken'; display: string }
	| { type: 'empty'; file: TFile };

export function isBookManifest(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache?.frontmatter) return false;
	const value = cache.frontmatter['book-view'] as unknown;
	return value === true || value === 'true';
}

export function getManifestLinks(app: App, masterFile: TFile): ManifestLink[] {
	const cache = app.metadataCache.getFileCache(masterFile);
	if (!cache?.links) return [];

	const links: ManifestLink[] = [];
	const seen = new Set<string>();

	for (const link of cache.links) {
		const resolved = app.metadataCache.getFirstLinkpathDest(
			link.link,
			masterFile.path,
		);

		if (!(resolved instanceof TFile) || resolved.extension !== 'md') {
			if (!seen.has(link.link)) {
				seen.add(link.link);
				links.push({ type: 'broken', display: link.original });
			}
			continue;
		}

		if (seen.has(resolved.path)) continue;
		seen.add(resolved.path);

		const fileCache = app.metadataCache.getFileCache(resolved);
		const content = app.vault.getFileByPath(resolved.path);
		if (content && content.stat.size === 0) {
			links.push({ type: 'empty', file: resolved });
		} else if (content && (!fileCache?.sections || fileCache.sections.length === 0)) {
			links.push({ type: 'empty', file: resolved });
		} else {
			links.push({ type: 'file', file: resolved });
		}
	}

	return links;
}

export function getManifestFiles(app: App, masterFile: TFile): TFile[] {
	return getManifestLinks(app, masterFile)
		.filter((l): l is { type: 'file'; file: TFile } => l.type === 'file')
		.map((l) => l.file);
}
