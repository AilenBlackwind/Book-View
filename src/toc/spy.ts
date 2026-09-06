import { TocState } from './state';
import { HEIGHT_PER_LINE } from './types';
import { pickActiveIndex } from '../utils/toc';
import { DebugLog } from '../utils/debug';

/** How close to the panel edge the active row may get before the panel
 *  scrolls to keep it visible (keepActiveInView), and how far from the edge
 *  it is then pinned. Larger = the pill roams less before the panel follows.
 *  Two heading rows (~52px) keeps the pill near the edge without overflowing. */
const ACTIVE_EDGE_MARGIN = 52;

/** How long the book must have been still before the panel centers the active
 *  row. Measured from the last book scroll event (noteUserScroll), so momentum
 *  glides keep resetting it and the centering fires right after the wheel
 *  gesture truly rests — not after the whole gesture-defer window (700ms). */
const CENTER_SCROLL_SETTLE_MS = 50;

/**
 * Scroll spy: maps the book's scroll position to the active ToC entry,
 *  maintains per-entry heading positions, and drives the highlight + panel
 *  centering. Runs off the shared manager frame; never reads layout inside
 *  scroll events. With the virtualized panel the highlight and centering go
 *  through the virtual offsets + the window's row maps instead of direct row
 *  DOM lookups. */
export class TocSpy {
	/** Last bestIndex reported by pickActiveIndex; used to log only on change. */
	private _prevSpyIndex = -1;
	/** Cached pill transform string; movePill skips the write when the value
	 *  is unchanged (scrolling within one heading moves nothing). */
	private lastPillTransform = '';
	/** Last heading level applied as the pill's width class. */
	private lastPillLevel = 0;
	/** rAF id for the post-paint deferred panel center scroll (see
	 *  scheduleCenterScroll). */
	private centerDeferRaf = 0;

	constructor(private state: TocState) {}

	/** Wire the scroll listener, the frame callback, and the viewport
	 *  observers. Mirrors the original setupScrollSpy + the ResizeObserver
	 *  setup that followed the build. */
	setup(): void {
		const s = this.state;
		if (s.entries.length > 0) {
			s.scrollHandler = () => {
				// No layout read in the scroll event: events can dispatch while
				// the book layout is dirty (async section loads), and reading
				// scrollTop would force a full style recalc right here. Instead
				// request one coalesced frame; the tick reads scrollTop in the
				// rAF, before the offset writes.
				// A compensation write also fires a scroll event; the host marks
				// it as adjusting (boundScrollHandler runs before this
				// listener). The book did not move, so the highlight/centering
				// already match the position — skip the frame instead of
				// waking the shared frame for no work.
				if (s.positionSource?.isAdjustingScroll?.()) return;
				if (s.tickScheduled) return;
				s.tickScheduled = true;
				s.positionSource?.requestFrame();
			};
			s.positionSource?.addFrameCallback(this.onFrameTick);
			s.scrollContainer.addEventListener('scroll', s.scrollHandler, { passive: true });
		}

		s.viewportHeight = s.scrollContainer.clientHeight;
		s.viewportResizeObserver?.disconnect();
		s.viewportResizeObserver = new ResizeObserver(() => {
			s.viewportHeight = s.scrollContainer.clientHeight;
		});
		s.viewportResizeObserver.observe(s.scrollContainer);

		s.tocViewportHeight = s.containerEl.clientHeight;
		s.tocResizeObserver?.disconnect();
		s.tocResizeObserver = new ResizeObserver(() => {
			// The panel height drives the row-window extent; when it changes
			// (sidebar auto-open animation, splitter drag) re-render the window
			// so the virtual range covers the new viewport without waiting for
			// the user to scroll the panel.
			const height = s.containerEl.clientHeight;
			if (height === s.tocViewportHeight) return;
			s.tocViewportHeight = height;
			if (height > 0 && !s.rowHeightValid) s.onVisibilityGain?.();
			s.window?.render();
		});
		s.tocResizeObserver.observe(s.containerEl);

		// Re-render the row window with the freshly measured panel height: at
		// mount the sidebar may still be animating open (clientHeight ~0), so
		// the initial window only covered a few rows.
		s.window?.render();

		// Bootstrap: highlight first heading after build. Route through the
		// manager frame so onScrollTick's cached scrollTop read is fresh (the
		// frame refreshes lastScrollTop before the callbacks run).
		if (s.entries.length > 0) {
			s.positionSource?.requestFrame();
		}
	}

