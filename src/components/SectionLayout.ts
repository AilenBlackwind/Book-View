import type { FoldMode } from '../utils/fold';
import type { SectionData } from './SectionPool';
import { OVERSCAN_TOP, PRERENDER_WINDOW } from './SectionPool';
import { FALLBACK_FOLD_HEADING_HEIGHT } from './FoldController';
import type { ThemeSpacings } from '../utils/theme';
import { DEFAULT_THEME_SPACINGS } from '../utils/theme';

const SCROLL_THRESHOLD = 1;

export interface Anchor {
	idx: number;
	anchorOffset: number;
}

export interface SectionLayoutHost {
	readonly sections: Map<string, SectionData>;
	readonly fileOrder: string[];
	readonly scrollContainer: HTMLElement;
	readonly spacerEl: HTMLElement;
	readonly loadMargin: number;
	isDestroyed(): boolean;
	getFoldMode(path: string): FoldMode;
	foldNextVisibleIndex(start: number): number;
	foldScheduleHeightMeasure(path: string): void;
	foldApplyPendingRetags(): void;
	enqueueRender(path: string): void;
	unloadSection(path: string): void;
	dbg(msg: string, path?: string, a?: number | string, b?: number | string, c?: number | string): void;
}

/**
 * Owns the geometry of the book: the absolute offset cascade (recalcOffsets),
 * the fold-aware anchor lookup, and scroll restoration after the layout
 * shifts. It is purely reactive — it never schedules frames, reads or writes
 *  scrollTop (except the compensation write it owns) or mutates the
 *  section lifecycle; the manager drives it from the update loop.
 */
export class SectionLayout {
	private spacings: ThemeSpacings = { ...DEFAULT_THEME_SPACINGS };
	private pendingAnchor: Anchor | null = null;
	private isAdjustingScroll = false;

	constructor(private host: SectionLayoutHost) {}

	get themeSpacings(): ThemeSpacings {
		return this.spacings;
	}

	/** Snapshot the current scroll anchor so a layout shift can be undone. */
	captureAnchor(): void {
		this.pendingAnchor = this.findAnchorAt(this.host.scrollContainer.scrollTop);
	}

	/** Returns the captured anchor (or computes one) and clears it for the frame. */
	takeAnchor(scrollTop: number): Anchor | null {
		const anchor = this.pendingAnchor ?? this.findAnchorAt(scrollTop);
		this.pendingAnchor = null;
		return anchor;
	}

	/** Reports whether the last scroll was a programmatic compensation write. */
	consumeAdjustingScroll(): boolean {
		if (this.isAdjustingScroll) {
			this.isAdjustingScroll = false;
			return true;
		}
		return false;
	}

	applyThemeSpacings(spacings: ThemeSpacings): void {
		this.spacings = spacings;
	}

	getOffset(path: string): number {
		return this.host.sections.get(path)?.offset ?? 0;
	}

	getAllOffsets(): Map<string, number> {
		const result = new Map<string, number>();
		for (const [path, data] of this.host.sections) {
			result.set(path, data.offset);
		}
		return result;
	}

