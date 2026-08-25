import { App, TFile } from 'obsidian';
import {
	parseCodeBlockLinks,
	resolveCodeBlockLinks,
} from './CodeBlockParser';

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

/**
 * Collect all links that define the book's ordered section list.
 *
 * Two sources are combined:
 *  1. `cache.links` — Obsidian's metadata-cache entries for `[[wikilinks]]`
 *     and `[markdown](links)` in the note body (these appear in the graph).
 *  2. Links inside ` ```book-view ``` fenced code blocks — parsed from the
 *     raw file content so they are invisible to Obsidian's graph view.
 *
 * Both sets are deduplicated by resolved path; whichever source mentions a
 * path first wins.  The code-block pass is intentionally sequenced after the
 * cache pass so that "real" links keep their priority.
 */
export async function getManifestLinks(
	app: App,
	masterFile: TFile,
	rawContent?: string,
): Promise<ManifestLink[]> {
	const cache = app.metadataCache.getFileCache(masterFile);
	const links: ManifestLink[] = [];
	const seen = new Set<string>();

	// ── Pass 1: regular metadata-cache links ──────────────────────────
	if (cache?.links) {
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

			const content = app.vault.getFileByPath(resolved.path);
			if (content && content.stat.size === 0) {
				links.push({ type: 'empty', file: resolved });
			} else {
				links.push({ type: 'file', file: resolved });
			}
		}
	}

	// ── Pass 2: ```book-view fenced code blocks ───────────────────────
	try {
		const raw = rawContent ?? await app.vault.cachedRead(masterFile);
		const rawLinks = parseCodeBlockLinks(raw);
		if (rawLinks.length > 0) {
			links.push(
				...resolveCodeBlockLinks(app, masterFile, rawLinks, seen),
			);
		}
	} catch {
		// File may have been deleted between the cache hit and this read;
		// silently skip code-block links — the regular links still stand.
	}

	return links;
}

export async function getManifestFiles(
	app: App,
	masterFile: TFile,
	rawContent?: string,
): Promise<TFile[]> {
	return (await getManifestLinks(app, masterFile, rawContent))
		.filter((l): l is { type: 'file'; file: TFile } => l.type === 'file')
		.map((l) => l.file);
}
