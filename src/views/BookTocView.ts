import { ItemView, WorkspaceLeaf } from 'obsidian';
import { TocController } from '../components/TocController';
import { AbsoluteSectionManager } from '../components/AbsoluteSectionManager';
import { DebugLog } from '../utils/debug';
import type { BookView } from './BookView';

export const VIEW_TYPE_BOOK_TOC = 'book-toc-view';

/**
 * Right-rail ToC (spike): hosts the same TocController that used to live
 * inside the BookView, but renders it into a right-sidebar ItemView. It is
 * bound to whichever BookView is currently active (see TocCoordinator).
 */
export class BookTocView extends ItemView {
	private tocController: TocController | null = null;
	private boundBook: BookView | null = null;
	// TEMP debug: cumulative bind counter.
	private dbgBinds = 0;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BOOK_TOC;
	}

	getDisplayText(): string {
		return 'Book table of contents';
	}

	getIcon(): string {
		return 'list';
	}

	getBoundBook(): BookView | null {
		return this.boundBook;
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('book-toc-view-root');
	}

	async onClose(): Promise<void> {
		this.unbind();
	}

	bind(book: BookView, force = false): void {
		// TEMP debug: bind/rebind spam hypothesis.
		this.dbgBinds++;
		DebugLog.log('TOC bind', book.filePath || '', force ? 1 : 0, this.boundBook === book ? 1 : 0, this.dbgBinds);
		if (book === this.boundBook && !force) return;

		this.unbind();

		const container = book.getContentContainer();
		const manager = book.getAbsoluteManager();
		const files = book.getCurrentFiles();
		if (!container || !manager || files.length === 0) return;

		this.boundBook = book;
		this.contentEl.empty();
		this.contentEl.addClass('book-toc-view-root');
		this.contentEl.addClass('book-toc-relative');

		this.tocController = new TocController(
			this.contentEl,
			files,
			this.app,
			container,
			book.plugin?.settings ?? null,
			manager,
		);
		this.tocController.build();

		manager.onSectionRendered = (path, sectionContainer) => {
			const t0 = performance.now();
			this.tocController?.tagHeadings(path, sectionContainer);
			AbsoluteSectionManager.dbgTagMs += performance.now() - t0;
		};
		manager.onSectionContentChanged = (path) => {
			this.tocController?.invalidatePath(path);
		};
	}

	unbind(): void {
		// TEMP debug.
		DebugLog.log('TOC unbind', this.boundBook?.filePath || '');
		this.tocController?.destroy();
		this.tocController = null;
		const manager = this.boundBook?.getAbsoluteManager();
		if (manager) {
			manager.onSectionRendered = null;
			manager.onSectionContentChanged = null;
		}
		this.boundBook = null;
		this.contentEl.empty();
		this.contentEl.addClass('book-toc-view-root');
	}
}