	/** Runs at the start of the shared frame, before position writes. */
	onFrameTick = (): void => {
		this.state.tickScheduled = false;
		this.onScrollTick();
	};

	/** Recompute entry positions only when something that feeds them changed:
	 *  section offsets (layout version) or measured heading offsets (dirty
	 *  flag). Plain scroll frames keep the last array — positions do not depend
	 *  on scrollTop, so recomputing them was pure O(entries) waste per frame. */
	updatePositionsIfDirty(): void {
		const s = this.state;
		const layoutVersion = s.positionSource?.getLayoutVersion() ?? -1;
		if (!s.positionsDirty && layoutVersion === s.lastLayoutVersion) return;
		s.positionsDirty = false;
		s.lastLayoutVersion = layoutVersion;
		s.positionsStableSince = performance.now();
		this.calculatePositions();
	}

	calculatePositions(): void {
		const s = this.state;
		if (!s.positionSource) return;

		const n = s.entries.length;
		if (s.headingPositions.length !== n) {
			s.headingPositions = new Array<number>(n);
		}
		// Per-entry getOffset avoids allocating a Map for every frame of scroll;
		// the array is reused to avoid GC churn. Prefer the measured within-
		// section offset (set by tagHeadings when the section is mounted) over
		// the line-based estimate.
		for (let i = 0; i < n; i++) {
			const entry = s.entries[i];
			if (!entry) continue;
			const within = s.headingOffsets.get(i);
			s.headingPositions[i] = (s.positionSource.getOffset(entry.file.path) ?? 0)
				+ (within ?? entry.line * HEIGHT_PER_LINE);
		}
	}

	/** Called once per rAF frame on scroll */
	onScrollTick(): void {
		const s = this.state;
		if (s.isJumping) return;

		this.updatePositionsIfDirty();

		const scrollTop = s.positionSource?.getScrollTop() ?? s.scrollContainer.scrollTop;
		const viewportHeight = s.viewportHeight;
		const bestIndex = pickActiveIndex(s.headingPositions, scrollTop, viewportHeight);

		// After a navigation (teleport), trust the teleported-to entry until
		// the user scrolls significantly away from the teleport target.
		// Compensate events (programmatic scroll adjustments from lazy section
		// loads) can shift scrollTop by hundreds of pixels — skip them via
		// isAdjustingScroll so they don't release the grace prematurely.
		if (s.lastNavigationTime > 0) {
			if (s.positionSource?.isAdjustingScroll?.()) return;
			const scrollDelta = Math.abs(scrollTop - s.lastNavigationScrollTop);
			const SCROLL_RELEASE_PX = viewportHeight * 0.15;
			const MAX_GRACE_MS = 1000;
			const elapsed = performance.now() - s.lastNavigationTime;
			if (scrollDelta < SCROLL_RELEASE_PX && elapsed < MAX_GRACE_MS) return;
			s.lastNavigationTime = 0;
		}

		if (bestIndex < 0) {
			window.clearTimeout(s.activePathTimer);
			s.pendingPathIndex = -1;
			if (s.activePathSet.size > 0) {
				s.activePathSet.clear();
				s.applyVisibility();
			}
			return;
		}

		s.activeEntryIndex = bestIndex;

		// ToC panel hidden — pure tracking, zero DOM touches. Every classList
		// toggle, element reparent, and tree rebuild here competes with section
		// mounting for frame budget, turning imperceptible gap corrections into
		// felt micro-stalls. The stale pendingPathIndex/activePathSet ensures a
		// full catch-up on the first spy tick after the panel becomes visible.
		if (s.tocViewportHeight <= 0) return;

		const mode = s.settings?.autoExpandMode ?? 'disabled';

		const highlightIndex = this.visibleAncestor(bestIndex, mode !== 'disabled');

		// Debug: log only when the active heading changes
		if (bestIndex !== this._prevSpyIndex) {
			const entry = s.entries[bestIndex];
			const posAge = Math.round(performance.now() - s.positionsStableSince);
			const label = entry ? `${entry.file.basename}#${entry.text}` : '?';
			DebugLog.log('SPY', '', bestIndex, label, `scroll=${Math.round(scrollTop)}`, `posAge=${posAge}`);
			this._prevSpyIndex = bestIndex;
		}

		this.updateHighlight(highlightIndex);

		// keepActiveInView (panel edge pin) runs inside updateHighlight: its
		// scrollTop write only fires when the active row crosses the edge
		// margin, not on every frame.

		// Center the active item once the scroll settles. Centering inside the
		// scroll frame both forced a layout read (li.offsetTop) and restarted a
		// smooth scroll on the panel for every active-item change; a single
		// trailing animation after the wheel rests is one write + no reads
		// (virtual offsets instead of offsetTop).
		if (s.lastCenterIndex !== highlightIndex) {
			s.lastCenterIndex = highlightIndex;
			this.scheduleCenterScroll(highlightIndex);
		}

		// Expand the active path live, in the scroll frame: the pill's offset
		// math reads the virtual list, so a section that is not yet expanded
		// has no rows to land the highlight on, and deferring the rebuild to
		// the settle beat ("the indicator only works on the last-opened level
		// until the scroll stops") read as a bug. The rebuild is now cheap
		// enough to run per crossing: rebuildVirtualData is one O(entries)
		// pass, and the row window RECYCLES existing rows in place by
		// data-index instead of re-creating the ~1000-element row DOM that the
		// old settle-batching was built to avoid. Only far-expanded sections'
		// rows outside the visible range are skipped (virtualized), so the
		// panel follows the active heading while the book is still moving.
		if (bestIndex !== s.pendingPathIndex) {
			s.pendingPathIndex = bestIndex;
			let newPath: Set<number>;
			if (mode !== 'disabled') {
				newPath = s.computeActivePath(s.activeEntryIndex);
				if (mode === 'only-expand' || mode === 'expand-collapse-level') {
					// Remember every section ever on the active path: 'only-
					// expand' keeps them expanded, 'expand-collapse-level'
					// collapses them to the rest level once left.
					for (const idx of newPath) s.visitedSet.add(idx);
				}
			} else {
				newPath = new Set<number>();
			}

			if (!s.setsEqual(s.activePathSet, newPath)) {
				s.activePathSet = newPath;
				s.applyVisibility();
				// The rebuild changed the virtual offsets; re-pin the active
				// row with the fresh geometry so the panel does not drift a
				// frame behind the expansion above it.
				this.keepActiveInView(highlightIndex);
			}
		}

		// Fade highlight indicator after idle
		if (s.highlightEl) {
			s.highlightEl.classList.remove('fading');
		}
		window.clearTimeout(s.fadeTimer);
		s.fadeTimer = window.setTimeout(() => {
			s.highlightEl?.classList.add('fading');
		}, 400);
	}

