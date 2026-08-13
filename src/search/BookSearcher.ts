import { App, TFile } from 'obsidian';
import { SearchHit, searchLines } from './matcher';

/**
 * Searches every file of the book. Prefers the in-memory raw content held by
 * the section pool (already-read sections), falling back to `vault.cachedRead`
 * for files the lazy loader has not touched yet.
 */
export class BookSearcher {
	constructor(
		private app: App,
		private files: TFile[],
		private readRawContent: (path: string) => string | null,
	) {}

	async search(query: string, maxResults = 200): Promise<SearchHit[]> {
		const hits: SearchHit[] = [];
		for (const file of this.files) {
			if (hits.length >= maxResults) break;
			let content = this.readRawContent(file.path);
			if (content === null || content === undefined) {
				content = await this.app.vault.cachedRead(file);
			}
			const partial = searchLines([{ path: file.path, content }], query, {
				maxResults: maxResults - hits.length,
			});
			hits.push(...partial);
		}
		return hits;
	}
}
