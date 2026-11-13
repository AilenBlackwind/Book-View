import { App, TFile } from 'obsidian';
import { collectManifestLinks } from './EmbeddedManifest';

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

/** CSS classes declared on a note's frontmatter via `cssclasses` (or the
 *  legacy `cssclass` key). Obsidian accepts a YAML list or a comma-separated
 *  string; both are normalized into a clean, deduplicated array. Used to
 *  scope book-specific CSS snippets to a single book render. */
export function cssClassesFromFrontmatter(
	fm: Record<string, unknown> | null | undefined,
): string[] {
	if (!fm) return [];
	const read = (key: string): string[] => {
		const value = fm[key];
		if (typeof value === 'string') return value.split(',').map((s) => s.trim());
		if (Array.isArray(value)) {
			return value.map((s) => (typeof s === 'string' ? s.trim() : String(s ?? '').trim()));
		}
		return [];
	};
	const out = [...read('cssclasses'), ...read('cssclass')];
	return [...new Set(out.filter((s) => s.length > 0))];
}

/**
 * The character offset where a note's YAML frontmatter block ends (i.e. where
 * the body begins), or 0 when the note has no frontmatter.  Used to exclude
 * links declared in the frontmatter (e.g. a `chapters:` list) from the book's
 * section list — those are book metadata, not sections to render.
 */
export function frontmatterEndOffset(content: string): number {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!match) return 0;
	return match[0].length;
}

/** Collect chapters, expanding embedded lists and tracking their source notes. */
export async function getManifestLinks(
	app: App,
	masterFile: TFile,
	rawContent?: string,
	sources?: Set<string>,
): Promise<ManifestLink[]> {
	return collectManifestLinks(app, masterFile, rawContent, sources);
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
