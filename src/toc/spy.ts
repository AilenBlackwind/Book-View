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

/** How long the book must have been still before a pending visibility change
 *  is applied to the panel. Mirrors CENTER_SCROLL_SETTLE_MS: measured from the
 *  last book scroll event, so a glide keeps extending it and the one rebuild
 *  that applies the final active path fires just past the moment the wheel
 *  rests — instead of one ~30ms panel rebuild per heading crossing while the
 *  glide is still running. */
const APPLY_VISIBILITY_SETTLE_MS = 50;

/** Scroll spy: maps the book's scroll position to the active ToC entry,
 *  maintains per-entry heading positions, and drives the highlight + panel
 *  centering. Runs off the shared manager frame; never reads layout inside
 *  scroll events. With the virtualized panel the highlight and centering go
 *  through the virtual offsets + the window's row maps instead of direct row
 *  DOM lookups. */
export class TocSpy {
	/** Last bestIndex reported by pickActiveIndex; used to log only on change. */
	private _prevSpyIndex = -1;
	/** Deferred applyVisibility settle timer (see scheduleApplyVisibility). */
	private visibilityRafId = 0;
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

		// Track the active path immediately (the pill and centering keep working
		// off the virtual state), but defer the panel rebuild to the settle
		// beat: each rebuild re-creates ~1000 elements of row DOM, and doing
		// that once per heading crossing while the glide is still running
		// made the ToC the dominant scroll-frame cost with auto-expand on.
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
				this.scheduleApplyVisibility(s);
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

	/** Apply the highlight for the active row, synchronously in the scroll
	 *  frame (before this frame paints), so the pill tracks the scroll live
	 *  like Quartz's in-view toggle. The mutation is cheap here because (a) it
	 *  only reruns when the active row actually changes — scrolling within one
	 *  heading touches nothing; (b) the class toggle + pill reparent is
	 *  style-only for the `.book-toc-spacer` (contain: layout paint style), so
	 *  the recalc is scoped at paint instead of forcing a read-flush; and
	 *  (c) the frame's own layout reads (scrollTop, positions, panelScrollTop)
	 *  all happened earlier in onScrollTick against cached/virtual values, so
	 *  no dirty-to-clean DOM read follows the mutation. The only read that
	 *  could collide — the post-settle panel center scrollTo — is deferred
	 *  through a double rAF (see scheduleCenterScroll) to land after paint. */
	updateHighlight(index: number): void {
		this.applyHighlight(index);
	}

	private applyHighlight(index: number): void {
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
			// so it can never sit on a stale cached position. Created lazily
			// directly in its target <li>: eager creation left it as a
			// full-width child of containerEl for one frame before being
			// reparented — a visible flash.
			const li = s.rowByEntry.get(index);
			if (!li) return;
			if (!s.highlightEl) {
				s.highlightEl = li.createDiv({ cls: 'book-toc-highlight' });
			} else if (s.highlightEl.parentElement !== li) {
				li.appendChild(s.highlightEl);
			}
		}
	}

	/** Apply the active path's visibility on the settle beat. A visibility
	 *  change rebuilds the row window (~1000 elements of DOM); applied once per
	 *  heading crossing while the book is moving, that work sat squarely in
	 *  the scroll frame and its layout dirt poisoned every read in the frame.
	 *  Self-extending: while the book is still moving the timer re-arms, so a
	 *  glide applies exactly one rebuild with the FINAL active path, just past
	 *  the moment the wheel rests. */
	private scheduleApplyVisibility(s: TocState): void {
		// Initial application must be synchronous: deferring past paint makes
		// the ToC render collapsed/empty then snap open — a visible flash.
		// After the first applyVisibility, rowByEntry is populated and every
		// subsequent call goes through the settle deferral.
		if (!s.rowByEntry.size) {
			s.applyVisibility();
			return;
		}
		if (this.visibilityRafId) return;
		this.visibilityRafId = window.setTimeout(() => {
			this.visibilityRafId = 0;
			// The book may still be gliding after the wheel gesture ended; the
			// rebuild competes with the flick's remaining frames. Extend until
			// the book has been still for APPLY_VISIBILITY_SETTLE_MS.
			if (s.positionSource?.isGestureActive(APPLY_VISIBILITY_SETTLE_MS)) {
				this.scheduleApplyVisibility(s);
				return;
			}
			s.applyVisibility();
			// Flush the layout dirtied by the row rebuild HERE, at the settle
			// beat where the book is idle and no scroll frame competes: the
			// next input's reads (wheel notch, native scroll event) then find a
			// clean layout instead of force-reflowing a fresh panel rebuild.
			void s.containerEl.offsetHeight;
		}, APPLY_VISIBILITY_SETTLE_MS);
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
		if (this.visibilityRafId) {
			window.clearTimeout(this.visibilityRafId);
			this.visibilityRafId = 0;
		}
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
		s.activeHeading = null;
	}
}
