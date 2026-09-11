import { App, Notice, TFile, TFolder } from 'obsidian';

/** Collect every markdown note recursively under `folder` (files in nested
 *  folders included). Used to build a book manifest from a folder tree. */
export function collectMarkdownFiles(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (dir: TFolder): void => {
		for (const child of dir.children) {
			if (child instanceof TFolder) {
				walk(child);
			} else if (child instanceof TFile && child.extension === 'md') {
				out.push(child);
			}
		}
	};
	walk(folder);
	return out;
}

/** Render the manifest note body: `book-view: true` frontmatter, a title and
 *  one vault-relative wikilink per note, sorted alphabetically (natural
 *  ordering, case-insensitive — nested folders sort inside their parent by
 *  the same key). The manifest itself is never linked. */
export function buildManifestContent(
	folderName: string,
	files: { path: string }[],
	manifestPath: string,
): string {
	const sorted = files
		.filter((f) => f.path !== manifestPath)
		.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
	const links = sorted.map((f) => `[[${f.path.slice(0, -3)}]]`);
	return ['---', 'book-view: true', '---', '', `# ${folderName}`, '', ...links, ''].join('\n');
}

/** The manifest filename for a folder: `<folder name> Book.md` (vault root —
 *  where the folder has no name — falls back to `Book.md`). */
export function manifestFilename(folder: TFolder): string {
	const base = folder.name ? `${folder.name} Book` : 'Book';
	return `${base}.md`;
}

/** Create (or overwrite) the `<folder> Book.md` manifest inside `folder`,
 *  linking every markdown note below it in alphabetical order. Returns the
 *  manifest path, or null (with a Notice) when the folder has no notes. */
export async function createBookForFolder(app: App, folder: TFolder): Promise<string | null> {
	const files = collectMarkdownFiles(folder);
	if (files.length === 0) {
		new Notice('No Markdown notes found in this folder.');
		return null;
	}

	const name = manifestFilename(folder);
	const manifestPath = folder.path ? `${folder.path}/${name}` : name;
	const content = buildManifestContent(
		folder.name ? folder.name : 'Book',
		files,
		manifestPath,
	);

	const existing = app.vault.getAbstractFileByPath(manifestPath);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
	} else {
		await app.vault.create(manifestPath, content);
	}

	return manifestPath;
}