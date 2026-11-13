import { Notice } from 'obsidian';
import type BookViewPlugin from '../main';
import { collectManifestLinks, type ChapterListSource } from '../components/EmbeddedManifest';
import { findBookViewBlocks } from '../components/CodeBlockParser';
import { frontmatterEndOffset } from '../components/ManifestParser';
import { ChapterListModal } from '../ui/ChapterListModal';
import { BookView } from '../views/BookView';
import { BookTocView } from '../views/BookTocView';

export function registerEditChapterList(plugin: BookViewPlugin): void {
	const { app } = plugin;
	let modal: ChapterListModal | undefined;
	let opening = false;
	let unloaded = false;
	plugin.register(() => {
		unloaded = true;
		modal?.close();
	});
	plugin.addCommand({
		id: 'edit-chapter-list',
		name: 'Edit chapter list',
		checkCallback: (checking) => {
			const book = app.workspace.getActiveViewOfType(BookView)
				?? app.workspace.getActiveViewOfType(BookTocView)?.getBoundBook();
			if (!book?.filePath) return false;
			if (!checking && !opening) {
				opening = true;
				void open(book).catch((error: unknown) => {
					console.error('Book View: could not load chapter lists', error);
					new Notice('Could not load chapter lists for this book.');
				}).finally(() => { opening = false; });
			}
			return true;
		},
	});

	async function open(book: BookView): Promise<void> {
		const path = book.filePath;
		const file = app.vault.getFileByPath(path);
		if (!file) return;
		const lists = new Map<string, ChapterListSource>();
		await collectManifestLinks(app, file, undefined, undefined, (entry) => {
			lists.set(`${entry.file.path}\n${entry.from}\n${entry.to}`, entry);
		});
		if (unloaded || book.filePath !== path || !book.containerEl.isConnected) return;
		const wholeBlocks = new Map<string, Set<string>>();
		const editable = [...lists.values()].filter((entry) => {
			let ranges = wholeBlocks.get(entry.file.path);
			if (!ranges) {
				const start = frontmatterEndOffset(entry.raw);
				ranges = new Set(findBookViewBlocks(entry.raw.slice(start))
					.map((block) => `${start + block.from}:${start + block.to}`));
				wholeBlocks.set(entry.file.path, ranges);
			}
			return ranges.has(`${entry.from}:${entry.to}`);
		});
		if (!editable.length) {
			new Notice('This book has no book-view chapter lists to edit.');
			return;
		}
		modal?.close();
		modal = new ChapterListModal(app, editable, () => plugin.settings.chapterFolderFirst);
		modal.open();
	}
}
