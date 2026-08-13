import { TocState } from './state';
import { HEIGHT_PER_LINE } from '../components/AbsoluteSectionManager';
import { pickActiveIndex } from '../utils/toc';

/** Scroll spy: maps the book's scroll position to the active ToC entry,
 *  maintains per-entry heading positions, and drives the highlight + panel
 *  centering. Runs off the shared manager frame; never reads layout inside
 *  scroll events. */
export class TocSpy {
	constructor(private state: TocState) {}

	/** Wire the scroll listener, the frame callback, and the viewport
	 *  observers. Mirrors the original setupScrollSpy + the ResizeObserver
	 *  setup that followed the build. */
	setup(): void {
		const s = this.state;
		if (s.tocItems.length > 0) {
			s.scrollHandler = () => {
				// No layout read in the scroll event: events can dispatch while
				// the book layout is dirty (async section loads), and reading
				// scrollTop would force a full style recalc right here. Instead
				// request one coalesced frame; the tick reads scrollTop in the
				// rAF, before the offset writes.
				if (s.tickScheduled) return;
				s.tickScheduled = true;
				s.absoluteManager?.requestFrame();
			};
			s.absoluteManager?.addFrameCallback(this.onFrameTick);
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
			s.tocViewportHeight = s.containerEl.clientHeight;
		});
		s.tocResizeObserver.observe(s.containerEl);

		// Bootstrap: highlight first heading after build. Route through the
		// manager frame so onScrollTick's cached scrollTop read is fresh (the
		// frame refreshes lastScrollTop before the callbacks run).
		if (s.entries.length > 0) {
			s.absoluteManager?.requestFrame();
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
		const layoutVersion = s.absoluteManager?.getLayoutVersion() ?? -1;
		if (!s.positionsDirty && layoutVersion === s.lastLayoutVersion) return;
		s.positionsDirty = false;
		s.lastLayoutVersion = layoutVersion;
		this.calculatePositions();
	}

	calculatePositions(): void {
		const s = this.state;
		if (!s.absoluteManager) return;

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
			s.headingPositions[i] = (s.absoluteManager.getOffset(entry.file.path) ?? 0)
				+ (within ?? entry.line * HEIGHT_PER_LINE);
		}
	}

	/** Called once per rAF frame on scroll */
	onScrollTick(): void {
		const s = this.state;
		if (s.isJumping) return;

		this.updatePositionsIfDirty();

		// Use the manager's per-frame viewport snapshot instead of reading
		// scrollTop here: the manager already read it in runFrame (next to its
		// own writes), and a second read in the same frame forces a second
		// layout flush — including on frames where processUpdates just dirtied
		// the layout. The snapshot is from this same frame, so it is exact.
		const scrollTop = s.absoluteManager?.getScrollTop() ?? s.scrollContainer.scrollTop;

		// find active heading by position
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

		// Update highlight immediately (tracks scroll in real-time)
		let highlightIndex = bestIndex;
		if (mode === 'disabled') {
			const li = s.headingLis[bestIndex];
			if (li?.hasClass('book-toc-collapsed-hidden')) {
				let targetLevel = s.entries[bestIndex]?.level ?? 0;
				for (let j = bestIndex - 1; j >= 0; j--) {
					const a = s.entries[j];
					if (!a) break;
					if (a.level < targetLevel) {
						const ancLi = s.headingLis[j];
						if (ancLi && !ancLi.hasClass('book-toc-collapsed-hidden')) {
							highlightIndex = j;
							break;
						}
						targetLevel = a.level;
					}
				}
			}
		}

		this.updateHighlight(highlightIndex);

		// Center the active item once the scroll settles. Centering inside the
		// scroll frame both forced a layout read (li.offsetTop) and restarted a
		// smooth scroll on the panel for every active-item change; a single
		// trailing animation after the wheel rests is one read + one animation.
		if (s.lastCenterIndex !== bestIndex) {
			s.lastCenterIndex = bestIndex;
			this.scheduleCenterScroll(bestIndex);
		}

		// Debounce expand/collapse: wait for scroll to settle (30ms)
		if (bestIndex !== s.pendingPathIndex) {
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

	updateHighlight(index: number): void {
		const s = this.state;
		const el = s.tocItems[index];
		if (!el) return;

		// Only touch the DOM when the active item actually changes; during a
		// scroll within one heading the active item is stable.
		if (el !== s.activeHeading) {
			s.activeHeading?.removeClass('is-active');
			el.addClass('is-active');
			s.activeHeading = el;

			// Host the highlight bar inside the active row: it then follows the
			// item automatically through collapse/expand animations and TOC
			// reflows, so it can never sit on a stale cached position.
			if (s.highlightEl) {
				const li = s.headingLis[index];
				if (li && s.highlightEl.parentElement !== li) {
					li.appendChild(s.highlightEl);
				}
			}
		}
	}

	/** Write-only scroll centering, run once after the scroll settles. Computes
	 *  the target from the active row's offset (the rows' offsetParent is the
	 *  positioned .book-toc-relative container) and the cached panel height.
	 *  Runs in a macrotask so the layout read/write happens after the frame's
	 *  render, when the layout is clean. */
	private scheduleCenterScroll(index: number): void {
		const s = this.state;
		window.clearTimeout(s.centerScrollTimer);
		s.centerScrollTimer = window.setTimeout(() => {
			const li = s.headingLis[index];
			if (!li || s.tocViewportHeight <= 0) return;
			const target = Math.max(0, li.offsetTop - (s.tocViewportHeight - li.offsetHeight) / 2);
			s.containerEl.scrollTo({ top: target, behavior: 'smooth' });
		}, 150);
	}

	destroy(): void {
		const s = this.state;
		s.absoluteManager?.removeFrameCallback(this.onFrameTick);
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
