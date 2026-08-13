import { TFile } from 'obsidian';
import { TocState, PendingTagHeading, PendingTagSection } from './state';
import { DebugLog } from '../utils/debug';

// Per-frame budget for heading-offset measurement. getBoundingClientRect on a
// section inside the huge transformed book container forces a layout flush per
// read; draining a cold-start pile-up in one frame was a 50ms+ stall. Trickle
// at most these many rect reads per frame, and re-request a frame to continue.
const TAG_RECT_BUDGET = 8;
const TAG_MS_BUDGET = 6;

/** Heading-offset measurement (tagHeadings + the deferred rect reads in the
 *  shared manager frame) and offset cache invalidation. */
export class TocMeasurer {
	constructor(private state: TocState) {}

	/** Drop measured within-section offsets for one path. Called when a file's
	 *  content is edited (markDirty re-renders the section without a TOC
	 *  rebuild), so the next render re-measures instead of trusting a stale
	 *  offset. */
	invalidatePath(path: string): void {
		const s = this.state;
		let removed = 0;
		for (let k = 0; k < s.entries.length; k++) {
			if (s.entries[k]?.file.path === path && s.headingOffsets.delete(k)) removed++;
		}
		// Debug: is the headingOffsets cache being silently evicted by
		// markDirty (file modify events) while the user is elsewhere?
		if (removed > 0) {
			s.positionsDirty = true;
			DebugLog.log('TOC invalidate', path, removed);
		}
	}

	/** Tag a freshly mounted section's headings with their ToC entry index and
	 *  queue the rect reads for the next frame. Runs from the manager's
	 *  onSectionRendered (inside the IO macrotask right after the section
	 *  mounted). */
	tagHeadings(path: string, container: HTMLElement): void {
		const s = this.state;
		const file = s.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;
		const cache = s.app.metadataCache.getFileCache(file);
		if (!cache?.headings) return;

		const sectionEl = container.parentElement;
		if (!(sectionEl instanceof HTMLElement)) return;

		const headingEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');

		// Cheap part, kept synchronous: tag each heading with its ToC entry so
		// context menus can map a heading back to an entry. No layout reads.
		const toMeasure: PendingTagHeading[] = [];
		for (let i = 0; i < cache.headings.length; i++) {
			const heading = cache.headings[i];
			if (!heading) continue;
			const el = headingEls[i];
			if (!(el instanceof HTMLElement)) continue;

			const tocIndex = s.entryByPathLine.get(`${path}#${heading.position.start.line}`);
			if (tocIndex === undefined) continue;

			el.setAttribute('data-entry-index', String(tocIndex));

			// Churn re-mounts of the same file re-render an identical layout, so
			// the measured within-section offsets stay valid across renders. Only
			// measure headings without a cached offset. Content edits invalidate
			// the cache via invalidatePath, so stale offsets are re-measured
			// there.
			if (s.headingOffsets.has(tocIndex)) continue;
			toMeasure.push({ el, tocIndex });
		}
		if (toMeasure.length === 0) return;

		// Defer the rect reads to the next frame: tagHeadings runs inside the
		// IO macrotask right after the section's DOM mounted, and reading
		// getBoundingClientRect there forces a fresh layout flush of that
		// subtree on every section load. Batching all pending measurements into
		// one frame pass shares a single layout flush (with the spy's scrollTop
		// read) instead of one flush per section.
		s.pendingTagHeadings.push({ sectionEl, toMeasure });
		if (!s.tagFrameRequested) {
			s.tagFrameRequested = true;
			s.absoluteManager?.requestFrame();
		}
	}

	/** Register the frame callback that drains deferred heading measurements.
	 *  Mirrors the original setupScrollSpy guard: no entries, no wiring. */
	setup(): void {
		const s = this.state;
		if (s.tocItems.length === 0) return;
		s.absoluteManager?.addFrameCallback(this.onTagFrame);
	}

	/** Frame callback (registered in setup, runs after processUpdates):
	 *  drains the deferred heading measurements in one coalesced pass. A cold
	 *  start mounts many sections back to back, so a whole window's worth of
	 *  heading rect reads can pile up; draining them all in a single frame was
	 *  a 50ms+ stall (tag=54.4ms in one cold-start debug window). Each rect read
	 *  on a section inside the huge transformed container forces a layout
	 *  flush, so cap the per-frame budget and trickle the rest — the offsets
	 *  are cached per tocIndex, so late measurements are still correct, and
	 *  the line-based fallback covers the highlight until they land. */
	onTagFrame = (): void => {
		const s = this.state;
		s.tagFrameRequested = false;
		if (s.pendingTagHeadings.length === 0) return;
		// Defer the rect reads while the user is actively scrolling. Each
		// getBoundingClientRect on a section inside the huge transformed
		// container forces a layout flush; inside a gesture that lands between
		// scroll frames, exactly when the main thread is already overloaded.
		// The line-based fallback keeps the active-heading highlight correct,
		// and the settle resumes the drain (the re-requested frame runs once
		// scroll events stop).
		if (s.absoluteManager?.isGestureActive()) {
			s.tagFrameRequested = true;
			s.absoluteManager.requestFrame();
			return;
		}
		const t0 = performance.now();
		const timeLimit = t0 + TAG_MS_BUDGET;
		let rects = 0;
		const stillPending: PendingTagSection[] = [];
		for (const p of s.pendingTagHeadings) {
			const { sectionEl, toMeasure } = p;
			// Section unloaded before the frame arrived — skip; the line-based
			// fallback covers it until a future render re-queues the measure.
			if (!sectionEl.isConnected) continue;
			let sectionRect: DOMRect | null = null;
			const remaining: PendingTagHeading[] = [];
			for (const item of toMeasure) {
				if (rects >= TAG_RECT_BUDGET || performance.now() >= timeLimit) {
					remaining.push(item);
					continue;
				}
				if (!item.el.isConnected) continue;
				// Headings hidden by fold-mode collapse have display:none —
				// their rect is zeroed, so skip them and keep the line-based
				// fallback.
				if (item.el.offsetParent === null) continue;
				if (!sectionRect) sectionRect = sectionEl.getBoundingClientRect();
				const headingRect = item.el.getBoundingClientRect();
				s.headingOffsets.set(item.tocIndex, headingRect.top - sectionRect.top);
				s.positionsDirty = true;
				rects++;
				if (s.absoluteManager) s.absoluteManager.dbgTagRects++;
			}
			if (remaining.length > 0) stillPending.push({ sectionEl, toMeasure: remaining });
		}
		s.pendingTagHeadings = stillPending;
		if (s.absoluteManager) s.absoluteManager.dbgTagMs += performance.now() - t0;
		if (stillPending.length > 0) {
			s.tagFrameRequested = true;
			s.absoluteManager?.requestFrame();
		}
	};

	destroy(): void {
		const s = this.state;
		s.absoluteManager?.removeFrameCallback(this.onTagFrame);
		s.pendingTagHeadings = [];
		s.tagFrameRequested = false;
	}
}