	/** The entry to highlight for `index`: itself when its row is in the
	 *  virtual list, else the nearest visible ancestor. With auto-expand on the
	 *  active path is force-expanded, so the entry itself is visible. Returns
	 *  -1 when nothing is visible. */
	visibleAncestor(index: number, skipWalk: boolean): number {
		const s = this.state;
		if (s.allRowsHidden) return -1;
		if (skipWalk) return index;
		if (this.isVisible(index)) return index;
		let targetLevel = s.entries[index]?.level ?? 0;
		for (let j = index - 1; j >= 0; j--) {
			const a = s.entries[j];
			if (!a) break;
			if (a.level < targetLevel) {
				if (this.isVisible(j)) return j;
				targetLevel = a.level;
			}
		}
		return -1;
	}

	private isVisible(index: number): boolean {
		const item = this.state.entryToItem[index];
		return item !== undefined && item >= 0;
	}

	/** Apply the highlight live, once per scroll frame, with the (virtual)
	 *  active index. Every write here is designed to be free of layout:
	 *
	 *  - The pill is a single absolutely-positioned element inside the spacer,
	 *    moved with `transform: translate3d(...)` — a compositor-only change
	 *    that invalidates NO layout and keeps the marker tracking the active
	 *    row during fast flicks instead of waiting for the scroll to settle.
	 *  - The `is-active` toggle is a style-only class swap on two anchors
	 *    (native classList, not Obsidian's addClass/removeClass, whose
	 *    bookkeeping showed up as the style-invalidating writer — "First
	 *    invalidated: enhance.js" — in every earlier profile).
	 *  - Identical frame-to-frame state writes nothing: movePill caches the
	 *    transform string and the width/level class, apply matches against
	 *    activeHeading, and keepActiveInView only writes panel scrollTop when
	 *    the row crosses its edge margin.
	 *
	 *  Because no write here dirties the panel's layout, the panel window's
	 *  ~600-700-element style recalc ("Recalculate style" in every earlier
	 *  scroll-frame profile) no longer happens per frame: it came from the old
	 *  appendChild-reparent of the pill onto the active row, from the core
	 *  addClass wrapper, and from forced offsetHeight flushes — all removed.
	 *  The frame's own layout reads are cached/virtual (no dirty-to-clean DOM
	 *  read anywhere in the tick). */
	updateHighlight(index: number): void {
		this.applyHighlight(index);
		this.keepActiveInView(index);
	}

