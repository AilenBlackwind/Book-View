import { App, Notice, TFile } from 'obsidian';
import { BookView } from '../views/BookView';
import { BookTocView } from '../views/BookTocView';
import { collectManuscript } from '../components/CollectManuscript';

/** The sidebar may hold focus while the user is working with its bound book. */
export async function collectActiveManuscript(app: App): Promise<void> {
	const book = app.workspace.getActiveViewOfType(BookView)
		?? app.workspace.getActiveViewOfType(BookTocView)?.getBoundBook();
	if (!book?.filePath) {
		new Notice('Open a book or its table of contents first.');
		return;
	}
	const manifest = app.vault.getFileByPath(book.filePath);
	if (!(manifest instanceof TFile)) {
		new Notice('Book manifest not found.');
		return;
	}
	try {
		const output = await collectManuscript(app, manifest);
		if (output) await app.workspace.getLeaf(true).openFile(output);
	} catch (error) {
		console.error('Book View: manuscript export failed', error);
		new Notice('Could not collect the manuscript. See the console for details.');
	}
}
