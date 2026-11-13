import { App, TFile } from 'obsidian';
import type { ManifestLink } from './ManifestParser';

/** A raw link extracted from a ```book-view code block. */
export interface RawCodeBlockLink {
	/** The link target as written (wikilink path or markdown href). */
	target: string;
	/** Optional display text (alias after `|` in wikilinks, or link text). */
	display?: string;
	/** Character offset of this link within the scanned (block) source, used
	 *  to jump the editor cursor to the matching source line on click. */
	offset: number;
	end: number;
}

/**
 * Extract links from the bare inner content passed by the code-block processor.
 * Use parseBookViewBlocks for a full note; never infer the input kind from
 * whether it happens to contain a book-view fence.
 *
 * Supported syntax inside the block:
 *   [[Target]]
 *   [[Target|Alias]]
 *   [Display Text](./relative-or-vault-path.md)
 *   [Display Text](note-name)
 *   plain text lines are ignored
 */
export function parseCodeBlockLinks(source: string, includePlaceholders = false): RawCodeBlockLink[] {
	const LINK_RE = /\[\[([^\]]*)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
	const results: RawCodeBlockLink[] = [];

	let m: RegExpExecArray | null;
	while ((m = LINK_RE.exec(source)) !== null) {
		if (m[1] !== undefined) {
			const pipe = m[1].indexOf('|');
			const target = (pipe === -1 ? m[1] : m[1].substring(0, pipe)).trim();
			const display = pipe === -1 ? undefined : m[1].substring(pipe + 1).trim();
			if (target || (includePlaceholders && m[1] === '')) {
				results.push({ target, display, offset: m.index, end: LINK_RE.lastIndex });
			}
		} else if (m[2] !== undefined && m[3] !== undefined) {
			const display = m[2].trim();
			const target = m[3].trim();
			if (target) results.push({ target, display: display || undefined, offset: m.index, end: LINK_RE.lastIndex });
		}
	}
	return results;
}

/** Scan note-body fences, ignoring other languages and nested fence examples. */
export interface BookViewBlock {
	from: number;
	to: number;
	indent: string;
}

export function findBookViewBlocks(source: string): BookViewBlock[] {
	const blocks: BookViewBlock[] = [];
	let fence: { marker: string; length: number; isBook: boolean; from: number; indent: string } | null = null;
	let offset = 0;
	for (const line of source.split('\n')) {
		const start = offset;
		offset += line.length + 1;
		const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(line);
		if (!fence) {
			if (!match) continue;
			const marks = match[1]!;
			const info = match[2]!.trim();
			if (marks[0] === '`' && info.includes('`')) continue;
			fence = { marker: marks[0]!, length: marks.length, isBook: info === 'book-view',
				from: Math.min(offset, source.length), indent: line.slice(0, line.indexOf(marks)) };
		} else if (match && match[1]![0] === fence.marker
			&& match[1]!.length >= fence.length && !match[2]!.trim()) {
			if (fence.isBook) blocks.push({ from: fence.from, to: start, indent: fence.indent });
			fence = null;
		}
	}
	if (fence?.isBook) blocks.push({ from: fence.from, to: source.length, indent: fence.indent });
	return blocks;
}

export function parseBookViewBlocks(source: string): RawCodeBlockLink[] {
	return findBookViewBlocks(source).flatMap(({ from, to }) => parseCodeBlockLinks(source.slice(from, to).replace(/\r?\n$/, '')));
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