	/** Apply the highlight synchronously (navigation clicks, visibility
	 *  rebuilds). Same live writes as updateHighlight; nothing to defer. */
	applyHighlightNow(index: number): void {
		this.applyHighlight(index);
		this.keepActiveInView(index);
	}

	private applyHighlight(index: number): void {
		const s = this.state;
		const el = index >= 0 ? s.rowAnchorByEntry.get(index) : undefined;
		if (el !== s.activeHeading) {
			s.activeHeading?.classList.remove('is-active');
			if (el) el.classList.add('is-active');
			s.activeHeading = el ?? null;
		}
		this.movePill(index);
	}

	/** Move the single highlight bar onto the active row using virtual
	 *  offsets, via `transform` ONLY — never top/left — so per-frame movement
	 *  never dirties the panel's layout. The bar is a child of the spacer
	 *  window (highlightHost), not of the row, so no reparent on row change;
	 *  it and the row window share the spacer's coordinate space, so the
	 *  row's toc offset IS the bar's y. Width and level come from static CSS
	 *  classes (set only when the heading level changes); identical frames
	 *  write nothing (cached transform string). A row outside the rendered
	 *  window (or a file row, which gets no anchor) hides the bar below the
	 *  spacer's paint clip; it returns the moment the row re-renders
	 *  (reapplyHighlight runs after every window render). */
	private movePill(index: number): void {
		const s = this.state;
		const host = s.highlightHost;
		if (!host) return;
		const el = index >= 0 ? s.rowAnchorByEntry.get(index) : undefined;
		let transform = 'translate3d(0, -99999px, 0)';
		let level = 0;
		if (el) {
			const item = s.entryToItem[index];
			const top = item !== undefined && item >= 0 ? (s.virtualOffsets[item] ?? 0) : 0;
			const entry = s.entries[index];
			level = entry?.level ?? 1;
			const indent = (level - 1) * 12;
			transform = `translate3d(${indent + 4}px, ${top + 2}px, 0)`;
		}
		if (!s.highlightEl) {
			s.highlightEl = host.createDiv({ cls: 'book-toc-highlight' });
		}
		const pill = s.highlightEl;
		if (level !== this.lastPillLevel) {
			this.lastPillLevel = level;
			for (let lv = 1; lv <= 6; lv++) {
				pill.classList.toggle(`book-toc-highlight-level-${lv}`, lv === level);
			}
		}
		if (transform !== this.lastPillTransform) {
			this.lastPillTransform = transform;
			pill.setCssProps({ transform });
		}
	}

	/** Re-apply the highlight after a window render replaced the row elements
	 *  (the previous activeHeading node may be detached). */
	reapplyHighlight(): void {
		const s = this.state;
		if (s.activeEntryIndex < 0) return;
		const mode = s.settings?.autoExpandMode ?? 'disabled';
		this.applyHighlightNow(this.visibleAncestor(s.activeEntryIndex, mode !== 'disabled'));
	}

