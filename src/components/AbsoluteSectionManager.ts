import { App, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';
import type { HeadingNode } from '../utils/fold';
import { FoldController } from './FoldController';
import { SectionPool } from './SectionPool';
import type { SectionData, HeightPersistence } from './SectionPool';
import { ScrollGuard, type ScrollGuardEvent } from './ScrollGuard';
import { SectionLayout } from './SectionLayout';
import { estimateHeight } from '../utils/content';
import type { ThemeSpacings } from '../utils/theme';
import { DebugLog } from '../utils/debug';

// A scroll gesture counts as active for this long after the last scroll
// activity (wheel/flick step, anchor restore, programmatic jump). While active,
// layout-flush-heavy work is deferred: ToC heading rect reads (each forces a
// style recalc inside a scroll frame) and the scrollTop compensation write
// (which fires a scroll event that restarts the frame + IO loop — the cold-start
// churn where sev≈frames in the debug log). The line-based ToC fallback covers
// the highlight, and a settle update applies the compensation once the gesture
// ends.
const GESTURE_DEFER_MS = 700;

// Compensations larger than this are anchored immediately even mid-gesture;
// smaller ones defer to the settle update (GESTURE_DEFER_MS). Deferring makes
// the slide visible: a section above the viewport that loads taller than its
// estimate pushes the reading content DOWN by the correction amount, which
// reads as a "bounce" while scrolling up — so the bar must not be too high.
// History: 24px left many-small-notes areas visibly sliding mid-scroll; 8px
// covered sub-pixel noise. A 40px mid-glide bar (deferring most corrections
// while a flick glides) was tried and reverted: unanchored drift up to 40px
// per fresh mount moved content under a stationary viewport, and the settle
// applied the accumulated batch as one visible post-scroll snap. Stable
// reading content beats exact wheel-travel distances — keep the bar low.
const GESTURE_ANCHOR_PX = 8;

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

	/** Debug: scroll-source diagnostics.
	 *  scrollTop/scrollTo writer logging is fed by the ScrollGuard's event
	 *  hook (the guard owns the container's accessors), including foreign
	 *  writes it blocks. */
	private dbgFs = 0;
	private dbgUs = 0;
	private dbgHs = 0;
	private dbgSps = 0;
	private dbgSev = 0;
	private dbgSevB = 0;
	private dbgT0 = 0;
	private dbgSpam = new Map<string, number>();
	// Debug: scroll writer diagnostics (fed by the ScrollGuard).
	private dbgST = 0;
	private dbgScrollToCalls = 0;
	private dbgWriters: string[] = [];
	/** Debug: foreign writes blocked by the ScrollGuard in the last window. */
	private dbgBlk = 0;

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
	/** Timer that removes the is-scrolling class after scrolling settles. */
	private scrollIdleTimer = 0;
	private boundClickHandler: ((evt: MouseEvent) => void) | null = null;
	/** Set per scroll event by boundScrollHandler (which runs before the spy's
	 *  scroll listener): true when the event came from a compensation write.
	 *  The spy reads it via isAdjustingScroll() to skip scheduling a frame for
	 *  a write that did not move the book. */
	private lastScrollWasAdjusting = false;
	private lastContainerWidth = 0;
	private pendingHeights: Map<string, number> = new Map();
	private pendingWidthChange = false;
	private rafId = 0;
	private destroyed = false;
	/** Frame callbacks run at the start of the frame, before processUpdates
	 *  writes section positions, so their layout reads see a clean layout. */
	private frameCallbacks: (() => void)[] = [];
	private pool: SectionPool;

	// Debug: wheel events (user scrolling input) on the book container.
	private dbgWheel = 0;
	/** Debug: scrollTop compensations skipped because a gesture was active
	 *  (Phase 3b). A high count with rs≈0 in the DBG line confirms the loop
	 *  break is doing work; the settle update applies them at the end. */
	private dbgDeferComp = 0;
	private dbgAnchorDuringGesture = 0;
	/** Settle timer for the compensation deferred during an active gesture. */
	private deferCompTimer = 0;
	// Debug: per-second ms spent in the frame, processUpdates, frame
	// callbacks (ToC tick), and ToC tagHeadings (fed by BookTocView).
	private dbgFrameMs = 0;
	private dbgUpdMs = 0;
	private dbgCbMs = 0;
	// Debug: processUpdates sub-step breakdown (anchor lookup, height apply,
	// offset recalc, scroll restore) — pinpoints where per-update ms go.
	private dbgAnchorMs = 0;
	private dbgApplyMs = 0;
	private dbgRecalcMs = 0;
	private dbgRestoreMs = 0;
	/** Debug: accumulated ms spent in TocController.tagHeadings. Instance (not
	 *  static) so a second Book-view pane's ToC can't pool its rect work into
	 *  this manager's DBG window (the 06:11 tag=3258ms/rects=2276 anomaly:
	 *  frames=42 cannot budget 2276 rects across ~72 sections of 8-rect/6ms
	 *  frames, so the counters were shared across managers). */
	dbgTagMs = 0;
	/** Debug: frames rendered by the whole main thread in the last DBG window. */
	dbgFps = 0;
	/** Debug: number of actual getBoundingClientRect heading measurements done by
	 *  tagHeadings in the last DBG window (fed by TocController). Distinguishes
	 *  "each measurement got more expensive" (dirty-layout reflow) from "more
	 *  measurements ran" (headingOffsets cache is being invalidated). */
	dbgTagRects = 0;

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
		guard: ScrollGuard | null = null,
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
		// The ScrollGuard owns the container's scroll accessors (installed by
		// the view before this manager); its event hook feeds the writer
		// diagnostics here, foreign blocked writes included.
		if (guard) {
			guard.onEvent = (e: ScrollGuardEvent) => {
				if (!DebugLog.enabled) return;
				if (e.blocked) {
					this.dbgBlk++;
					this.dbgWriters.push(`BLOCKED ${e.kind}=${e.value === null ? '' : Math.round(e.value)} ${e.label}`);
				} else if (e.kind === 'scrollTop') {
					this.dbgST++;
					this.dbgWriters.push(`scrollTop=${Math.round(e.value ?? 0)} ${e.label}`);
				} else {
					this.dbgScrollToCalls++;
					this.dbgWriters.push(`${e.kind} ${e.label}`);
				}
			};
		}
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
				this.lastScrollWasAdjusting = false;
				return;
			}
			this.dbgSev++;
			// No scrollTop read here: a scroll event can be dispatched while
			// the book layout is still dirty (async height measurements), and
			// reading it would force a full style recalc. The scroll position
			// is read once per frame in processUpdates, before its own writes.
			// The one-shot flag is consumed here — boundScrollHandler is
			// registered before the spy's scroll listener, so this event is
			// marked before the spy runs and it skips scheduling a frame for a
			// write that did not move the book.
			this.lastScrollWasAdjusting = this.layout.consumeAdjustingScroll();
			if (!this.lastScrollWasAdjusting) {
				this.pool.noteUserScroll();
				// Unloads are deferred while scrolling (see processIoPending);
				// reclaim far sections once the gesture settles.
				this.pool.scheduleIdleUnload();
			}
			// Pause CSS animations while scrolling to reduce compositing work.
			// The is-scrolling class is removed 200ms after the last scroll
			// event so animations resume once the gesture settles.
			this.scrollContainer.classList.add('is-scrolling');
			window.clearTimeout(this.scrollIdleTimer);
			this.scrollIdleTimer = window.setTimeout(() => {
				this.scrollContainer.classList.remove('is-scrolling');
			}, 200);
		};
		this.scrollContainer.addEventListener('scroll', this.boundScrollHandler, { passive: true });

		this.boundClickHandler = (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			// Links keep normal navigation.
			if (target.closest('a')) {
				// Diagnostic: a click on a link inside a fold heading bypasses
				// the fold hit-test entirely and lets Obsidian navigate (which
				// can trigger the active-leaf-change scroll restore). Log the
				// anchor to tell internal links from native heading anchors.
				const inHeading = target.closest<HTMLElement>('[data-fold-id]');
				if (inHeading) {
					const a = target.closest('a');
					this.dbg(
						'fold-link',
						inHeading.dataset.foldId || '',
						`<${target.tagName.toLowerCase()}${target.className ? '.' + String(target.className).trim().split(/\s+/).join('.') : ''}> ${a?.getAttribute('data-href') || a?.getAttribute('href') || ''}`,
					);
				}
				return;
			}
			const heading = target.closest<HTMLElement>('[data-fold-id]');
			if (!heading) return;
			const foldId = heading.dataset.foldId;
			if (!foldId) return;
			// The fold chevron is a CSS pseudo-element on the tagged heading
			// (styles.css .book-section-absolute [data-fold-id]::before): a
			// 16x16px box at left -19px, vertically centered. Pseudo-elements
			// are not click targets — a click on one reports the heading itself
			// — so detect the hit by position instead of giving the chevron a
			// real DOM node (heading-dense notes must not mount an icon per
			// heading). Clicks on the heading text no longer toggle the fold.
			const rect = heading.getBoundingClientRect();
			const chevronWidth = 16;
			const chevronLeft = rect.left - 19;
			const chevronCenterY = rect.top + rect.height / 2;
			const chevronHit =
				evt.clientX >= chevronLeft &&
				evt.clientX <= chevronLeft + chevronWidth &&
				Math.abs(evt.clientY - chevronCenterY) <= chevronWidth / 2;
			const bodyZoom = parseFloat(document.body.style.zoom) || 1;
			this.dbg(
				'fold-click',
				foldId,
				`cx=${Math.round(evt.clientX)} cy=${Math.round(evt.clientY)} left=${rect.left.toFixed(1)} top=${rect.top.toFixed(1)} h=${rect.height.toFixed(1)} zoom=${bodyZoom} hit=${chevronHit ? 1 : 0}`,
			);
			if (!chevronHit) return;
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

	/** True while the user's scroll is recent enough that layout-flush-heavy
	 *  work (ToC rect reads, scrollTop compensation) should be deferred. The
	 *  pool's lastUserScrollAt is refreshed by every scroll event and by any
	 *  frame-to-frame scrollTop movement, so a wheel flick keeps this true for
	 *  the whole glide and it flips false ~withinMs after the last movement.
	 *  Callers that only need "has the book stopped moving" can pass a short
	 *  window; the default keeps the full defer for work that must wait for
	 *  the whole settle. */
	isGestureActive(withinMs: number = GESTURE_DEFER_MS): boolean {
		return Date.now() - this.pool.lastUserScrollAt < withinMs;
	}

	/** True when the most recent book scroll event was caused by a compensation
	 *  write (boundScrollHandler marked it before the spy's listener ran). The
	 *  spy skips the frame for such events: the book did not move, so the
	 *  highlight/centering already reflect the position. */
	isAdjustingScroll(): boolean {
		return this.lastScrollWasAdjusting;
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
		// IO is the fast-path enqueue signal but can go stale: a section whose
		// offset moved (neighbor height correction, width reset) or whose render
		// was aborted mid-flight by a fast scroll is visible yet never
		// re-enqueued (no crossing left to fire the observer). Reconcile the
		// load window against fresh offsets every frame so any visible-but-
		// unmounted section always has a render queued. scrollTop here is the
		// frame's own read, so this costs no extra layout flush.
		this.pool.reconcileVisibleSections(scrollTop, this.lastClientHeight);
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
		const [io, loads, unloads, prerenders, renderMs, aborts, placeholders, upgrades, queueMs] = this.pool.dbgReset();
		// Live-mounted metric: number of sections with a rendered component and
		// the total height they occupy. Compares directly against the fixed IO
		// window (OVERSCAN_TOP + loadMargin + viewport): if mounted count/area is
		// higher on the big book, the win-px window holds more DOM/layers there,
		// which is what shows up as extra Painting/Layout.
		let mounts = 0;
		let mountH = 0;
		for (const [, d] of this.sections) {
			if (d.component) {
				mounts++;
				mountH += d.height;
			}
		}
		const spam = [...this.dbgSpam.entries()].filter(([, c]) => c >= 3).map(([p, c]) => `${p.split('/').pop()}:${c}`).join(' ');
		const writers = this.dbgWriters.splice(0).join(' ;; ');
		this.dbg(
			'DBG', '',
			`frames=${this.dbgFs} upd=${this.dbgUs} h=${this.dbgHs} spy=${this.dbgSps} sev=${this.dbgSev} sevB=${this.dbgSevB} st=${this.dbgST} to=${this.dbgScrollToCalls} blk=${this.dbgBlk} w=${this.dbgWheel}`,
			`io=${io} ld=${loads} ul=${unloads} pr=${prerenders} rm=${Math.round(renderMs)}ms ab=${aborts} ph=${placeholders} up=${upgrades} mounts=${mounts} mh=${Math.round(mountH)}`,
			`top=${Math.round(this.scrollContainer.scrollTop)} spam=${spam}${writers ? ` writers=${writers}` : ''}`,
			`fr=${this.dbgFrameMs.toFixed(1)}ms q=${queueMs.toFixed(1)}ms upd=${this.dbgUpdMs.toFixed(1)}ms[an=${this.dbgAnchorMs.toFixed(1)} ap=${this.dbgApplyMs.toFixed(1)} rc=${this.dbgRecalcMs.toFixed(1)} rs=${this.dbgRestoreMs.toFixed(1)}] cb=${this.dbgCbMs.toFixed(1)}ms tag=${this.dbgTagMs.toFixed(1)}ms rects=${this.dbgTagRects} fps=${this.dbgFps} dc=${this.dbgDeferComp} ac=${this.dbgAnchorDuringGesture}`,
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
		this.dbgAnchorMs = 0;
		this.dbgApplyMs = 0;
		this.dbgRecalcMs = 0;
		this.dbgRestoreMs = 0;
		this.dbgTagMs = 0;
		this.dbgScrollToCalls = 0;
		this.dbgBlk = 0;
		this.dbgWheel = 0;
		this.dbgSpam.clear();
		this.dbgFps = dbgGlobalFrames;
		this.dbgTagRects = 0;
		this.dbgDeferComp = 0;
		this.dbgAnchorDuringGesture = 0;
		dbgGlobalFrames = 0;
	}

	private processUpdates(scrollTop: number): void {
		let t = performance.now();
		// Anchor snapshot for the scroll compensation after the layout shifts.
		// Jump detection (lastScrollTop / pruneRenderQueue) now lives in
		// runFrame so it runs even on pure-spy frames.
		const anchor = this.layout.takeAnchor(scrollTop);
		this.dbgAnchorMs += performance.now() - t;
		this.dbg('update', '', this.pendingHeights.size, anchor ? anchor.idx : -1, anchor ? Math.round(anchor.anchorOffset) : -1);
		t = performance.now();

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
		this.dbgApplyMs += performance.now() - t;
		t = performance.now();

		this.layout.recalcOffsets(scrollTop, this.lastClientHeight);
		this.dbgRecalcMs += performance.now() - t;
		t = performance.now();
		this.layoutVersion++;
		if (this.isGestureActive()) {
			// Phase 3b: skip the scrollTop compensation write while the gesture
			// is active. Each write repositions the view to the same content
			// point, but it also fires a scroll event that restarts the frame +
			// IO loop (height change → recalc → scrollTop write → scroll event →
			// frames → new loads — the cold-start churn where sev≈frames in the
			// debug log). The anchor is left un-applied; the settle timer runs
			// one compensation update once the gesture ends. The visual cost is
			// that content shifts with each correction instead of being held
			// still — masked by the scroll, and re-anchored at settle. Large
			// corrections are not masked though (a section above loading taller
			// than its estimate slides the reading content down mid-scroll), so
			// those are anchored immediately.
			if (this.layout.restoreScrollAt(anchor, scrollTop, GESTURE_ANCHOR_PX)) {
				this.dbgAnchorDuringGesture++;
			} else {
				this.dbgDeferComp++;
				this.armDeferredCompensation();
			}
		} else {
			this.layout.restoreScrollAt(anchor, scrollTop);
		}
		this.dbgRestoreMs += performance.now() - t;
	}

	/** Run one update once the gesture settles so the compensation skipped
	 *  during it is applied. Self-extending: if the gesture is still active
	 *  when the timer fires, processUpdates re-skips and re-arms, so the first
	 *  tick after the last movement compensates the accumulated corrections. */
	private armDeferredCompensation(): void {
		if (this.deferCompTimer) return;
		this.deferCompTimer = window.setTimeout(() => {
			this.deferCompTimer = 0;
			if (this.destroyed) return;
			this.scheduleUpdate();
		}, GESTURE_DEFER_MS);
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

	/** Raw file text held by the pool for already-read sections, or null when
	 *  the file has not been read yet. Search falls back to cachedRead on null. */
	getRawContent(path: string): string | null {
		return this.rawContent.get(path) ?? null;
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
		if (this.deferCompTimer) {
			window.clearTimeout(this.deferCompTimer);
			this.deferCompTimer = 0;
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