	/** Rewrites placeholder transforms inside the viewport window from the
	 *  always-current data.offset. recalcOffsets keeps this fresh at recalc
	 *  time, but a section whose offset changed while it sat outside the window
	 *  keeps a stale DOM transform afterwards — and plain scrolling never
	 *  triggers a recalc, so a stale placeholder can sit where the IO never
	 *  fires, leaving a blank gap. Called every frame; cheap because it binary
	 *  searches to the window and only writes changed transforms. Loaded
	 *  sections are skipped (recalcOffsets writes them unconditionally). */
	refreshWindowTransforms(scrollTop: number, viewport: number): void {
		const winTop = scrollTop - OVERSCAN_TOP - this.host.loadMargin;
		const winBottom = scrollTop + viewport + this.host.loadMargin + PRERENDER_WINDOW;
		const order = this.host.fileOrder;
		// Offsets are non-decreasing, so binary search the first section that
		// can touch the window, then scan forward until past its bottom edge.
		let lo = 0;
		let hi = order.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const data = this.host.sections.get(order[mid] ?? '');
			const off = data ? data.offset : Number.MAX_SAFE_INTEGER;
			if (off < winTop) lo = mid + 1;
			else hi = mid;
		}
		for (let i = Math.max(0, lo - 1); i < order.length; i++) {
			const data = this.host.sections.get(order[i] ?? '');
			if (!data) break;
			if (data.offset > winBottom) break;
			if (data.component) continue;
			if (data.offset + data.height < winTop) continue;
			const transform = `translateY(${data.offset}px)`;
			if (data.el.style.transform !== transform) {
				data.el.style.transform = transform;
			}
		}
	}

	destroy(): void {
		this.pendingAnchor = null;
	}

	recalcOffsets(): void {
		let offset = 0;
		const scrollTop = this.host.scrollContainer.scrollTop;
		const viewport = this.host.scrollContainer.clientHeight;
		// Only rewrite transforms inside a window around the viewport: writing
		// ~2000 transforms forces a 100-200ms synchronous style recalc, which
		// is what made every height correction a multi-hundred-ms long task.
		// The window (IO range = OVERSCAN_TOP above, loadMargin below, plus the
		// prerender lookahead) covers everything that can mount next; sections
		// farther out keep a stale transform that applyTransform() fixes on
		// (re)mount, and data.offset is always kept current in JS regardless.
		const winTop = scrollTop - OVERSCAN_TOP - this.host.loadMargin;
		const winBottom = scrollTop + viewport + this.host.loadMargin + PRERENDER_WINDOW;

		for (let i = 0; i < this.host.fileOrder.length; i++) {
			const path = this.host.fileOrder[i] ?? '';
			const data = this.host.sections.get(path);
			if (!data) break;

			const foldMode = this.host.getFoldMode(path);

			data.offset = offset;
			// Position via transform instead of style.top: a top write on a
			// positioned element invalidates its style and layout, and after a
			// height correction the whole cascade of following sections is
			// re-styled and re-laid-out in one frame. translateY only moves the
			// composited layer, so unchanged sections never dirty the renderer.
			// Loaded sections are always written (they hold live DOM); unloaded
			// placeholders only inside the window.
			if (data.component || (offset <= winBottom && offset + data.height >= winTop)) {
				const transform = `translateY(${offset}px)`;
				if (data.el.style.transform !== transform) {
					data.el.style.transform = transform;
				}
			}

			if (foldMode === 'heading') {
				data.el.classList.add('book-section-heading-folded');
				data.el.classList.remove('book-section-folded');
				// A freshly folded heading has no measured stub height yet; use a
				// fallback so the section never collapses to 'full' (which would
				// hide the heading and its chevron with no way to expand back).
				// The real height is measured shortly after and corrects the stub.
				if (data.foldHeadingHeight <= 0) {
					this.host.foldScheduleHeightMeasure(path);
				}
				const stubHeight = data.foldHeadingHeight > 0
					? data.foldHeadingHeight
					: FALLBACK_FOLD_HEADING_HEIGHT;
				// Render unmounted folded sections so their heading stub and
				// chevron are actually visible.
				if (!data.component) {
					this.host.enqueueRender(path);
				}
				offset += stubHeight;

				const nextIdx = this.host.foldNextVisibleIndex(i);
				if (nextIdx >= 0) {
					offset += this.getGapBetweenNotes(path, this.host.fileOrder[nextIdx]!);
				}
			} else if (foldMode === 'full') {
				data.el.classList.remove('book-section-heading-folded');
				data.el.classList.add('book-section-folded');
				if (data.component) this.host.unloadSection(path);
			} else {
				const transitioned = data.wasHidden;
				data.el.classList.remove('book-section-folded', 'book-section-heading-folded');
				// Chevron rotation/tooltips are owned by updateFoldChevrons
				// (run on mount and fold toggles); clearing them here would
				// un-rotate low-level fold chevrons on every unrelated recalc.
				offset += data.height;

				// Only re-request rendering for sections that just became visible.
				// Sections scrolled into view are handled by the IntersectionObserver,
				// and probing every unloaded section here forces layouts plus
				// synchronous markdown renders on every layout pass during scroll.
				if (transitioned && !data.component) {
					const rect = data.el.getBoundingClientRect();
					const crect = this.host.scrollContainer.getBoundingClientRect();
					if (rect.bottom > crect.top - OVERSCAN_TOP && rect.top < crect.bottom + this.host.loadMargin) {
						this.host.enqueueRender(path);
					}
				}

				const nextIdx = this.host.foldNextVisibleIndex(i);
				if (nextIdx >= 0) {
					offset += this.getGapBetweenNotes(path, this.host.fileOrder[nextIdx]!);
				}
			}

			data.wasHidden = foldMode !== 'none';
		}

		// Re-apply DOM-level fold hiding for sections whose fold state changed.
		// Whole-section 'full'/'heading' modes need no DOM work, but low-level
		// folds hide content inside an otherwise 'none' section.
		this.host.foldApplyPendingRetags();

		const spacerHeight = `${offset}px`;
		if (this.host.spacerEl.style.height !== spacerHeight) {
			this.host.spacerEl.style.height = spacerHeight;
		}
	}

	private getGapBetweenNotes(prevPath: string, nextPath: string): number {
		const prev = this.host.sections.get(prevPath);
		const next = this.host.sections.get(nextPath);
		if (!prev || !next) return this.spacings.textGap;

		// A section folded to its own heading only shows its first heading,
		// so treat it as ending with a header when computing the gap below.
		const prevType = this.host.getFoldMode(prevPath) === 'heading' ? prev.firstType : prev.lastType;
		const isPrevHeader = prevType !== 'text';
		const isCurrHeader = next.firstType !== 'text';

		const s = this.spacings;

		if (isPrevHeader && isCurrHeader) {
			return Math.max(0, s.headerToHeaderGap);
		} else if (next.firstType === 'h1') {
			return s.h1TopGap;
		} else if (isCurrHeader) {
			return s.h2TopGap;
		}

		return s.textGap;
	}

	findAnchorAt(scrollTop: number): Anchor | null {
		let lastIdx = -1;
		for (let i = 0; i < this.host.fileOrder.length; i++) {
			const path = this.host.fileOrder[i] ?? '';
			const data = this.host.sections.get(path);
			if (!data) continue;
			const foldMode = this.host.getFoldMode(path);
			// Fully hidden sections occupy no space, but heading stubs do:
			// they keep the folded heading on screen and must stay anchorable,
			// otherwise folding/unfolding a heading whose section is below it
			// anchors to the next visible section and the view flies away.
			if (foldMode === 'full') continue;
			lastIdx = i;
			const h = foldMode === 'heading'
				? (data.foldHeadingHeight > 0 ? data.foldHeadingHeight : FALLBACK_FOLD_HEADING_HEIGHT)
				: data.height;
			if (data.offset + h > scrollTop) {
				return { idx: i, anchorOffset: scrollTop - data.offset };
			}
		}
		if (lastIdx >= 0) {
			const path = this.host.fileOrder[lastIdx] ?? '';
			const data = this.host.sections.get(path);
			if (data) {
				return { idx: lastIdx, anchorOffset: scrollTop - data.offset };
			}
		}
		return null;
	}

	restoreScrollAt(anchor: Anchor | null, currentScrollTop: number): void {
		if (!anchor) return;
		const data = this.host.sections.get(this.host.fileOrder[anchor.idx] ?? '');
		if (!data) return;
		// Clamp the anchor offset to what is actually visible after the fold:
		// a fully hidden section collapses to its fold point, a heading stub to
		// its stub height. Without this, restoring into a now-hidden section
		// overshoots past the end of the spacer.
		const foldMode = this.host.getFoldMode(this.host.fileOrder[anchor.idx] ?? '');
		const maxOffset = foldMode === 'full'
			? 0
			: foldMode === 'heading'
				? (data.foldHeadingHeight > 0 ? data.foldHeadingHeight : FALLBACK_FOLD_HEADING_HEIGHT)
				: data.height;
		const off = Math.min(anchor.anchorOffset, Math.max(0, maxOffset));
		const target = data.offset + off;
		const delta = Math.abs(target - currentScrollTop);
		if (delta > SCROLL_THRESHOLD) {
			this.isAdjustingScroll = true;
			this.host.dbg('compensate', '', Math.round(currentScrollTop), '->', Math.round(target));
			// Write scrollTop synchronously, in the same task that just rewrote
			// the section transforms: the browser batches the dirty styles and
			// the scroll write into ONE layout pass and ONE paint, so the view
			// settles directly at the corrected position. Deferring the write to
			// a macrotask painted the intermediate pre-compensation position
			// first, which flickered the whole viewport up/down for a frame
			// right after the scroll stopped. The synchronous reflow is paid
			// once per settle update — acceptable now that updates are deferred
			// while the user is actively scrolling.
			this.host.scrollContainer.scrollTop = target;
		}
	}
}
