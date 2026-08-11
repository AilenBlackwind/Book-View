import { describe, it, expect } from 'vitest';
import { isStaleRender, isStaleForDrain, isSectionInWindow, OVERSCAN_TOP } from '../src/components/SectionPool';

// Mirrors the manager's default loadMargin (AbsoluteSectionManager ctor).
const LOAD_MARGIN = 800;
const MARGIN = OVERSCAN_TOP + LOAD_MARGIN; // 3300
const VIEWPORT = 800;

describe('isStaleRender', () => {
	it('keeps a section inside the load window', () => {
		const scrollTop = 45000;
		const vpBottom = scrollTop + VIEWPORT;
		// Section entering the top overscan of the current window.
		expect(isStaleRender(44500, 1500, scrollTop, vpBottom, MARGIN)).toBe(false);
		// Section just at the top edge of the window.
		expect(isStaleRender(scrollTop - OVERSCAN_TOP, 100, scrollTop, vpBottom, MARGIN)).toBe(false);
		// Section in the viewport itself.
		expect(isStaleRender(scrollTop, 100, scrollTop, vpBottom, MARGIN)).toBe(false);
		// Section below the viewport, inside the prerender lookahead.
		expect(isStaleRender(scrollTop + VIEWPORT + 500, 100, scrollTop, vpBottom, MARGIN)).toBe(false);
	});

	it('drops a section far above the viewport (down-scroll churn)', () => {
		const scrollTop = 100000;
		const vpBottom = scrollTop + VIEWPORT;
		expect(isStaleRender(50000, 1500, scrollTop, vpBottom, MARGIN)).toBe(true);
	});

	it('drops a section far below the viewport', () => {
		const scrollTop = 0;
		const vpBottom = scrollTop + VIEWPORT;
		expect(isStaleRender(200000, 1500, scrollTop, vpBottom, MARGIN)).toBe(true);
	});

	it('regression: a top-overscan section dropped against the stale deeper snapshot is kept against the current one', () => {
		// User scrolled up from 50000 to 45000. The frame snapshot (old code
		// path) still reads the deep position when the IO batch that enqueued
		// the section runs, so the section's end falls above the stale drop
		// window and it gets dropped as stale — while it is genuinely inside
		// the current window, and being already intersecting the IO never
		// re-enqueues it (blank gap until the user scrolls again).
		const current = 45000;
		const stale = 50000;
		const vpBottom = current + VIEWPORT;
		// Section at offset 44500 is inside [current-2500, current+vp+800].
		expect(current - OVERSCAN_TOP).toBeLessThanOrEqual(44500);
		expect(44500).toBeLessThanOrEqual(current + VIEWPORT + 800);
		expect(isStaleRender(44500, 1500, current, vpBottom, MARGIN)).toBe(false);
		expect(isStaleRender(44500, 1500, stale, vpBottom, MARGIN)).toBe(true);
	});
});

describe('isStaleForDrain', () => {
	it('keeps a section that is in window under the current live position even when the IO-dispatch position drifted far past it', () => {
		// User scrolled up fast; a very tall section (offset 30000, 8000 tall)
		// entered the window mid-gesture, but by the time the queue drained the
		// last IO dispatch had already landed far above it (primary=25900).
		// The user stopped over the section (live=31000): the primary alone
		// would drop it (blanking a huge region), the live position keeps it.
		const primary = 25800;
		const live = 31000;
		const pb = primary + VIEWPORT;
		const lb = live + VIEWPORT;
		// Out of band under the primary…
		expect(isStaleRender(30000, 8000, primary, pb, MARGIN)).toBe(true);
		// …but the live position is inside the section's region.
		expect(isStaleRender(30000, 8000, live, lb, MARGIN)).toBe(false);
		expect(isStaleForDrain(30000, 8000, primary, pb, live, lb, MARGIN)).toBe(false);
	});

	it('drops a section that is far from the current position under both windows (down-scroll churn guard)', () => {
		// A section far below the viewport, judged from a settled (current)
		// position: no ambiguity, drop it.
		const primary = 100000;
		const live = 100000;
		const pb = primary + VIEWPORT;
		const lb = live + VIEWPORT;
		expect(isStaleForDrain(50000, 1500, primary, pb, live, lb, MARGIN)).toBe(true);
	});

	it('keeps a section in the current window under both positions', () => {
		const primary = 45000;
		const live = 45000;
		const pb = primary + VIEWPORT;
		const lb = live + VIEWPORT;
		expect(isStaleForDrain(44500, 1500, primary, pb, live, lb, MARGIN)).toBe(false);
	});
});

describe('isSectionInWindow', () => {
	// IO window: [scrollTop - OVERSCAN_TOP, scrollTop + clientHeight + loadMargin].
	// The observer watches the zero-height placeholder, so it sees only the
	// top point; the extent check is what reconcile uses to keep a section
	// loaded once its content is in view but its top point has left the window.
	const scrollTop = 45000;
	const clientHeight = VIEWPORT;

	it('keeps a section inside the viewport', () => {
		expect(isSectionInWindow(45000, 500, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(true);
	});

	it('keeps a section in the top overscan', () => {
		expect(isSectionInWindow(scrollTop - OVERSCAN_TOP, 100, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(true);
	});

	it('keeps a section in the bottom overscan', () => {
		expect(isSectionInWindow(scrollTop + clientHeight + 500, 100, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(true);
	});

	it('regression: a tall section stays in window while the user stands inside it and its top point has left the window', () => {
		// Profound-style note: offset 30000, ~8000 tall. The user scrolled up
		// into it and stopped at scrollTop 34000 (4000px into the content).
		// The placeholder's top point (30000) is above scrollTop - OVERSCAN_TOP
		// = 31500, so the point-based IO window no longer covers it — the
		// extent check is what must keep it loaded.
		const t = 34000;
		expect(30000).toBeLessThan(t - OVERSCAN_TOP);
		expect(isSectionInWindow(30000, 8000, t, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(true);
	});

	it('drops a section entirely above the window', () => {
		expect(isSectionInWindow(20000, 500, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(false);
	});

	it('drops a section entirely below the window', () => {
		expect(isSectionInWindow(200000, 500, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(false);
	});

	it('drops a tiny-estimate section whose top point is just above the window', () => {
		// Default estimate (35px): extent ends 15px short of the window top
		// (winTop = 42500), so it must not be treated as in-window.
		expect(scrollTop - OVERSCAN_TOP - 50 + 35).toBeLessThan(scrollTop - OVERSCAN_TOP);
		expect(isSectionInWindow(scrollTop - OVERSCAN_TOP - 50, 35, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(false);
	});

	it('keeps a section exactly at the window edges (inclusive)', () => {
		// End flush with the top edge.
		expect(isSectionInWindow(scrollTop - OVERSCAN_TOP - 500, 500, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(true);
		// Top point flush with the bottom edge.
		expect(isSectionInWindow(scrollTop + clientHeight + LOAD_MARGIN, 0, scrollTop, clientHeight, OVERSCAN_TOP, LOAD_MARGIN)).toBe(true);
	});
});
