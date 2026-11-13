import { App, resolveSubpath, TFile } from 'obsidian';
import { findBookViewBlocks, parseCodeBlockLinks, resolveCodeBlockLinks, type BookViewBlock } from './CodeBlockParser';
import { frontmatterEndOffset, type ManifestLink } from './ManifestParser';

export interface ChapterListSource extends BookViewBlock {
	file: TFile;
	raw: string;
}

/** Expand only embeds, never links inside ordinary chapter notes. */
export async function collectManifestLinks(
	app: App,
	masterFile: TFile,
	rawContent?: string,
	sources = new Set<string>(),
	onList?: (list: ChapterListSource) => void,
): Promise<ManifestLink[]> {
	const links: ManifestLink[] = [];
	const seen = new Set<string>();
	const expanded = new Set<string>();
	const active = new Set<string>();
	const reads = new Map<string, string>();
	if (rawContent !== undefined) reads.set(masterFile.path, rawContent);

	async function visit(file: TFile, subpath = ''): Promise<void> {
		sources.add(file.path);
		const key = `${file.path}\n${subpath}`;
		if (expanded.has(key) || active.has(file.path) || active.size >= 100) return;
		expanded.add(key);
		active.add(file.path);
		try {
			const cache = app.metadataCache.getFileCache(file);
			let raw = reads.get(file.path);
			if (raw === undefined) {
				try {
					raw = await app.vault.cachedRead(file);
					reads.set(file.path, raw);
				} catch {
					// Keep cached links available if the file disappeared during a read.
					raw = '';
				}
			}
			let start = frontmatterEndOffset(raw);
			let end = raw.length || Infinity;
			if (subpath) {
				const range = cache && resolveSubpath(cache, subpath);
				if (!range) return;
				start = Math.max(start, range.start.offset);
				end = range.end?.offset ?? end;
			}
			const entries = [
				...(cache?.links ?? []).map((link) => ({ link, embed: false })),
				...(cache?.embeds ?? []).map((link) => ({ link, embed: true })),
			].sort((a, b) => (a.link.position?.start?.offset ?? -1) - (b.link.position?.start?.offset ?? -1));
			for (const { link, embed } of entries) {
				const pos = link.position?.start?.offset ?? -1;
				if (pos >= 0 && (pos < start || pos >= end)) continue;
				const hash = link.link.indexOf('#');
				const target = hash < 0 ? link.link : link.link.slice(0, hash);
				const resolved = target
					? app.metadataCache.getFirstLinkpathDest(target, file.path)
					: file;
				if (embed && resolved instanceof TFile && resolved.extension !== 'md') continue;
				if (!(resolved instanceof TFile) || resolved.extension !== 'md') {
					const brokenKey = `${file.path}\n${link.link}`;
					if (!seen.has(brokenKey)) {
						seen.add(brokenKey);
						links.push({ type: 'broken', display: link.original });
					}
					continue;
				}
				if (embed) {
					await visit(resolved, hash < 0 ? '' : link.link.slice(hash));
					continue;
				}
				if (seen.has(resolved.path)) continue;
				seen.add(resolved.path);
				links.push({ type: resolved.stat.size === 0 ? 'empty' : 'file', file: resolved });
			}
			// Preserve the existing priority: body links precede book-view blocks.
			for (const block of findBookViewBlocks(raw.slice(start, end))) {
				const from = start + block.from;
				const to = start + block.to;
				onList?.({ ...block, from, to, file, raw });
				links.push(...resolveCodeBlockLinks(app, file, parseCodeBlockLinks(raw.slice(from, to)), seen));
			}
		} finally {
			active.delete(file.path);
		}
	}
	await visit(masterFile);
	return links;
}
