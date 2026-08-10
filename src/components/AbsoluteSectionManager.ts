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

// Debug: global main-thread frame counter, independent of the book manager.
// It shows whether the note tab actually keeps rendering at ~60fps while the
// user reads a note with the ToC panel open — if a background loop (book
// manager, ToC smooth scroll, etc.) is hogging the main thread, the rAF
// callbacks fire less often and the count per second drops. Runs only while
// DebugLog is enabled; the loop stops itself on disable (an idle rAF callback
// would otherwise wake the main thread ~60×/s doing nothing).
let dbgGlobalFrames = 0;
let dbgGlobalProbeRunning = false;
export function ensureGlobalFrameProbe(): void {
	if (dbgGlobalProbeRunning) return;
	if (!DebugLog.enabled) return;
	dbgGlobalProbeRunning = true;
	let last = performance.now();
	let frames = 0;
	const loop = (now: number): void => {
		if (!DebugLog.enabled) {
			dbgGlobalProbeRunning = false;
			return;
		}
		frames++;
		dbgGlobalFrames++;
		const elapsed = now - last;
		if (elapsed >= 1000) {
			const fps = Math.round((frames * 1000) / elapsed);
			frames = 0;
			last = now;
			// Report independently of the book manager so low fps is caught
			// even when the manager itself is idle (no DBG window open).
			if (fps < 50) DebugLog.log('DBG', '', `fps=${fps}`, 'low-fps', '');
		}
		window.requestAnimationFrame(loop);
	};
	window.requestAnimationFrame(loop);
}

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

	/** Incremented whenever recalcOffsets runs, so the ToC spy can skip
	 *  recomputing per-entry positions when the section offsets did not move. */
	private layoutVersion = 0;
	getLayoutVersion(): number {
		return this.layoutVersion;
	}

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
	// Viewport snapshot from the last frame. Read once per frame in runFrame
	// (next to the scrollTop read, so it shares the same layout flush) and
	// handed to the pool: reading scrollTop/clientHeight inside the IO
	// macrotask would force a reflow of the DOM the section loads just mounted.
	private lastScrollTop = 0;
	private lastClientHeight = 0;
	private boundScrollHandler: ((evt: Event) => void) | null = null;
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

	// Debug: scroll-source diagnostics.
	private dbgFs = 0;
	private dbgUs = 0;
	private dbgHs = 0;
	private dbgSps = 0;
	private dbgSev = 0;
	private dbgSevB = 0;
	private dbgT0 = 0;
	private dbgSpam = new Map<string, number>();
	// Debug: scroll writer probe (who sets scrollTop / calls scrollTo).
	private dbgST = 0;
	private dbgScrollToCalls = 0;
	private dbgWriters: string[] = [];
	private dbgStackCaptured = 0;
	// Debug: wheel events (user scrolling input) on the book container.
	private dbgWheel = 0;
	// Debug: per-second ms spent in the frame, processUpdates, frame
	// callbacks (ToC tick), and ToC tagHeadings (fed by BookTocView).
	private dbgFrameMs = 0;
	private dbgUpdMs = 0;
	private dbgCbMs = 0;
	/** Debug: accumulated ms spent in TocController.tagHeadings. */
	static dbgTagMs = 0;
	/** Debug: frames rendered by the whole main thread in the last DBG window. */
	static dbgFps = 0;
	/** Debug: number of actual getBoundingClientRect heading measurements done by
	 *  tagHeadings in the last DBG window (fed by TocController). Distinguishes
	 *  "each measurement got more expensive" (dirty-layout reflow) from "more
	 *  measurements ran" (headingOffsets cache is being invalidated). */
	static dbgTagRects = 0;

	// Thin wrapper keeping call sites readable; logic lives in utils/debug.
	private dbg(
		msg: string,
		path?: string,
		a?: number | string,
		b?: number | string,
		c?: number | string,
		d?: number | string,
	): void {
		DebugLog.log(msg, path, a, b, c, d);
	}

	// Debug: wraps scrollTop/scrollTo/scrollBy on the book container to
	// record who writes the scroll position. Native browser adjustments
	// (scroll anchoring, user input, scrollIntoView) bypass these JS hooks, so
	// if `top` climbs while st/to are 0 the writer is external.
	private installScrollWriterProbe(): void {
		const el = this.scrollContainer;
		// Debug probe: aliasing `this` is intentional here — the accessor
		// functions below run with `this` = the element, not the manager.
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- see above
		const self = this;
		const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
		if (desc?.set && desc.get) {
			// Narrow the descriptor so the probe can re-bind the accessors to
			// the element instance (kept attached to `sd` for the lint rule).
			const sd = desc as { get: () => number; set: (v: number) => void };
			Object.defineProperty(el, 'scrollTop', {
				configurable: true,
				get() {
					return sd.get.call(this);
				},
				set(v: number) {
					if (DebugLog.enabled) {
						self.dbgST++;
						if (self.dbgStackCaptured < 4) {
							self.dbgStackCaptured++;
							self.dbgWriters.push(
								`scrollTop=${Math.round(v)} ${self.stackLabel()}`,
							);
						}
					}
					sd.set.call(this, v);
				},
			});
		}
		const wrap = (name: 'scrollTo' | 'scrollBy', original: (...a: unknown[]) => void): void => {
			(el as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
				if (DebugLog.enabled) {
					self.dbgScrollToCalls++;
					if (self.dbgStackCaptured < 4) {
						self.dbgStackCaptured++;
						self.dbgWriters.push(`${name} ${self.stackLabel()}`);
					}
				}
				original(...args);
			};
		};
		wrap('scrollTo', (el.scrollTo as (...a: unknown[]) => void).bind(el));
		wrap('scrollBy', (el.scrollBy as (...a: unknown[]) => void).bind(el));
	}

	private stackLabel(): string {
		return new Error().stack?.split('\n').slice(2, 5).join(' | ') ?? '';
	}

	/** Records a measured height delivered by the SectionPool's resize observer. */
	reportSectionHeight(path: string, newHeight: number): void {
		this.dbgHs++;
		const c = (this.dbgSpam.get(path) ?? 0) + 1;
		this.dbgSpam.set(path, c);
		this.pendingHeights.set(path, newHeight);
		if (this.pendingHeights.size > 0) {
			this.scheduleUpdate();
		}
	}

	onHeightMeasured: ((path: string, estimated: number, actual: number) => void) | null = null;
	onSectionRendered: ((path: string, container: HTMLElement) => void) | null = null;
	/** Fired before a section is re-rendered because its content changed
	 *  (markDirty), as opposed to a churn re-mount of identical content. */
	onSectionContentChanged: ((path: string) => void) | null = null;

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
		ensureGlobalFrameProbe();
		this.installScrollWriterProbe();
		this.scrollContainer.addEventListener(
			'wheel',
			() => {
				this.dbgWheel++;
			},
			{ passive: true, capture: true },
		);

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
			getScrollTop: () => this.getScrollTop(),
			getClientHeight: () => this.getClientHeight(),
			getContainerWidth: () => this.lastContainerWidth,
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
				// Debug: does the book container collapse to 0 when the tab
				// is hidden (background tab), faking a real width change?
				this.dbg('width-resize', '', Math.round(newWidth), Math.round(this.lastContainerWidth));
				// A hidden tab reports a 0-sized box (display:none). That is not a
				// real width change: honoring it mass-resets section heights and
				// re-queues the whole book for prerender while the user reads
				// another note. Skip 0-sized observations; the visible width is
				// compared on the next non-zero observation.
				if (newWidth === 0) continue;
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
			dbg: (msg, path, a, b, c, d) => this.dbg(msg, path, a, b, c, d),
		});

		this.boundScrollHandler = (evt: Event) => {
			// Only react to the book's own scroll: scroll events bubble, so a
			// nested scrollable inside a section (code block, table, embed)
			// firing a scroll event would otherwise wake the spy and start a
			// frame for a scroll that did not move the book.
			if (evt.target !== this.scrollContainer) {
				this.dbgSevB++;
				return;
			}
			this.dbgSev++;
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
			// Links keep normal navigation; everything else inside a tagged
			// heading toggles that heading's fold (the chevron is now a CSS
			// pseudo-element, so the whole heading is the click target, like
			// Obsidian's own reading-mode fold).
			if (target.closest('a')) return;
			const heading = target.closest<HTMLElement>('[data-fold-id]');
			if (!heading) return;
			const foldId = heading.dataset.foldId;
			if (!foldId) return;
			evt.stopPropagation();
			this.toggleFold(foldId);
		};
		this.scrollContainer.addEventListener('click', this.boundClickHandler);
	}

	render(): void {
		const readPromises = this.pool.render(this.links);
		this.layout.recalcOffsets(this.scrollContainer.scrollTop, this.scrollContainer.clientHeight);
		this.layoutVersion++;
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
		this.dbgSps++;
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
		this.dbgFs++;
		const t0 = performance.now();
		// Jump detection runs on every frame, not only update frames: a large
		// scroll delta must prune stale render-queue entries even when the
		// frame's only job is the scroll spy. One scrollTop read plus a compare
		// is cheap; the expensive prune only runs on >2000px jumps.
		const scrollTop = this.scrollContainer.scrollTop;
		const delta = Math.abs(scrollTop - this.lastScrollTop);
		this.lastScrollTop = scrollTop;
		this.lastClientHeight = this.scrollContainer.clientHeight;
		if (delta > 2000) {
			this.pool.pruneRenderQueue((p) => {
				const d = this.sections.get(p);
				if (!d || d.component) return false;
				const rect = d.el.getBoundingClientRect();
				return Math.abs(rect.top) < 4000;
			});
		}
		// IO (section load/unload) never changes offsets, so it no longer forces
		// an update: recalcOffsets runs only when geometry actually changed
		// (height measurements, width resets, fold toggles, theme spacings, or
		// firstType/lastType changes after a re-render). Every scheduleUpdate
		// caller signals one of those; pure-IO frames now skip the offset
		// cascade, the layoutVersion bump, and the anchor lookup entirely.
		// Corrections are applied immediately (never batched until the scroll
		// settles): recalcOffsets only rewrites transforms in a window around
		// the viewport, so the per-frame cost is a few milliseconds and nothing
		// accumulates into a big layout shift once the user stops scrolling.
		if (this.updateRequested) {
			this.updateRequested = false;
			const t1 = performance.now();
			this.processUpdates(scrollTop);
			this.dbgUpdMs += performance.now() - t1;
			this.dbgUs++;
		}
		// Placeholder transforms in the viewport window can go stale when a
		// section's offset changed while it sat far below — and plain scrolling
		// alone never triggers a recalc, so a stale placeholder stays where the
		// IO never fires and the section never loads (blank area without text).
		// Refresh the window every frame using the always-current data.offset:
		// cheap (binary search to the window, writes only changed transforms).
		this.layout.refreshWindowTransforms(scrollTop, this.lastClientHeight);
		// Frame callbacks (the scroll spy) run AFTER processUpdates, not
		// before: they read data.offset values and scrollTop, which are only
		// meaningful once height corrections, folds, and width changes were
		// applied. Running the spy first made it compute the active heading
		// from stale offsets, so right after a section resized/folded the
		// highlight landed on the wrong ToC entry until the next scroll frame.
		// In the common plain-scroll frame processUpdates is a no-op and the
		// layout is still clean, so the spy's reads stay cheap.
		const t2 = performance.now();
		for (const cb of this.frameCallbacks) {
			cb();
		}
		this.dbgCbMs += performance.now() - t2;
		// DOM load/unload is deferred to a macrotask after the render so this
		// frame never pays the first layout of freshly mounted heavy content.
		this.pool.scheduleIoWork();
		this.dbgFrameMs += performance.now() - t0;
		this.dbgTick();
	}

	// Debug: prints a per-second summary of what keeps the frame loop alive.
	// `sev` = scroll events whose target is the book container itself, `sevB` =
	// bubbled scroll events from nested scrollables inside sections. The whole
	// summary (including counter resets) is skipped while DebugLog is disabled.
	private dbgTick(): void {
		if (!DebugLog.enabled) return;
		const now = performance.now();
		if (!this.dbgT0) this.dbgT0 = now;
		if (now - this.dbgT0 < 1000) return;
		const [io, loads, unloads, prerenders] = this.pool.dbgReset();
		const spam = [...this.dbgSpam.entries()].filter(([, c]) => c >= 3).map(([p, c]) => `${p.split('/').pop()}:${c}`).join(' ');
		const writers = this.dbgWriters.splice(0).join(' ;; ');
		this.dbg(
			'DBG', '',
			`frames=${this.dbgFs} upd=${this.dbgUs} h=${this.dbgHs} spy=${this.dbgSps} sev=${this.dbgSev} sevB=${this.dbgSevB} st=${this.dbgST} to=${this.dbgScrollToCalls} w=${this.dbgWheel}`,
			`io=${io} ld=${loads} ul=${unloads} pr=${prerenders}`,
			`top=${Math.round(this.scrollContainer.scrollTop)} spam=${spam}${writers ? ` writers=${writers}` : ''}`,
			`fr=${this.dbgFrameMs.toFixed(1)}ms upd=${this.dbgUpdMs.toFixed(1)}ms cb=${this.dbgCbMs.toFixed(1)}ms tag=${AbsoluteSectionManager.dbgTagMs.toFixed(1)}ms rects=${AbsoluteSectionManager.dbgTagRects} fps=${AbsoluteSectionManager.dbgFps}`,
		);
		this.dbgT0 = now;
		this.dbgFs = 0;
		this.dbgUs = 0;
		this.dbgHs = 0;
		this.dbgSps = 0;
		this.dbgSev = 0;
		this.dbgSevB = 0;
		this.dbgST = 0;
		this.dbgFrameMs = 0;
		this.dbgUpdMs = 0;
		this.dbgCbMs = 0;
		AbsoluteSectionManager.dbgTagMs = 0;
		this.dbgScrollToCalls = 0;
		this.dbgWheel = 0;
		this.dbgStackCaptured = 0;
		this.dbgSpam.clear();
		AbsoluteSectionManager.dbgFps = dbgGlobalFrames;
		AbsoluteSectionManager.dbgTagRects = 0;
		dbgGlobalFrames = 0;
	}

	private processUpdates(scrollTop: number): void {
		// Anchor snapshot for the scroll compensation after the layout shifts.
		// Jump detection (lastScrollTop / pruneRenderQueue) now lives in
		// runFrame so it runs even on pure-spy frames.
		const anchor = this.layout.takeAnchor(scrollTop);
		this.dbg('update', '', this.pendingHeights.size, anchor ? anchor.idx : -1, anchor ? Math.round(anchor.anchorOffset) : -1);

		if (this.pendingWidthChange) {
			this.pendingWidthChange = false;
			let widthResetCount = 0;
			for (const [path, data] of this.sections) {
				if (!data.el.querySelector('.markdown-rendered')) {
					const content = this.rawContent.get(path);
					if (content) {
						data.height = estimateHeight(content);
					}
					this.heightCache.delete(path);
					data.heightTrusted = false;
					widthResetCount++;
				}
			}
			// Debug: how many sections lost height trust to this width change.
			this.dbg('width-reset', '', widthResetCount);
		}

		if (this.pendingHeights.size > 0) {
			for (const [path, newHeight] of this.pendingHeights) {
				const data = this.sections.get(path);
				if (!data) continue;
				data.height = newHeight;
				this.heightCache.set(path, newHeight);
				this.persistence.put?.(path, data.mtime, this.lastContainerWidth, newHeight);
				data.heightTrusted = true;
			}
			this.pendingHeights.clear();
		}

		this.layout.recalcOffsets(scrollTop, this.lastClientHeight);
		this.layoutVersion++;
		this.layout.restoreScrollAt(anchor, scrollTop);
	}

	getOffset(path: string): number {
		return this.layout.getOffset(path);
	}

	getScrollTop(): number {
		return this.lastScrollTop;
	}

	getClientHeight(): number {
		return this.lastClientHeight;
	}

	getAllOffsets(): Map<string, number> {
		return this.layout.getAllOffsets();
	}

	refreshSection(path: string): void {
		this.pool.refreshSection(path);
	}

	markDirty(path: string): void {
		this.onSectionContentChanged?.(path);
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
