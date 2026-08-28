import { App, TFile } from 'obsidian';
import type { ManifestLink } from './ManifestParser';

/** A raw link extracted from a ```book-view code block. */
interface RawCodeBlockLink {
	/** The link target as written (wikilink path or markdown href). */
	target: string;
	/** Optional display text (alias after `|` in wikilinks, or link text). */
	display?: string;
}

/**
 * Parse ```book-view fenced code blocks and extract links from their content.
 *
 * When `source` is the full file text, only material inside ```book-view
 * fences is scanned — links elsewhere (frontmatter `chapters:` lists, the
 * note body) are deliberately ignored.  When `source` is already the bare
 * inner content of a book-view block (as passed by the code-block processor),
 * the whole string is scanned.
 *
 * Supported syntax inside the block:
 *   [[Target]]
 *   [[Target|Alias]]
 *   [Display Text](./relative-or-vault-path.md)
 *   [Display Text](note-name)
 *   plain text lines are ignored
 */
export function parseCodeBlockLinks(source: string): RawCodeBlockLink[] {
	const LINK_RE = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
	const results: RawCodeBlockLink[] = [];

	// Collect the regions to scan: inside book-view fences when the input has
	// any, otherwise the whole input.
	const regions: string[] = [];
	const blockRe = /```book-view[\r\n]+([\s\S]*?)(?:```|$)/g;
	let hasFence = false;
	let bm: RegExpExecArray | null;
	while ((bm = blockRe.exec(source)) !== null) {
		hasFence = true;
		if (bm[1] !== undefined) regions.push(bm[1]);
	}
	if (!hasFence) regions.push(source);

	for (const region of regions) {
		let m: RegExpExecArray | null;
		LINK_RE.lastIndex = 0;
		while ((m = LINK_RE.exec(region)) !== null) {
			if (m[1] !== undefined) {
				const pipe = m[1].indexOf('|');
				const target = (pipe === -1 ? m[1] : m[1].substring(0, pipe)).trim();
				const display = pipe === -1 ? undefined : m[1].substring(pipe + 1).trim();
				if (target) results.push({ target, display });
			} else if (m[2] !== undefined && m[3] !== undefined) {
				const display = m[2].trim();
				const target = m[3].trim();
				if (target) results.push({ target, display: display || undefined });
			}
		}
	}
	return results;
}

/**
 * Resolve raw code-block links into ManifestLink entries (identical
 * semantics to the links extracted from the metadata cache).  Duplicates
 * are deduplicated by resolved path, and the `seen` set can be pre-seeded
 * with paths already consumed by the regular cache.links pass so the two
 * never overlap.
 */
export function resolveCodeBlockLinks(
	app: App,
	masterFile: TFile,
	rawLinks: RawCodeBlockLink[],
	seen: Set<string>,
): ManifestLink[] {
	const links: ManifestLink[] = [];

	for (const raw of rawLinks) {
		const resolved = app.metadataCache.getFirstLinkpathDest(
			raw.target,
			masterFile.path,
		);

		if (!(resolved instanceof TFile) || resolved.extension !== 'md') {
			if (!seen.has(raw.target)) {
				seen.add(raw.target);
				links.push({
					type: 'broken',
					display: raw.display ?? raw.target,
				});
			}
			continue;
		}

		if (seen.has(resolved.path)) continue;
		seen.add(resolved.path);

		const file = app.vault.getFileByPath(resolved.path);
		if (file && file.stat.size === 0) {
			links.push({ type: 'empty', file: resolved });
		} else {
			links.push({ type: 'file', file: resolved });
		}
	}

	return links;
}
