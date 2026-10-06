import { App, Notice, TFile } from 'obsidian';
import { getManifestFiles } from './ManifestParser';
import { uniqueMarkdownPath } from '../utils/uniquePath';

/** Save a fresh manuscript alongside its source book, preserving earlier exports. */
export async function collectManuscript(app: App, manifestFile: TFile): Promise<void> {
	const files = await getManifestFiles(app, manifestFile);
	if (files.length === 0) {
		new Notice('No linked notes found in this book.');
		return;
	}

	const parts: string[] = [];
	for (const file of files) {
		const content = await app.vault.cachedRead(file);
		const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n?/, '');
		parts.push(stripped.trimEnd());
	}

	const folder = manifestFile.parent?.path;
	const name = `${manifestFile.basename} — Manuscript.md`;
	const outputPath = uniqueMarkdownPath(app.vault, folder ? `${folder}/${name}` : name);
	await app.vault.create(outputPath, parts.join('\n\n'));
	new Notice(`Manuscript saved: ${outputPath}`);
}
