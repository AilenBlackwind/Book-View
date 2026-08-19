import { MarkdownView, WorkspaceLeaf } from 'obsidian';
import { BookView, VIEW_TYPE_BOOK_VIEW } from '../views/BookView';
import { BookTocView, VIEW_TYPE_BOOK_TOC } from '../views/BookTocView';
import { DebugLog } from '../utils/debug';
import type { TocEntry } from '../toc/entries';
import type BookViewPlugin from '../main';

/**
 * Spike coordinator: ties the right-rail BookTocView to the active book.
 *
 * The ToC follows the active leaf: whenever a book becomes active it opens
 * (and, per settings, focuses) the panel, and it closes when the user moves
 * to a non-book note. Opening a note that belongs to the bound book in the
 * editor keeps the panel open and bound. Interacting with the ToC panel
 * itself (its leaf being active) keeps the current binding; a manual
 * toggle-off suppresses the immediate reopen that the detach-triggered
 * active-leaf-change would otherwise cause.
 *
 * Both auto behaviors can be turned off in settings: `tocAutoOpen` disables
 * auto-open/close entirely (the ToC becomes fully manual), and
 * `tocFocusOnBook` keeps auto-open but stops the panel from stealing focus
 * from the book.
 */
export class TocCoordinator {
	private lastBook: BookView | null = null;
	private suppressAutoOpen = 0;
	private openPromise: Promise<void> | null = null;
	/** Whether the ToC leaf was the active view before the current leaf
	 *  change. Used to avoid re-stealing focus when the user clicks back into
	 *  the book right after interacting with the panel. */
	private prevActiveWasToc = false;
	/** Coalescing timer for heading-change refreshes: a burst of file edits
	 *  (mass replace, a linter run) producing many `scheduleRefresh` calls
	 *  rebuilds the ToC once, not once per file. */
	private refreshTimer = 0;

	constructor(private plugin: BookViewPlugin) {}

