import { Component, FileView, HoverPopover, Scope, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { cssClassesFromFrontmatter, getManifestLinks } from '../components/ManifestParser';
import { AbsoluteSectionManager } from '../components/AbsoluteSectionManager';
import { ScrollGuard, guardedScrollWrite } from '../components/ScrollGuard';
import { HEIGHT_PER_LINE } from '../toc/types';
import { WheelAccelerator } from '../components/WheelAccelerator';
import { showScriptMenu } from '../ui/ContextMenu';
import { NativeLeafPopover } from '../editor/NativeLeafPopover';
import { DebugLog } from '../utils/debug';
import { BookSearcher } from '../search/BookSearcher';
import { FindBar } from '../search/FindBar';
import type { SearchHit } from '../search/matcher';
import type BookViewPlugin from '../main';
import type { ModifierConfig } from '../settings';

function matchesModifiers(evt: MouseEvent, mod: ModifierConfig): boolean {
	return evt.altKey === mod.alt && evt.ctrlKey === mod.ctrl && evt.shiftKey === mod.shift && evt.metaKey === mod.meta;
}

export const VIEW_TYPE_BOOK_VIEW = 'book-view';

export class BookView extends FileView {
	// Debug: distinguish loadBook calls on the same vs. new instances.
	private static nextInstanceId = 0;
	readonly instanceId = ++BookView.nextInstanceId;
	absoluteManager: AbsoluteSectionManager | null = null;
	private contentContainer: HTMLElement | null = null;
	/** Manifest `cssclasses` currently applied to contentEl (see loadBook). */
	private bookCssClasses: string[] = [];

	/** Current native hover popover anchored to this view. Page Preview reads
	 *  and writes this slot via the HoverParent contract (hover-link's
	 *  `parent` field); without it the core plugin crashes and shows nothing. */
	hoverPopover: HoverPopover | null = null;

	/** Book scope classes for sibling views (the ToC panel) that render
	 *  outside this view but should still resolve book-scoped CSS variables. */
	getScopeClasses(): string[] {
		return this.bookCssClasses;
	}
	/** Owns the book container's scroll accessors: foreign scrollTop/scrollTo
	 *  writes (third-party smooth-scroll plugins) are dropped, internal ones
	 *  go through guardedScrollWrite. */
	private scrollGuard: ScrollGuard | null = null;
	private wheelAccelerator: WheelAccelerator | null = null;
	private currentFiles: TFile[] = [];
	private manifestPaths: Set<string> = new Set();
	/** Path actually rendered into the view (setState pre-sets filePath, so a
	 *  separate field is needed to detect duplicate loads of the same book). */
	private loadedPath = '';
	private popoutLeaf: WorkspaceLeaf | null = null;
	private savedScrollTop: number = -1;
	private savedContainer: HTMLElement | null = null;
	private boundPersistScroll: (() => void) | null = null;
	/** True while loadBook is running and before the persisted scroll position
	 *  has been restored. The scroll listener must not overwrite the saved
	 *  position in plugin.scrollPositions with 0 during the initial render
	 *  (sections mounting → ResizeObserver corrections → synthetic scroll
	 *  events all carry scrollTop = 0). */
	private initialLoadInProgress = false;
	filePath: string = '';
	plugin: BookViewPlugin | null = null;
	/** One Component per loadBook, so event listeners bound for a book are
	 *  released in cleanup() instead of accumulating on repeated loads. */
	private loadComponent: Component | null = null;
	private reloadTimer = 0;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.allowNoFile = true;
		// Ctrl/Cmd+F bound through Obsidian's hotkey pipeline: the view scope
		// takes precedence over the global "search current file" hotkey while
		// this view is focused, instead of racing it for the DOM keydown.
		// Both cases are registered because Obsidian's keymap only matches
		// uppercase letter hotkeys on non-Latin (Cyrillic) layouts
		// (forum.obsidian.md/t/90790) — lowercase 'f' fails on RU.
		this.scope = new Scope(this.app.scope);
		const scope = this.scope;
		for (const key of ['f', 'F']) {
			const handler = scope.register(['Mod'], key, () => {
				this.showFindBar();
				return false;
			});
			this.register(() => scope.unregister(handler));
		}
	}

	getViewType(): string {
		return VIEW_TYPE_BOOK_VIEW;
	}

	getContentContainer(): HTMLElement | null {
		return this.contentContainer;
	}

	getCurrentFiles(): TFile[] {
		return this.currentFiles;
	}

	getAbsoluteManager(): AbsoluteSectionManager | null {
		return this.absoluteManager;
	}

	getDisplayText(): string {
		if (this.filePath) {
			const file = this.app.vault.getFileByPath(this.filePath);
			if (file instanceof TFile) {
				return file.basename;
			}
		}
		return 'Book view';
	}

	getIcon(): string {
		return 'book-open';
	}

	getState(): Record<string, unknown> {
		return { filePath: this.filePath, file: this.filePath };
	}

	protected async onOpen(): Promise<void> {
		const t0 = performance.now();
		DebugLog.startup('onOpen', this.filePath || '(no path)', `layout=${this.app.workspace.layoutReady}`);
		const state = this.getState();
		if (typeof state.filePath === 'string' && state.filePath) {
			await this.loadBookWhenReady(state.filePath);
		}
		const ms = performance.now() - t0;
		if (ms > 50) DebugLog.log('LOAD onOpen-ms', String(this.instanceId), this.filePath, Math.round(ms));
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = state as Record<string, unknown>;
		// Accept both conventions: `filePath` (our plugin) and `file` (Obsidian FileView / workspace restore).
		const raw = (typeof s?.filePath === 'string' && s.filePath)
			|| (typeof s?.file === 'string' && s.file);
		if (raw) {
			this.filePath = raw;
			this.file = this.app.vault.getFileByPath(raw) ?? null;
			await this.loadBookWhenReady(raw);
		}
	}

	protected async onClose(): Promise<void> {
		this.plugin?.tocCoordinator?.onBookClosed(this);
		this.cleanup();
	}

	// FileView abstract methods --------------------------------------------------

	async onLoadFile(_file: TFile): Promise<void> {
		// Loading is driven by setState → loadBookWhenReady; nothing extra needed.
	}

	async onUnloadFile(_file: TFile): Promise<void> {
		this.cleanup();
	}

	async onRename(_file: TFile): Promise<void> {
		// filePath stays in sync via setState when the workspace re-saves state.
	}

	canAcceptExtension(_extension: string): boolean {
		return false;
	}

	refreshToc(): void {
		// In-book ToC is disabled for the sidebar-toc spike; settings changes
		// are applied to the right-rail ToC by the coordinator instead.
		this.plugin?.tocCoordinator?.sync();
	}

	refreshAppliedAtoms(paths: string[]): void {
		for (const path of paths) {
			this.absoluteManager?.markDirty(path);
		}
	}

	// ------------------------------------------------------------------ find

	private findBar: FindBar | null = null;
	private findMatches: SearchHit[] = [];
	private findIndex = -1;
	private findQuery = '';
	private findDebounce = 0;
	private findRequestId = 0;
	private findAllActive = false;
	private findObserver: MutationObserver | null = null;

	/** Opens (or refocuses) the find bar. Bound to Ctrl/Cmd+F. */
	showFindBar(): void {
		if (!this.findBar) {
			this.findBar = new FindBar({
				onQuery: (q) => this.scheduleFind(q),
				onPrev: () => this.findPrev(),
				onNext: () => this.findNext(),
				onToggleFindAll: () => this.toggleFindAll(),
				onClose: () => this.closeFindBar(),
			});
			this.contentEl.appendChild(this.findBar.el);
		}
		this.findBar.show();
	}

	closeFindBar(): void {
		this.findBar?.hide();
		this.clearFindMarks();
		this.findMatches = [];
		this.findIndex = -1;
		this.findAllActive = false;
		this.findBar?.setFindAllActive(false);
	}

	/** ESC entry point, called by the plugin's window capture handler. Closes
	 *  the find bar when it is open; otherwise the key is a no-op (Obsidian's
	 *  default back-navigation was already swallowed, so ESC never swaps this
	 *  leaf back to the previous note). */
	handleEscape(): void {
		this.closeFindBar();
	}

	private scheduleFind(query: string): void {
		window.clearTimeout(this.findDebounce);
		this.findDebounce = window.setTimeout(() => void this.runFind(query), 150);
	}

	private async runFind(query: string): Promise<void> {
		const q = query.trim();
		const requestId = ++this.findRequestId;
		this.clearFindMarks();
		this.findAllActive = false;
		this.findBar?.setFindAllActive(false);

		if (!q) {
			this.findMatches = [];
			this.findIndex = -1;
			this.findBar?.setCount(0, 0);
			return;
		}

		if (q !== this.findQuery) {
			this.findQuery = q;
			const searcher = new BookSearcher(
				this.app,
				this.currentFiles,
				(path) => this.absoluteManager?.getRawContent(path) ?? null,
			);
			const hits = await searcher.search(q, 200);
			if (requestId !== this.findRequestId) return;
			this.findMatches = hits;
			this.findIndex = hits.length ? 0 : -1;
		}

		this.updateFindCount();
		if (this.findIndex >= 0) {
			void this.gotoFindMatch();
		}
	}

	private findNext(): void {
		if (this.findMatches.length === 0) return;
		this.findIndex = (this.findIndex + 1) % this.findMatches.length;
		this.updateFindCount();
		void this.gotoFindMatch();
	}

	private findPrev(): void {
		if (this.findMatches.length === 0) return;
		this.findIndex = (this.findIndex - 1 + this.findMatches.length) % this.findMatches.length;
		this.updateFindCount();
		void this.gotoFindMatch();
	}

	private updateFindCount(): void {
		this.findBar?.setCount(this.findMatches.length ? this.findIndex + 1 : 0, this.findMatches.length);
	}

	private async gotoFindMatch(): Promise<void> {
		const hit = this.findMatches[this.findIndex];
		if (!hit) return;
		await this.jumpToLine(hit.filePath, hit.line, hit.match, { current: true, occurrence: hit.index });
	}

	private toggleFindAll(): void {
		this.findAllActive = !this.findAllActive;
		this.findBar?.setFindAllActive(this.findAllActive);
		if (this.findAllActive) {
			this.highlightAll(this.findQuery);
		} else {
			this.clearAllMarks();
		}
	}

	/** Watches the content container for sections mounting after «Find all» was
	 *  pressed, so lazily loaded sections get highlighted too. Kept off the
	 *  onSectionRendered slot, which is owned by the ToC. */
	private startFindObserver(): void {
		const container = this.contentContainer;
		if (!container) return;
		this.findObserver?.disconnect();
		this.findObserver = new MutationObserver((records) => this.handleFindMutations(records));
		this.findObserver.observe(container, { childList: true, subtree: true });
	}

	/** Highlights any section whose rendered DOM changed while «Find all» is
	 *  active: lazy mounts, cached-DOM remounts, and placeholder→full-render
	 *  upgrades. Sections are skipped when they already carry an all-marks
	 *  highlight, so re-renders (which replace the DOM) are the only ones that
	 *  get (re)wrapped. */
	private handleFindMutations(records: MutationRecord[]): void {
		if (!this.findAllActive || !this.findQuery) return;
		const container = this.contentContainer;
		if (!container) return;
		let relevant = false;
		for (const record of records) {
			for (const node of Array.from(record.addedNodes).concat(Array.from(record.removedNodes))) {
				if (node.nodeType !== Node.ELEMENT_NODE) continue;
				const el = node as Element;
				if (el.matches('.markdown-rendered, .book-section-placeholder') || el.querySelector('.markdown-rendered')) {
					relevant = true;
					break;
				}
			}
			if (relevant) break;
		}
		if (!relevant) return;
		for (const section of Array.from(container.querySelectorAll('.book-section-placeholder'))) {
			if (!section.querySelector('.markdown-rendered')) continue;
			if (section.querySelector('mark.book-search-all')) continue;
			this.highlightAllIn(section as HTMLElement, this.findQuery);
		}
	}

	/**
	 * Search spike: scroll the book to a hit and highlight the matched text.
	 * Lines within an unloaded section are reached by estimating the offset
	 * (section offset + line * HEIGHT_PER_LINE), then waiting for the lazy
	 * section to mount before locating the exact text node to highlight.
	 */
	async jumpToLine(
		filePath: string,
		line: number,
		query: string,
		opts: { current?: boolean; occurrence?: number } = {},
	): Promise<void> {
		const manager = this.absoluteManager;
		const container = this.contentContainer;
		if (!manager || !container) return;

		const sectionOffset = manager.getOffset(filePath) ?? 0;
		const estimatedY = sectionOffset + line * HEIGHT_PER_LINE;
		guardedScrollWrite(container, () => {
			container.scrollTo({ top: Math.max(0, estimatedY - 100), behavior: 'auto' });
		});

		if (opts.current) this.clearCurrentMark();

		// The section placeholder element exists in the DOM before its content
		// is rendered (lazy mount), so a section that "exists" may still be an
		// empty box. Highlight only when highlightMatch actually placed a mark;
		// otherwise keep waiting a few frames for the render to land.
		const occurrence = opts.occurrence ?? 0;
		for (let attempt = 0; attempt < 60; attempt++) {
			const section = container.querySelector<HTMLElement>(
				`.book-section-placeholder[data-path="${CSS.escape(filePath)}"]`,
			);
			if (section && this.highlightMatch(section, query, occurrence)) {
				return;
			}
			await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
		}
	}

	/** Jumps to the start of a book note (internal-link navigation, ToC-like):
	 *  scrolls to the section's offset, then corrects against the mounted
	 *  section's real position once its content lands, and flashes the note's
	 *  first heading. */
	/** Open a note in Obsidian's native editor in a separate popout window
	 *  (public API). Used as the 'native' editor mode and as the fallback
	 *  when the detached-leaf popup fails. */
	private openNativePopout(targetFile: TFile, targetLine: number): void {
		const leaf = this.app.workspace.openPopoutLeaf();
		this.popoutLeaf = leaf;
		void leaf.openFile(targetFile, {
			state: { mode: 'source' },
			eState: { line: targetLine, ch: 0 },
		});
	}

	/** Scroll positions the user scrolled away from when following internal
	 *  links (one push per link click, capped). goBackToLastLink pops the
	 *  top, so repeated invocations walk back through the click history.
	 *  Absolute scrollTop is exact here: offsets in the virtualized layout
	 *  do not depend on what is currently mounted. */
	private linkBackStack: number[] = [];

	private async jumpToSectionStart(filePath: string): Promise<void> {
		const manager = this.absoluteManager;
		const container = this.contentContainer;
		if (!manager || !container) return;

		const sectionOffset = manager.getOffset(filePath) ?? 0;
		guardedScrollWrite(container, () => {
			container.scrollTo({ top: Math.max(0, sectionOffset - 20), behavior: 'auto' });
		});

		const selector = `.book-section-placeholder[data-path="${CSS.escape(filePath)}"]`;
		for (let attempt = 0; attempt < 60; attempt++) {
			const section = container.querySelector<HTMLElement>(selector);
			// Wait for the section's content to mount: only then is its DOM
			// transform refreshed and its top position real. Off-window
			// placeholders keep a stale transform, and settling against one
			// yanks the scroll back to wherever the placeholder still sits.
			if (section && section.querySelector('.markdown-rendered')) {
				const sectionRect = section.getBoundingClientRect();
				const containerRect = container.getBoundingClientRect();
				const target = container.scrollTop + (sectionRect.top - containerRect.top) - 20;
				if (Math.abs(container.scrollTop - target) < 1) {
					this.flashSectionTop(section);
					return;
				}
				guardedScrollWrite(container, () => {
					container.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
				});
			}
			await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		}
	}

	private flashSectionTop(section: HTMLElement): void {
		const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
		if (!heading) return;
		heading.addClass('book-heading-highlight');
		const onEnd = () => {
			heading.removeClass('book-heading-highlight');
			heading.removeEventListener('animationend', onEnd);
		};
		heading.addEventListener('animationend', onEnd);
	}

	/** Wraps the `occurrence`-th case-insensitive match of `query` in a
	 *  transient `<mark>` and returns whether it was placed. Adjacent text
	 *  nodes are merged first so words previously split by mark
	 *  unwrap/re-wrap stay findable (e.g. «мир» split into «ми» + «р» after a
	 *  query «ми» highlighted it). */
	private highlightMatch(root: HTMLElement, query: string, occurrence = 0): boolean {
		if (!query) return false;
		this.mergeAdjacentTextNodes(root);
		const lower = query.toLowerCase();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		let seen = 0;
		while ((node = walker.nextNode())) {
			const text = node.textContent ?? '';
			const hay = text.toLowerCase();
			let idx = hay.indexOf(lower);
			while (idx !== -1) {
				if (seen === occurrence) {
					const parent = node.parentElement;
					if (!parent) return false;
					const mark = parent.createEl('mark', { cls: 'book-search-current' });
					try {
						const range = document.createRange();
						range.setStart(node, idx);
						range.setEnd(node, idx + query.length);
						range.surroundContents(mark);
					} catch {
						mark.remove();
						return false;
					}
					return true;
				}
				seen++;
				idx = hay.indexOf(lower, idx + query.length);
			}
		}
		return false;
	}

	/** Wraps every case-insensitive occurrence of `query` in every text node
	 *  of every currently-mounted section. Sections that mount later are
	 *  covered by the MutationObserver in handleFindMutations. */
	private highlightAll(query: string): void {
		const container = this.contentContainer;
		if (!container || !query) return;
		for (const section of Array.from(container.querySelectorAll('.book-section-placeholder'))) {
			this.highlightAllIn(section as HTMLElement, query);
		}
	}

	private highlightAllIn(root: HTMLElement, query: string): void {
		const lower = query.toLowerCase();
		this.mergeAdjacentTextNodes(root);
		const targets: { node: Node; start: number; end: number }[] = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const parent = node.parentElement;
			if (!parent || parent.closest('mark')) continue;
			const text = node.textContent ?? '';
			const hay = text.toLowerCase();
			let idx = hay.indexOf(lower);
			while (idx !== -1) {
				targets.push({ node, start: idx, end: idx + query.length });
				idx = hay.indexOf(lower, idx + query.length);
			}
		}
		// surroundContents splits the node and inserts the mark, which shifts
		// later offsets on the same node; wrapping in reverse keeps them valid.
		for (let i = targets.length - 1; i >= 0; i--) {
			const t = targets[i];
			if (!t) continue;
			const parent = t.node.parentElement;
			if (!parent) continue;
			const mark = parent.createEl('mark', { cls: 'book-search-all' });
			try {
				const range = document.createRange();
				range.setStart(t.node, t.start);
				range.setEnd(t.node, t.end);
				range.surroundContents(mark);
			} catch {
				mark.remove();
			}
		}
	}

	private clearCurrentMark(): void {
		this.unwrapMarks('.book-search-current');
	}

	private clearAllMarks(): void {
		this.unwrapMarks('.book-search-all');
	}

	private clearFindMarks(): void {
		this.unwrapMarks('.book-search-current, .book-search-all');
	}

	private unwrapMarks(selector: string): void {
		const container = this.contentContainer;
		if (!container) return;
		for (const mark of Array.from(container.querySelectorAll(selector))) {
			mark.replaceWith(...Array.from(mark.childNodes));
		}
		// replaceWith splits the text around the mark, permanently breaking
		// words (a query «ми» leaves «мир» as «ми» + «р», and «мир» then never
		// matches again). Merge the fragments back into single text nodes.
		this.mergeAdjacentTextNodes(container);
	}

	/** Merges adjacent sibling text nodes under `root` back into single nodes.
	 *  Called before walking rendered text so matches never fall into the gap
	 *  between two text-node fragments of the same word. */
	private mergeAdjacentTextNodes(root: HTMLElement): void {
		const textNodes: Node[] = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		while ((node = walker.nextNode())) {
			textNodes.push(node);
		}
		for (const node of textNodes) {
			if (!node.isConnected) continue;
			const parent = node.parentNode;
			if (!parent) continue;
			let cur: Node | null = node;
			let text = '';
			while (cur && cur.nodeType === Node.TEXT_NODE) {
				text += cur.textContent ?? '';
				cur = cur.nextSibling;
			}
			if (node.nextSibling && node.nextSibling.nodeType === Node.TEXT_NODE) {
				const merged = document.createTextNode(text);
				parent.replaceChild(merged, node);
				let toRemove = merged.nextSibling;
				while (toRemove && toRemove.nodeType === Node.TEXT_NODE) {
					const next = toRemove.nextSibling;
					parent.removeChild(toRemove);
					toRemove = next;
				}
			}
		}
	}

	private async loadBookWhenReady(filePath: string): Promise<void> {
		const t0 = performance.now();
		// Deferred-view replay (app startup) can run before workspace layout is
		// marked ready — awaiting onLayoutReady there would deadlock on the 5s
		// safety timeout (obsidian creates leaves → calls onOpen → we await
		// layoutReady → but layoutReady is set only after loadLayout completes
		// → and loadLayout may be waiting for us). The leaf has no size during
		// this window, so the size-loop below handles it naturally: a few
		// rAF ticks let the browser lay out the workspace, then clientHeight
		// becomes positive and loadBook runs. Runtime opens (layout already up,
		// leaf already sized) skip the loop instantly.
		for (let i = 0; i < 120 && this.contentEl.clientHeight <= 0; i++) {
			await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
			if (this.leaf.view !== this) return;
		}
		const waitMs = performance.now() - t0;
		if (waitMs > 100) {
			DebugLog.log('LOAD wait-ms', String(this.instanceId), filePath, Math.round(waitMs));
			DebugLog.startup('onOpen waited', filePath, `${Math.round(waitMs)}ms`);
		}
		await this.loadBook(filePath);
		DebugLog.startup('loadBook done', filePath, `${Math.round(performance.now() - t0)}ms`);
	}

	private async waitForManifestCache(file: TFile): Promise<void> {
		return new Promise<void>((resolve) => {
			const ref = this.app.metadataCache.on('changed', (f) => {
				if (f.path === file.path) {
					window.clearTimeout(timer);
					this.app.metadataCache.offref(ref);
					resolve();
				}
			});
			const timer = window.setTimeout(() => {
				this.app.metadataCache.offref(ref);
				resolve();
			}, 4000);
		});
	}

	/** Cheap heuristic: does the raw file content look like it links other
	 *  notes? Used to distinguish "manifest cache not parsed yet" from a
	 *  genuinely empty manifest, so the cold-start wait never delays a book
	 *  that has no links to render.  Returns the raw content so callers can
	 *  reuse it instead of reading the file a second time. */
	private async rawContainsLinks(file: TFile): Promise<{ match: boolean; raw: string }> {
		try {
			const content = await this.app.vault.cachedRead(file);
			return { match: /\[\[|\[[^\]]*\]\(\.\//.test(content), raw: content };
		} catch {
			return { match: false, raw: '' };
		}
	}

	private async loadBook(filePath: string, force = false): Promise<void> {
		DebugLog.log('LOAD', String(this.instanceId), filePath);
		if (!force && this.loadedPath === filePath && this.absoluteManager && this.currentFiles.length > 0) {
			DebugLog.log('LOAD skip', String(this.instanceId), filePath);
			return;
		}
		this.cleanup();
		// Clear in-memory scroll state: cleanup already persisted to
		// plugin.scrollPositions keyed by filePath, so the next restore
		// reads the correct per-book value via getScrollPosition(). Keeping
		// savedScrollTop here would leak the OLD book's scrollTop into the
		// new book's restore (cleanup saved it, then B's restore consumed it
		// and set it to -1, then the NEXT book picks up whatever B had).
		this.savedScrollTop = -1;
		this.savedContainer = null;
		this.loadedPath = filePath;
		this.filePath = filePath;
		this.initialLoadInProgress = true;

		const comp = new Component();
		this.loadComponent = comp;

		const file = this.app.vault.getFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		// Cold-start guard: wait for the metadata cache to finish scanning
		// the manifest only when the file isn't in the cache at all yet.
		// Previously this also triggered when the cache existed but had no
		// links (code-block-only manifests), causing a pointless 4 s timeout.
		const manifestCache = this.app.metadataCache.getFileCache(file);
		const cacheMissing = manifestCache === null;
		const { match: hasRawLinks, raw: manifestRaw } = await this.rawContainsLinks(file);
		if (cacheMissing && hasRawLinks) {
			DebugLog.log('LOAD wait-metadata', String(this.instanceId), filePath);
			await this.waitForManifestCache(file);
		}

		this.contentEl.empty();
		this.contentEl.addClass('book-view-root');
		// Scope the manifest's own CSS snippet classes onto the book root so
		// user snippets like `.my-book .markdown-rendered ...` apply inside
		// this book render only. Re-read after the cold-start cache wait —
		// `manifestCache` above may still have been null at that point.
		// Classes from a previous render are dropped first: empty() clears
		// children, not the root's own class list.
		for (const cls of this.bookCssClasses) this.contentEl.removeClass(cls);
		this.bookCssClasses = cssClassesFromFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
		for (const cls of this.bookCssClasses) {
			this.contentEl.addClass(cls);
		}

		this.findBar?.destroy();
		this.findBar = null;
		this.findMatches = [];
		this.findIndex = -1;
		this.findQuery = '';
		this.findAllActive = false;

		this.contentContainer = this.contentEl.createDiv({ cls: 'book-content-container' });

		// Install the scroll guard before any writer exists (accelerator,
		// manager, ToC navigation all go through guardedScrollWrite).
		this.scrollGuard = new ScrollGuard(this.contentContainer);
		this.scrollGuard.install();

		// Debounced scroll-position persistence: writes the current scrollTop to
		// plugin.scrollPositions after 2s of no scrolling (mirrors the height
		// debounce in main.ts). The position is read back on the next loadBook
		// when no in-memory save exists (e.g. Obsidian restart).
		this.boundPersistScroll = () => {
			if (this.initialLoadInProgress) return;
			if (!this.contentContainer || !this.plugin || !this.filePath) return;
			this.plugin.saveScrollPosition(this.filePath, this.contentContainer.scrollTop);
		};
		this.contentContainer.addEventListener('scroll', this.boundPersistScroll, { passive: true });

		this.startFindObserver();

		this.wheelAccelerator = new WheelAccelerator(this.contentContainer, () => {
			const s = this.plugin?.settings;
			return {
				enabled: s?.wheelFlickEnabled ?? true,
				strength: s?.wheelFlickStrength ?? 2,
				friction: s?.wheelFlickFriction ?? 0.92,
				precision: s?.wheelFlickPrecision ?? false,
				shield: s?.wheelShieldEnabled ?? true,
			};
		});

		const links = await getManifestLinks(this.app, file, manifestRaw);
		const files = links
			.filter((l): l is { type: 'file'; file: TFile } => l.type === 'file')
			.map((l) => l.file);
		if (links.length === 0) {
			this.contentContainer.createDiv({ cls: 'book-empty', text: 'No linked notes found in manifest.' });
			return;
		}

		this.currentFiles = files;
		this.manifestPaths = new Set(files.map((f) => f.path));

		const settings = this.plugin?.settings;

		// The first book render must use theme spacings measured after the
		// layout is ready; measure on demand instead of trusting onload's
		// premature reading (see main.ts ensureThemeSpacings).
		if (this.plugin) await this.plugin.ensureThemeSpacings();

		this.absoluteManager = new AbsoluteSectionManager(
			this.contentContainer,
			links,
			this.app,
			file,
			settings?.loadMargin,
			{ get: this.plugin?.getPersistedHeight, put: this.plugin?.persistHeight },
			this.scrollGuard,
		);
		if (this.plugin?.themeSpacings) {
			this.absoluteManager.themeSpacings = this.plugin.themeSpacings;
		}
		this.absoluteManager.render();

		// In-book ToC is disabled for the sidebar-toc spike. The right-rail
		// BookTocView owns TocController + tagHeadings via the coordinator,
		// which rebinds after this book finishes loading.
		this.plugin?.tocCoordinator?.setCurrentBook(this);

		comp.registerDomEvent(this.contentContainer, 'dblclick', (evt: MouseEvent) => {
			const mod = this.plugin?.settings.editorModifiers;
			if (!mod || !matchesModifiers(evt, mod)) return;
			evt.preventDefault();

			const placeholder = (evt.target as HTMLElement).closest('.book-section-placeholder');
			if (!(placeholder instanceof HTMLElement)) return;

			const path = placeholder.dataset.path;
			if (!path) return;

			const targetFile = this.app.vault.getFileByPath(path);
			if (!(targetFile instanceof TFile)) return;

			// Estimate the cursor line from the click's relative position
			// within the section.  The rendered view is not a linear map of
			// source lines (images, embeds, code blocks all take variable
			// height), so this is approximate — but for long notes with a
			// single heading it lands much closer to the target than jumping
			// to line 0.
			const rect = placeholder.getBoundingClientRect();
			const ratio = Math.max(0, Math.min(1, (evt.clientY - rect.top) / rect.height));

			const cache = this.app.metadataCache.getFileCache(targetFile);
			let totalLines = 1;
			const lastSection = cache?.sections?.[cache.sections.length - 1];
			const lastHeading = cache?.headings?.[cache.headings.length - 1];
			if (lastSection) {
				totalLines = lastSection.position.end.line + 1;
			} else if (lastHeading) {
				totalLines = lastHeading.position.start.line + 50;
			}

			const targetLine = Math.min(
				totalLines - 1,
				Math.round(ratio * totalLines),
			);

			// Two editor modes (toggle via settings/command):
			//  - 'popup': a Modal embedding a detached native WorkspaceLeaf
			//    (real Obsidian editor, so Quick Add / custom JS scripts and
			//    full Live Preview run) directly in the book UI — no separate
			//    popout window. The book re-renders this section automatically
			//    via vault.on('modify'); NativeLeafPopover also re-renders on close.
			//  - 'native': the native editor in a separate popout window.
			// Note: the hand-rolled CodeMirror popup (src/editor/LiveEditModal.ts)
			// is temporarily disabled in favour of the detached leaf; see the
			// note at the top of that file to restore it.
			if (this.plugin?.settings.editorMode === 'popup') {
				// The popup relies on a private WorkspaceLeaf constructor; if a
				// future Obsidian version removes/breaks it, open the native
				// popout window instead so the click always yields an editor.
				try {
					new NativeLeafPopover(
						this.app,
						targetFile,
						targetLine,
						this.plugin?.settings.popupHideFrontmatter ?? false,
						this.bookCssClasses,
						() => {
							this.absoluteManager?.markDirty(targetFile.path);
						},
						() => this.openNativePopout(targetFile, targetLine),
					).open();
				} catch (err) {
					DebugLog.log('EDIT', 'popover failed, opening popout window:', String(err instanceof Error ? err.message : err));
					this.openNativePopout(targetFile, targetLine);
				}
			} else {
				this.openNativePopout(targetFile, targetLine);
			}
		});

		// Internal links inside the book: links to other book notes jump to the
		// start of that note (ToC-like); links to other vault notes open in a
		// new tab so the book is preserved. Registered on `window` in the
		// capture phase — the top of the event chain, before Obsidian's own
		// internal-link handling on `document`, which would otherwise navigate
		// away first. Modified/middle clicks and non-internal links (websites)
		// are left to Obsidian.
		comp.registerDomEvent(
			window,
			'click',
			(evt: MouseEvent) => {
				if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.altKey || evt.shiftKey) return;
				const target = evt.target as HTMLElement;
				const container = this.contentContainer;
				if (!container || !container.contains(target)) return;
				const link = target.closest<HTMLElement>('a.internal-link');
				if (!link) return;
				const href = link.getAttribute('data-href') ?? link.getAttribute('href');
				if (!href) return;
				const placeholder = target.closest<HTMLElement>('.book-section-placeholder');
				const sourcePath = placeholder?.dataset.path ?? this.filePath;
				const dest = this.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
				if (!(dest instanceof TFile)) return;
				evt.preventDefault();
				evt.stopImmediatePropagation();
				if (this.manifestPaths.has(dest.path)) {
					void this.jumpToSectionStart(dest.path);
				} else {
					void this.app.workspace.openLinkText(href, sourcePath, 'tab');
				}
			},
			{ capture: true },
		);

		// Toggle task-list checkboxes directly in reading view. Clicking a
		// checkbox flips the `- [ ]` / `- [x]` marker in the source file and
		// updates the DOM immediately; the vault 'modify' listener then
		// re-renders the section with the canonical state.
		comp.registerDomEvent(
			window,
			'click',
			(evt: MouseEvent) => {
				if (evt.button !== 0) return;
				const target = evt.target as HTMLElement;
				const checkbox = target.closest<HTMLInputElement>('input.task-list-item-checkbox');
				if (!checkbox) return;
				const container = this.contentContainer;
				if (!container || !container.contains(target)) return;
				evt.preventDefault();
				evt.stopPropagation();

				const placeholder = target.closest<HTMLElement>('.book-section-placeholder');
				const path = placeholder?.dataset.path;
				if (!path) return;
				const file = this.app.vault.getFileByPath(path);
				if (!(file instanceof TFile)) return;

				// Count this checkbox's position among all task checkboxes in
				// the section (document order) so we can map it to the source
				// line via the metadata cache.
				const sectionEl = placeholder.querySelector<HTMLElement>('.markdown-rendered');
				if (!sectionEl) return;
				const allCheckboxes = Array.from(sectionEl.querySelectorAll('input.task-list-item-checkbox'));
				const idx = allCheckboxes.indexOf(checkbox);
				if (idx < 0) return;

				const cache = this.app.metadataCache.getFileCache(file);
				const tasks = cache?.listItems?.filter((li) => li.task !== undefined);
				if (!tasks || idx >= tasks.length) return;
				const task = tasks[idx];
				if (!task) return;
				const line = task.position.start.line;

				// Read, toggle, write.
				void file.vault.cachedRead(file).then((raw) => {
					const lines = raw.split('\n');
					const src = lines[line];
					if (src === undefined) return;
					const replaced = src.replace(
						/^(\s*[-*+]\s+)\[([ xX])\]/,
						(_, prefix: string, mark: string) =>
							`${prefix}[${mark === ' ' ? 'x' : ' '}]`,
					);
					if (replaced === src) return;
					lines[line] = replaced;
					return file.vault.modify(file, lines.join('\n'));
				});

				// Optimistic DOM toggle so the UI feels instant.
				const wasUnchecked = checkbox.getAttribute('data-task') === ' ';
				checkbox.checked = wasUnchecked;
				checkbox.setAttribute('data-task', wasUnchecked ? 'x' : ' ');
			},
			{ capture: true },
		);

		// Native Page Preview (Ctrl/Cmd + hover) for internal links. The core
		// plugin only renders note content when the 'hover-link' context
		// carries the section note's path and a valid hoverParent; without it
		// only the path tooltip appears. A mouseover handler resolves the
		// link against the section note, and a keydown handler covers the
		// "hover first, press the modifier later" case, where no new
		// mouseover event fires. The source is registered in main.ts.
		let hoveredLink: { href: string; sourcePath: string; el: HTMLElement } | null = null;
		const triggerHover = (evt: MouseEvent | KeyboardEvent): void => {
			if (!hoveredLink) return;
			this.app.workspace.trigger('hover-link', {
				event: evt,
				source: 'book-view',
				sourcePath: hoveredLink.sourcePath,
				linktext: hoveredLink.href,
				targetEl: hoveredLink.el,
				hoverParent: this,
			});
		};
		comp.registerDomEvent(
			window,
			'keydown',
			(evt: KeyboardEvent) => {
				if (!evt.ctrlKey && !evt.metaKey) return;
				if (hoveredLink && !hoveredLink.el.isConnected) {
					hoveredLink = null;
					return;
				}
				if (hoveredLink) triggerHover(evt);
			},
			{ capture: true },
		);
		comp.registerDomEvent(
			window,
			'mouseover',
			(evt: MouseEvent) => {
				const target = evt.target as HTMLElement;
				const container = this.contentContainer;
				if (!container || !container.contains(target)) {
					hoveredLink = null;
					return;
				}
				const link = target.closest<HTMLElement>('a.internal-link');
				if (!link || !container.contains(link)) {
					hoveredLink = null;
					return;
				}
				const href = link.getAttribute('data-href') ?? link.getAttribute('href');
				if (!href) {
					hoveredLink = null;
					return;
				}
				const placeholder = target.closest<HTMLElement>('.book-section-placeholder');
				const sourcePath = placeholder?.dataset.path ?? this.filePath;
				if (!this.app.metadataCache.getFirstLinkpathDest(href, sourcePath)) {
					hoveredLink = null;
					return;
				}
				hoveredLink = { href, sourcePath, el: link };
				if (!evt.ctrlKey && !evt.metaKey) return;
				evt.stopPropagation();
				triggerHover(evt);
			},
			{ capture: true },
		);

		comp.registerDomEvent(this.contentContainer, 'contextmenu', (evt: MouseEvent) => {
			const profiles = this.plugin?.settings.menuProfiles;
			if (!profiles || profiles.length === 0) return;

			let matchedProfile: import('../settings').MenuProfile | null = null;
			for (const profile of profiles) {
				if (matchesModifiers(evt, profile.modifiers)) {
					matchedProfile = profile;
					break;
				}
			}

			if (!matchedProfile || matchedProfile.scripts.length === 0) return;

			evt.preventDefault();
			evt.stopPropagation();

			const selection = window.getSelection()?.toString() ?? '';

			const closestHeading = (evt.target as HTMLElement).closest('h1, h2, h3, h4, h5, h6');
			let entryIndex = -1;
			if (closestHeading instanceof HTMLElement) {
				const idx = closestHeading.getAttribute('data-entry-index');
				if (idx !== null) entryIndex = parseInt(idx, 10);
			}

			showScriptMenu(evt, matchedProfile.scripts, this.app, (entry) => {
				this.plugin?.api?.setContext({ selection, entryIndex });
				(this.app as unknown as { commands: { executeCommandById: (id: string) => void } })
					.commands.executeCommandById(entry.commandId);
			});
		});

		comp.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf === this.leaf) {
					this.restoreScrollPosition();
					if (this.popoutLeaf) {
						this.popoutLeaf.detach();
						this.popoutLeaf = null;
					}
				} else if (leaf && leaf !== this.leaf) {
					this.saveScrollPosition();
				}
			}),
		);

		comp.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				if (file.path === this.filePath) {
					this.scheduleReload();
					return;
				}
				if (!this.manifestPaths.has(file.path)) return;
				this.scheduleRefresh(file.path);
			}),
		);

		comp.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (!(file instanceof TFile)) return;
				if (file.path === this.filePath) {
					this.scheduleReload();
					return;
				}
				if (!this.manifestPaths.has(file.path)) return;
				if (!this.haveHeadingsChanged(file)) return;
				// Heading changes rebuild the ToC. Debounced + coalesced by the
				// coordinator so a burst of file edits triggers ONE incremental
				// rebuild (see TocCoordinator.scheduleRefresh).
				this.plugin?.tocCoordinator?.scheduleRefresh();
			}),
		);

		// Restore persisted scroll position on initial load: the
		// active-leaf-change listener only fires on leaf switches, not on
		// the first activation (the leaf is already active when loadBook
		// registers the listener). Defer until sections have mounted and
		// scrollHeight is non-zero (the pool creates placeholders with
		// estimated heights synchronously, but the ResizeObserver needs
		// one paint frame to report real heights).
		this.schedulePersistedScrollRestore();

	}

	private refreshTimers: Map<string, number> = new Map();
	/** JSON hash of each file's headings (level + heading text), used to skip TOC rebuild when only body text changed */
	private tocHeadingsCache: Map<string, string> = new Map();

	private scheduleRefresh(path: string): void {
		const existing = this.refreshTimers.get(path);
		if (existing) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(path);
			this.absoluteManager?.markDirty(path);
		}, 300);
		this.refreshTimers.set(path, timer);
	}

	private scheduleReload(): void {
		window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = 0;
			void this.loadBook(this.filePath, true);
		}, 300);
	}

	private initTocHeadingsCache(): void {
		for (const file of this.currentFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const headings = cache?.headings ?? [];
			this.tocHeadingsCache.set(file.path, JSON.stringify(headings.map((h) => `${h.level}:${h.heading}`)));
		}
	}

	private haveHeadingsChanged(file: TFile): boolean {
		const cache = this.app.metadataCache.getFileCache(file);
		const newHeadings = cache?.headings ?? [];
		const hash = JSON.stringify(newHeadings.map((h) => `${h.level}:${h.heading}`));
		const prev = this.tocHeadingsCache.get(file.path);
		if (prev === undefined) {
			this.tocHeadingsCache.set(file.path, hash);
			return hash.length > 2; // true if file has any headings (first time)
		}
		this.tocHeadingsCache.set(file.path, hash);
		return hash !== prev;
	}

	/** Wait for the first layout settle (scrollHeight > 0 from measured
	 *  section heights) then restore the persisted scroll position. Called
	 *  once at the end of loadBook; the single-rAF inside
	 *  restoreScrollPosition is not enough because sections haven't mounted
	 *  yet when loadBook returns — the pool created placeholders but the
	 *  ResizeObserver hasn't fired. */
	private schedulePersistedScrollRestore(): void {
		const container = this.contentContainer;
		const tryRestore = (attempts: number) => {
			if (!container || container !== this.contentContainer) return;
			const sh = container.scrollHeight;
			const ch = container.clientHeight;
			if (sh > ch || attempts <= 0) {
				this.initialLoadInProgress = false;
				this.restoreScrollPosition();
			} else {
				window.requestAnimationFrame(() => tryRestore(attempts - 1));
			}
		};
		window.requestAnimationFrame(() => tryRestore(20));
	}

	private saveScrollPosition(): void {
		if (this.initialLoadInProgress) return;
		if (this.contentContainer) {
			const scrollTop = this.contentContainer.scrollTop;
			this.savedScrollTop = scrollTop;
			this.savedContainer = this.contentContainer;
			if (this.plugin && this.filePath) {
				// Don't overwrite a valid saved position with 0 during teardown:
				// the container may already be detached/emptied (scrollTop=0) by
				// the time cleanup or leaf-change fires, but the scroll listener
				// already captured the correct position synchronously.
				const existing = this.plugin.getScrollPosition(this.filePath);
				const safeTop = scrollTop ?? 0;
				if (safeTop <= 0 && existing !== undefined && existing > 0) return;
				this.plugin.saveScrollPosition(this.filePath, safeTop);
			}
		}
	}

	private restoreScrollPosition(): void {
		if (!this.contentContainer) return;
		if (this.savedContainer === this.contentContainer) {
			DebugLog.log('RESTORE skip', '', this.savedScrollTop);
			this.savedScrollTop = -1;
			this.savedContainer = null;
			return;
		}
		this.savedContainer = null;
		const target = this.savedScrollTop >= 0
			? this.savedScrollTop
			: (this.plugin?.getScrollPosition(this.filePath) ?? -1);
		DebugLog.log('RESTORE', '', target >= 0 ? target : -2);
		this.savedScrollTop = -1;
		if (target >= 0) {
			window.requestAnimationFrame(() => {
				if (!this.contentContainer) return;
				const maxScroll = this.contentContainer.scrollHeight - this.contentContainer.clientHeight;
				guardedScrollWrite(this.contentContainer, () => {
					this.contentContainer!.scrollTop = Math.min(target, Math.max(0, maxScroll));
				});
			});
		}
	}

	private cleanup(): void {
		// Persist the current scroll position before destroying the container:
		// active-leaf-change does not fire when the same leaf switches views
		// (e.g. book A → book B in the same pane), so without this the old
		// book's position is lost until the next Obsidian restart.
		this.saveScrollPosition();
		this.loadComponent?.unload();
		this.loadComponent = null;
		window.clearTimeout(this.reloadTimer);
		this.reloadTimer = 0;
		if (this.contentContainer && this.boundPersistScroll) {
			this.contentContainer.removeEventListener('scroll', this.boundPersistScroll);
		}
		this.boundPersistScroll = null;
		for (const timer of this.refreshTimers.values()) {
			window.clearTimeout(timer);
		}
		this.refreshTimers.clear();
		this.tocHeadingsCache.clear();
		if (this.absoluteManager) {
			this.absoluteManager.destroy();
			this.absoluteManager = null;
		}
		if (this.wheelAccelerator) {
			this.wheelAccelerator.destroy();
			this.wheelAccelerator = null;
		}
		if (this.scrollGuard) {
			this.scrollGuard.uninstall();
			this.scrollGuard = null;
		}
		this.currentFiles = [];
		this.manifestPaths.clear();
		window.clearTimeout(this.findDebounce);
		this.findBar?.destroy();
		this.findBar = null;
		this.findMatches = [];
		this.findIndex = -1;
		this.findQuery = '';
		this.findAllActive = false;
		this.findObserver?.disconnect();
		this.findObserver = null;
	}
}