	/** Write-only scroll to keep the active row inside the panel viewport.
	 *  Unlike scheduleCenterScroll this is an instant scrollTop write, so it
	 *  never starts an animation: a row pinned near an edge stays rendered
	 *  (edge + overscan) and the pill stays visible during a fast flick
	 *  without per-frame panel churn. Pure virtual-offset arithmetic — no
	 *  layout reads. The panel reacts when the row approaches an edge within
	 *  ACTIVE_EDGE_MARGIN and pins it that far from the edge, so the pill
	 *  never slides all the way out of the visible area. */
	private keepActiveInView(index: number): void {
		const s = this.state;
		if (index < 0 || s.tocViewportHeight <= 0) return;
		const item = s.entryToItem[index];
		if (item === undefined || item < 0) return;
		const top = s.virtualOffsets[item] ?? 0;
		const bottom = top + s.rowHeight;
		const scrollTop = s.panelScrollTop;
		const viewport = s.tocViewportHeight;
		const pad = s.tocPaddingTop;
		// Clamp so tiny panels can't oscillate between the two branches.
		const margin = Math.min(ACTIVE_EDGE_MARGIN, viewport * 0.25);
		if (top < scrollTop + margin - pad) {
			const next = Math.max(0, top + pad - margin);
			s.containerEl.scrollTop = next;
			s.panelScrollTop = next;
		} else if (bottom > scrollTop + viewport - margin - pad) {
			const total = s.virtualOffsets[s.virtualOffsets.length - 1] ?? 0;
			const max = Math.max(0, total - viewport);
			const next = Math.min(max, bottom - viewport + margin + pad);
			s.containerEl.scrollTop = next;
			s.panelScrollTop = next;
		}
	}

	/** Write-only scroll centering, run once after the scroll settles. Computes
	 *  the target from the virtual offsets (fixed row heights) and the cached
	 *  panel height — no layout read. Runs in a macrotask so the panel scroll
	 *  write happens after the frame's render, when the layout is clean. */
	private scheduleCenterScroll(index: number): void {
		const s = this.state;
		window.clearTimeout(s.centerScrollTimer);
		s.centerScrollTimer = window.setTimeout(() => {
			if (index < 0 || s.tocViewportHeight <= 0) return;
			// The book may still be gliding after the wheel gesture ended. A
			// smooth panel scroll started then would be cancelled and restarted
			// on every heading change, and its panel-scroll frames (scroll
			// events → row-window rebuilds) steal the book flick's frame
			// budget, which reads as micro-jerks in the book. Wait until the
			// book has been still for CENTER_SCROLL_SETTLE_MS — measured from
			// its last scroll event, so this is just past the moment the user
			// stopped scrolling — then center once.
			if (s.positionSource?.isGestureActive(CENTER_SCROLL_SETTLE_MS)) {
				this.scheduleCenterScroll(index);
				return;
			}
			const item = s.entryToItem[index];
			if (item === undefined || item < 0) return;
			const top = s.virtualOffsets[item] ?? 0;
			const target = Math.max(0, top - (s.tocViewportHeight - s.rowHeight) / 2);
			// Skip when the panel is effectively already centered — avoids
			// starting a smooth animation (and its panel-scroll churn) over a
			// couple of pixels.
			if (Math.abs(s.panelScrollTop - target) < 2) return;
			// The highlight is applied at the same settle beat; its class
			// toggle + pill reparent dirties the ToC tree, and a scrollTo here
			// forces that fresh dirt into a synchronous recalc over the whole
			// list (~27ms, 690 elements). Defer the write past the next paint
			// (double rAF) so the browser recalculates the highlight in its
			// normal rendering pipeline and this scroll lands on a clean
			// layout — a cheap write instead of a forced reflow.
			const doCenter = (): void => {
				if (s.lastCenterIndex !== index) return;
				s.containerEl.scrollTo({ top: target, behavior: 'smooth' });
			};
			if (this.centerDeferRaf) window.cancelAnimationFrame(this.centerDeferRaf);
			this.centerDeferRaf = window.requestAnimationFrame(() => {
				this.centerDeferRaf = window.requestAnimationFrame(doCenter);
			});
		}, CENTER_SCROLL_SETTLE_MS);
	}

	destroy(): void {
		const s = this.state;
		s.positionSource?.removeFrameCallback(this.onFrameTick);
		s.tickScheduled = false;
		this.lastPillTransform = '';
		this.lastPillLevel = 0;
		if (s.scrollHandler) {
			s.scrollContainer.removeEventListener('scroll', s.scrollHandler);
			s.scrollHandler = null;
		}
		window.clearTimeout(s.fadeTimer);
		window.clearTimeout(s.centerScrollTimer);
		window.clearTimeout(s.activePathTimer);
		if (this.centerDeferRaf) window.cancelAnimationFrame(this.centerDeferRaf);
		this.centerDeferRaf = 0;
		s.viewportResizeObserver?.disconnect();
		s.viewportResizeObserver = null;
		s.tocResizeObserver?.disconnect();
		s.tocResizeObserver = null;
		s.highlightEl = null;
		s.highlightHost = null;
		s.activeHeading = null;
	}
}
