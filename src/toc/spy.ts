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

/** Scroll spy: maps the book's scroll position to the active ToC entry,
 *  maintains per-entry heading positions, and drives the highlight + panel
 *  centering. Runs off the shared manager frame; never reads layout inside
 *  scroll events. With the virtualized panel the highlight and centering go
 *  through the virtual offsets + the window's row maps instead of direct row
 *  DOM lookups. */
export class TocSpy {
	/** Last bestIndex reported by pickActiveIndex; used to log only on change. */
	private _prevSpyIndex = -1;

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
		// While a gesture is active the section offsets are still shifting:
		// sections mount into the viewport and report measured heights, and
		// each height correction bumps the layout version (the compensating
		// scrollTop write is itself deferred until the gesture ends). If we
		// recomputed from those live offsets every frame, headings near the
		// trigger line crossed it back and forth as estimates overshot and
		// undershot, flipping the pill between two adjacent entries. Freeze the
		// last settled positions for the gesture: pickActiveIndex then tracks
		// the scroll alone (positions stay monotonic), and the frame after the
		// gesture ends recomputes once from the final offsets. The heading
		// measurements are deferred the same way (TocMeasurer.onTagFrame).
		if (s.positionSource?.isGestureActive()) return;
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
		this.keepActiveInView(highlightIndex);

		// Center the active item once the scroll settles. Centering inside the
		// scroll frame both forced a layout read (li.offsetTop) and restarted a
		// smooth scroll on the panel for every active-item change; a single
		// trailing animation after the wheel rests is one write + no reads
		// (virtual offsets instead of offsetTop).
		if (s.lastCenterIndex !== highlightIndex) {
			s.lastCenterIndex = highlightIndex;
			this.scheduleCenterScroll(highlightIndex);
		}

		// Debounce expand/collapse: wait for scroll to settle (30ms).
		// Also suppress when:
		//  1. Heading positions were recently recalculated (300ms window) —
		//     sections lazy-mounting shift estimates.
		//  2. The active entry's heading offset hasn't been measured yet
		//     (headingOffsets map) — its position is a line-based estimate
		//     which can be wildly off after lazy section mounts.
		// Expanding/collapsing on a transient wrong heading causes visible
		// flicker (the user sees the indicator jump to a wrong section).
		const POSITIONS_SETTLE_MS = 300;
		const positionsStable = (performance.now() - s.positionsStableSince) > POSITIONS_SETTLE_MS;
		const offsetMeasured = s.headingOffsets.has(bestIndex);
		if (bestIndex !== s.pendingPathIndex && positionsStable && offsetMeasured) {
			s.pendingPathIndex = bestIndex;
			window.clearTimeout(s.activePathTimer);
			s.activePathTimer = window.setTimeout(() => {
				s.pendingPathIndex = -1;
				const newPath = mode !== 'disabled'
					? s.computeActivePath(s.activeEntryIndex)
					: new Set<number>();

				if (!s.setsEqual(s.activePathSet, newPath)) {
					s.activePathSet = newPath;
					s.applyVisibility();
				}
			}, 30);
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

	updateHighlight(index: number): void {
		const s = this.state;
		if (index < 0) {
			s.activeHeading?.removeClass('is-active');
			s.activeHeading = null;
			s.highlightEl?.remove();
			return;
		}
		const el = s.rowAnchorByEntry.get(index);
		if (!el) return;

		// Only touch the DOM when the active item actually changes; during a
		// scroll within one heading the active item is stable.
		if (el !== s.activeHeading) {
			s.activeHeading?.removeClass('is-active');
			el.addClass('is-active');
			s.activeHeading = el;

			// Host the highlight bar inside the active row: it then follows the
			// item automatically through collapse/expand and window re-renders,
			// so it can never sit on a stale cached position.
			if (s.highlightEl) {
				const li = s.rowByEntry.get(index);
				if (li && s.highlightEl.parentElement !== li) {
					li.appendChild(s.highlightEl);
				}
			}
		}
	}

	/** Re-apply the highlight after a window render replaced the row elements
	 *  (the previous activeHeading node may be detached). */
	reapplyHighlight(): void {
		const s = this.state;
		if (s.activeEntryIndex < 0) return;
		const mode = s.settings?.autoExpandMode ?? 'disabled';
		this.updateHighlight(this.visibleAncestor(s.activeEntryIndex, mode !== 'disabled'));
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
		const scrollTop = s.containerEl.scrollTop;
		const viewport = s.tocViewportHeight;
		const pad = s.tocPaddingTop;
		// Clamp so tiny panels can't oscillate between the two branches.
		const margin = Math.min(ACTIVE_EDGE_MARGIN, viewport * 0.25);
		if (top < scrollTop + margin - pad) {
			s.containerEl.scrollTop = Math.max(0, top + pad - margin);
		} else if (bottom > scrollTop + viewport - margin - pad) {
			const total = s.virtualOffsets[s.virtualOffsets.length - 1] ?? 0;
			const max = Math.max(0, total - viewport);
			s.containerEl.scrollTop = Math.min(max, bottom - viewport + margin + pad);
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
			s.containerEl.scrollTo({ top: target, behavior: 'smooth' });
		}, CENTER_SCROLL_SETTLE_MS);
	}

	destroy(): void {
		const s = this.state;
		s.positionSource?.removeFrameCallback(this.onFrameTick);
		s.tickScheduled = false;
		if (s.scrollHandler) {
			s.scrollContainer.removeEventListener('scroll', s.scrollHandler);
			s.scrollHandler = null;
		}
		window.clearTimeout(s.fadeTimer);
		window.clearTimeout(s.centerScrollTimer);
		s.viewportResizeObserver?.disconnect();
		s.viewportResizeObserver = null;
		s.tocResizeObserver?.disconnect();
		s.tocResizeObserver = null;
		s.highlightEl = null;
		s.activeHeading = null;
	}
}
