import { App, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';
import type { HeadingNode } from '../utils/fold';
import { FoldController } from './FoldController';
import { SectionPool } from './SectionPool';
import type { SectionData, HeightPersistence } from './SectionPool';
import { SectionLayout } from './SectionLayout';
import { estimateHeight } from '../utils/content';
import type { ThemeSpacings } from '../utils/theme';
import { DebugLog } from '../utils/debug';

export const HEIGHT_PER_LINE = 25;

export class AbsoluteSectionManager {
	private scrollContainer: HTMLElement;
	private spacerEl: HTMLElement;
	private links: ManifestLink[];
	private app: App;
	private masterFile: TFile;
	private loadMargin: number;
	private persistence: HeightPersistence;

	/** Theme-derived vertical gaps, owned by the SectionLayout. */
	get themeSpacings(): ThemeSpacings {
		return this.layout.themeSpacings;
	}

	set themeSpacings(value: ThemeSpacings) {
		this.layout.applyThemeSpacings(value);
	}

	private fold: FoldController;
	private layout: SectionLayout;

	/** Directly-folded heading ids, owned by the FoldController. */
	get foldedHeadings(): Set<string> {
		return this.fold.foldedHeadings;
	}

	private sections: Map<string, SectionData> = new Map();
	private fileOrder: string[] = [];
	private rawContent: Map<string, string> = new Map();
	private headingIndex: HeadingNode[] = [];
	/** Precomputed lookup maps to keep fold-mode checks allocation-free. */
	private headingIndexById: Map<string, HeadingNode> = new Map();
	private firstHeadingByPath: Map<string, HeadingNode> = new Map();
	private headingsByPath: Map<string, HeadingNode[]> = new Map();
	private updateRequested = false;
	private heightCache: Map<string, number> = new Map();
	private renderedDomCache: Map<string, HTMLElement> = new Map();
	private containerWidthObserver: ResizeObserver;
	private lastScrollTop = 0;
	private boundScrollHandler: (() => void) | null = null;
	private boundClickHandler: ((evt: MouseEvent) => void) | null = null;
	private lastContainerWidth = 0;
	private pendingHeights: Map<string, number> = new Map();
	private pendingWidthChange = false;
	private rafId = 0;
	private destroyed = false;
	/** Frame callbacks run at the start of the frame, before processUpdates
	 *  writes section positions, so their layout reads see a clean layout. */
	private frameCallbacks: (() => void)[] = [];
	private pool: SectionPool;

	// Thin wrapper keeping call sites readable; logic lives in utils/debug.
	private dbg(msg: string, path?: string, a?: number | string, b?: number | string, c?: number | string): void {
		DebugLog.log(msg, path, a, b, c);
	}

	/** Records a measured height delivered by the SectionPool's resize observer. */
	reportSectionHeight(path: string, newHeight: number): void {
		this.pendingHeights.set(path, newHeight);
		if (this.pendingHeights.size > 0) {
			this.scheduleUpdate();
		}
	}

	onHeightMeasured: ((path: string, estimated: number, actual: number) => void) | null = null;
	onSectionRendered: ((path: string, container: HTMLElement) => void) | null = null;

	constructor(
		scrollContainer: HTMLElement,
		links: ManifestLink[],
		app: App,
		masterFile: TFile,
		loadMargin: number = 800,
		persistence: HeightPersistence = {},
	) {
		this.scrollContainer = scrollContainer;
		this.links = links;
		this.app = app;
		this.masterFile = masterFile;
		this.loadMargin = loadMargin;
		this.persistence = persistence;

		this.scrollContainer.addClass('book-absolute-container');
		this.spacerEl = this.scrollContainer.createDiv({ cls: 'book-spacer' });

		this.pool = new SectionPool({
			sections: this.sections,
			rawContent: this.rawContent,
			heightCache: this.heightCache,
			renderedDomCache: this.renderedDomCache,
			fileOrder: this.fileOrder,
			scrollContainer: this.scrollContainer,
			spacerEl: this.spacerEl,
			app: this.app,
			loadMargin: this.loadMargin,
			persistence: this.persistence,
			isDestroyed: () => this.destroyed,
			getFoldMode: (path) => this.fold.getFoldMode(path),
			foldSectionNeedsFoldStub: (path) => this.fold.sectionNeedsFoldStub(path),
			foldScheduleHeightMeasure: (path) => this.fold.scheduleFoldHeightMeasure(path),
			foldTagSection: (path, el) => this.fold.tagFoldIds(path, el),
			findAnchorAt: (scrollTop) => this.layout.findAnchorAt(scrollTop),
			getOnSectionRendered: () => this.onSectionRendered,
			reportSectionHeight: (path, newHeight) => this.reportSectionHeight(path, newHeight),
			scheduleUpdate: () => this.scheduleUpdate(),
			scheduleFrame: () => this.scheduleFrame(),
			dbg: (msg, path, a, b, c) => this.dbg(msg, path, a, b, c),
		});

		this.layout = new SectionLayout({
			sections: this.sections,
			fileOrder: this.fileOrder,
			scrollContainer: this.scrollContainer,
			spacerEl: this.spacerEl,
			loadMargin: this.loadMargin,
			isDestroyed: () => this.destroyed,
			getFoldMode: (path) => this.fold.getFoldMode(path),
			foldNextVisibleIndex: (start) => this.fold.nextVisibleIndex(start),
			foldScheduleHeightMeasure: (path) => this.fold.scheduleFoldHeightMeasure(path),
			foldApplyPendingRetags: () => this.fold.applyPendingRetags(),
			enqueueRender: (path) => this.pool.enqueueRender(path),
			unloadSection: (path) => this.pool.unloadSection(path),
			dbg: (msg, path, a, b, c) => this.dbg(msg, path, a, b, c),
		});

		this.containerWidthObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const newWidth = entry.contentRect.width;
				if (this.lastContainerWidth !== 0 && Math.abs(newWidth - this.lastContainerWidth) > 2) {
					this.pendingWidthChange = true;
					this.scheduleUpdate();
				}
				this.lastContainerWidth = newWidth;
			}
		});
		this.containerWidthObserver.observe(this.scrollContainer);

		this.fold = new FoldController({
			headingIndex: this.headingIndex,
			headingIndexById: this.headingIndexById,
			firstHeadingByPath: this.firstHeadingByPath,
			fileOrder: this.fileOrder,
			sections: this.sections,
			headingsByPath: this.headingsByPath,
			isDestroyed: () => this.destroyed,
			getLastUserScrollAt: () => this.pool.lastUserScrollAt,
			captureAnchor: () => {
				this.layout.captureAnchor();
			},
			scheduleUpdate: () => {
				this.scheduleUpdate();
			},
		});

		this.boundScrollHandler = () => {
			// No scrollTop read here: a scroll event can be dispatched while
			// the book layout is still dirty (async height measurements), and
			// reading it would force a full style recalc. The scroll position
			// is read once per frame in processUpdates, before its own writes.
		if (!this.layout.consumeAdjustingScroll()) {
			this.pool.noteUserScroll();
			// Unloads are deferred while scrolling (see processIoPending);
			// reclaim far sections once the gesture settles.
			this.pool.scheduleIdleUnload();
		}
		};
		this.scrollContainer.addEventListener('scroll', this.boundScrollHandler, { passive: true });

		this.boundClickHandler = (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			const chevron = target.closest('.book-fold-chevron') as HTMLElement | null;
			if (!chevron) return;
			const foldId = chevron.dataset.foldId;
			if (!foldId) return;
			evt.stopPropagation();
			this.toggleFold(foldId);
		};
		this.scrollContainer.addEventListener('click', this.boundClickHandler);
	}

	render(): void {
		const readPromises = this.pool.render(this.links);
		this.layout.recalcOffsets();
		void Promise.allSettled(readPromises).then(() => {
			this.buildHeadingIndex();
			// Re-tag any sections that were loaded before the heading index existed
			for (const [p, d] of this.sections) {
				if (d.component) {
					this.fold.tagFoldIds(p, d.el);
				}
			}
			this.scheduleUpdate();
		});
	}

	private buildHeadingIndex(): void {
		this.headingIndex.length = 0;
		this.headingIndexById.clear();
		this.firstHeadingByPath.clear();
		this.headingsByPath.clear();

		for (let fi = 0; fi < this.fileOrder.length; fi++) {
			const path = this.fileOrder[fi] ?? '';
			const content = this.rawContent.get(path);
			if (!content) continue;

			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;
				const match = line.trim().match(/^(#{1,6})\s+(.+)/);
				if (match) {
					const node: HeadingNode = {
						id: `${path}#L${i}`,
						path,
						level: (match[1] as string).length,
						text: (match[2] as string).trim(),
						idx: this.headingIndex.length,
						fileIdx: fi,
					};
					this.headingIndex.push(node);
					this.headingIndexById.set(node.id, node);
					if (!this.firstHeadingByPath.has(path)) {
						this.firstHeadingByPath.set(path, node);
					}
					let list = this.headingsByPath.get(path);
					if (!list) {
						list = [];
						this.headingsByPath.set(path, list);
					}
					list.push(node);
				}
			}
		}
	}

	toggleFold(id: string): void {
		this.fold.toggleFold(id);
	}

	isFolded(id: string): boolean {
		return this.fold.isFolded(id);
	}

	applyThemeSpacings(spacings: ThemeSpacings): void {
		this.layout.applyThemeSpacings(spacings);
		this.scheduleUpdate();
	}

	addFrameCallback(cb: () => void): void {
		if (!this.frameCallbacks.includes(cb)) this.frameCallbacks.push(cb);
	}

	removeFrameCallback(cb: () => void): void {
		const i = this.frameCallbacks.indexOf(cb);
		if (i >= 0) this.frameCallbacks.splice(i, 1);
	}

	/** Request a frame (used by the scroll spy to coalesce its read with updates). */
	requestFrame(): void {
		this.scheduleFrame();
	}

	scheduleUpdate(): void {
		this.updateRequested = true;
		this.scheduleFrame();
	}

	private scheduleFrame(): void {
		if (this.rafId) return;
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = 0;
			this.runFrame();
		});
	}

	private runFrame(): void {
		if (this.pool.hasPendingIo()) {
			this.updateRequested = true;
		}
		if (this.updateRequested) {
			this.updateRequested = false;
			this.processUpdates();
		}
		// Frame callbacks (the scroll spy) run AFTER processUpdates, not
		// before: they read data.offset values and scrollTop, which are only
		// meaningful once height corrections, folds, and width changes were
		// applied. Running the spy first made it compute the active heading
		// from stale offsets, so right after a section resized/folded the
		// highlight landed on the wrong ToC entry until the next scroll frame.
		// In the common plain-scroll frame processUpdates is a no-op and the
		// layout is still clean, so the spy's reads stay cheap.
		for (const cb of this.frameCallbacks) {
			cb();
		}
		// DOM load/unload is deferred to a macrotask after the render so this
		// frame never pays the first layout of freshly mounted heavy content.
		this.pool.scheduleIoWork();
	}

	private processUpdates(): void {
		const freshScrollTop = this.scrollContainer.scrollTop;
		// Jump detection moved out of the scroll handler: it now runs once per
		// frame right before the offset writes, where the read is cheap.
		const delta = Math.abs(freshScrollTop - this.lastScrollTop);
		this.lastScrollTop = freshScrollTop;
		if (delta > 2000) {
			this.pool.pruneRenderQueue((p) => {
				const d = this.sections.get(p);
				if (!d || d.component) return false;
				const rect = d.el.getBoundingClientRect();
				return Math.abs(rect.top) < 4000;
			});
		}
		const anchor = this.layout.takeAnchor(freshScrollTop);
		this.dbg('update', '', this.pendingHeights.size, anchor ? anchor.idx : -1, anchor ? Math.round(anchor.anchorOffset) : -1);

		if (this.pendingWidthChange) {
			this.pendingWidthChange = false;
			for (const [path, data] of this.sections) {
				if (!data.el.querySelector('.markdown-rendered')) {
					const content = this.rawContent.get(path);
					if (content) {
						data.height = estimateHeight(content);
					}
					this.heightCache.delete(path);
					data.heightTrusted = false;
				}
			}
		}

		if (this.pendingHeights.size > 0) {
			for (const [path, newHeight] of this.pendingHeights) {
				const data = this.sections.get(path);
				if (!data) continue;
				data.height = newHeight;
				this.heightCache.set(path, newHeight);
				this.persistence.put?.(path, data.mtime, newHeight);
				data.heightTrusted = true;
			}
			this.pendingHeights.clear();
		}

		this.layout.recalcOffsets();
		this.layout.restoreScrollAt(anchor, freshScrollTop);
	}

	getOffset(path: string): number {
		return this.layout.getOffset(path);
	}

	getAllOffsets(): Map<string, number> {
		return this.layout.getAllOffsets();
	}

	refreshSection(path: string): void {
		this.pool.refreshSection(path);
	}

	markDirty(path: string): void {
		this.pool.refreshSection(path);
	}

	destroy(): void {
		this.destroyed = true;
		this.frameCallbacks.length = 0;
		if (this.rafId) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.containerWidthObserver.disconnect();
		if (this.boundScrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.boundScrollHandler);
		}
		if (this.boundClickHandler) {
			this.scrollContainer.removeEventListener('click', this.boundClickHandler);
		}
		this.fold.destroy();
		this.pool.destroy();
		this.layout.destroy();
		for (const [, data] of this.sections) {
			data.component?.unload();
		}
		this.sections.clear();
		this.fileOrder = [];
		this.heightCache.clear();
		this.pendingHeights.clear();
		this.renderedDomCache.clear();
		this.rawContent.clear();
	}
}