	private getLeaf(): WorkspaceLeaf | null {
		return this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_BOOK_TOC)[0] ?? null;
	}

	private getTocView(): BookTocView | null {
		const view = this.getLeaf()?.view;
		return view instanceof BookTocView ? view : null;
	}

	/** Entries of the ToC bound to the active book. Consumers outside the
	 *  panel (BookViewAPI, user scripts) resolve headings through here instead
	 *  of the BookView, which no longer owns a controller. */
	getEntries(): TocEntry[] {
		return this.getTocView()?.getEntries() ?? [];
	}

	open(focus = false): Promise<void> {
		if (!this.openPromise) {
			this.openPromise = this.doOpen(focus).finally(() => {
				this.openPromise = null;
			});
		}
		return this.openPromise;
	}

	private async doOpen(focus: boolean): Promise<void> {
		let leaf = this.getLeaf();
		if (!leaf) {
			// 1) Try getRightLeaf(false) — works when the sidebar is visible.
			leaf = this.plugin.app.workspace.getRightLeaf(false);

			if (!leaf) {
				// 2) Sidebar is collapsed or empty. Iterate all leaves to find
				//    one whose container sits inside the right split.
			this.plugin.app.workspace.iterateAllLeaves((l) => {
				if (!leaf && l.view.containerEl.closest('.mod-right-split')) {
					leaf = l;
				}
			});
			}

			if (leaf) {
				// Found an existing leaf (may be hidden) — reveal the sidebar.
				await this.plugin.app.workspace.revealLeaf(leaf);
			} else {
				// 3) Right sidebar is completely empty — create the first leaf.
				//    getRightLeaf(true) both creates and reveals.
				leaf = this.plugin.app.workspace.getRightLeaf(true);
			}
			if (!leaf) return;
		}
		if (leaf.getViewState().type !== VIEW_TYPE_BOOK_TOC) {
			await leaf.setViewState({ type: VIEW_TYPE_BOOK_TOC });
		}
		if (focus) {
			this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		}
		this.bindToLastBook();
	}

	/** Close the ToC. A manual close (toggle) suppresses, for 500ms, the
	 *  reopen that the detach-triggered active-leaf-change would cause. */
	private close(manual = false): void {
		if (manual) {
			window.clearTimeout(this.suppressAutoOpen);
			this.suppressAutoOpen = window.setTimeout(() => {
				this.suppressAutoOpen = 0;
			}, 500);
		}
		this.getLeaf()?.detach();
	}

	toggle(): void {
		if (this.getLeaf()) {
			this.close(true);
		} else {
			void this.open();
		}
	}

	/** True when the active view is the editor showing one of the current
	 *  book's notes (or the book manifest itself). Editing a note in the book
	 *  keeps the ToC open and bound; switching to any other note closes it. */
	private isEditingBookFile(): boolean {
		const book = this.lastBook;
		if (!book) return false;
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const file = activeView?.file;
		if (!file) return false;
		if (file.path === book.filePath) return true;
		return book.getCurrentFiles().some((f) => f.path === file.path);
	}

	/** Follow the active leaf: open+bind when a book is active, close on any
	 *  other view. The ToC leaf itself being active means the user is inside
	 *  the panel — keep the binding instead of closing it. Opening a book note
	 *  in the editor (MarkdownView) also keeps the binding, so the panel does
	 *  not slam shut mid-edit. */
	sync(): void {
		if (this.suppressAutoOpen) return;

		const tocActiveNow = this.plugin.app.workspace.getActiveViewOfType(BookTocView) !== null;
		const cameFromToc = this.prevActiveWasToc;
		this.prevActiveWasToc = tocActiveNow;

		if (tocActiveNow) return;

		const active = this.plugin.app.workspace.getActiveViewOfType(BookView);
		if (!active) {
			if (this.plugin.settings.tocAutoOpen && !this.isEditingBookFile()) this.close();
			return;
		}

		// Debug: track bind/rebind timing vs the scroll storm.
		DebugLog.log('COORD sync', active.filePath || '', tocActiveNow ? 1 : 0, cameFromToc ? 1 : 0);
		this.lastBook = active;

		// Auto-open disabled: never open/close automatically, just rebind if
		// the panel happens to be open.
		if (!this.plugin.settings.tocAutoOpen) {
			this.bindToLastBook();
			return;
		}

		const focus = this.plugin.settings.tocFocusOnBook && !cameFromToc;
		void this.open(focus);
	}

	/** The book finished loading (or its sections were re-rendered). Forced
	 *  rebind so a new book loaded into the same BookView instance rebuilds
	 *  the ToC instead of being swallowed by the bound-book guard. */
	setCurrentBook(book: BookView): void {
		// Debug: the book finished loading; the coordinator rebinds the ToC.
		DebugLog.log('COORD setCurrentBook', book.filePath || '', book.instanceId);
		this.lastBook = book;
		const view = this.getTocView();
		if (!view) return;
		// setCurrentBook fires from every loadBook completion, and loadBook can
		// run several times for the same file during tab churn. Skip the forced
		// rebuild (unbind + rebuild all ToC entries) when this exact book is
		// already bound.
		if (view.getBoundBook() !== book) view.bind(book, true);
	}

	/** Force-rebuild the bound ToC (e.g. when a book's headings changed).
	 *  Incremental: entries + rows are rebuilt in place, the panel DOM is not
	 *  wiped. */
	refresh(): void {
		this.getTocView()?.rebuild();
	}

	/** Debounced, coalesced heading-change refresh. Every caller (each edited
	 *  book file) lands here; a single 500ms timer turns a mass edit into one
	 *  ToC rebuild instead of N full panel rebuilds. */
	scheduleRefresh(): void {
		window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = 0;
			this.refresh();
		}, 500);
	}

	onBookClosed(book: BookView): void {
		if (this.lastBook !== book) return;
		this.lastBook = null;
		this.getTocView()?.unbind();

		const hasOtherBook = this.plugin.app.workspace
			.getLeavesOfType(VIEW_TYPE_BOOK_VIEW)
			.some((leaf) => leaf.view instanceof BookView && leaf.view !== book);
		if (!hasOtherBook) this.close();
	}

	private bindToLastBook(): void {
		// Debug: how often does the ToC get (re)bound on tab switches?
		DebugLog.log('COORD bindToLastBook', this.lastBook?.filePath || '');
		const view = this.getTocView();
		if (view && this.lastBook) view.bind(this.lastBook);
	}
}
