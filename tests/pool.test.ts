import { describe, it, expect } from 'vitest';
import { isStaleRender, isStaleForDrain, isSectionInWindow, isHeavyContent, buildPlaceholderContent, OVERSCAN_TOP } from '../src/components/SectionPool';

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

describe('isHeavyContent', () => {
	it('flags block math $$ blocks', () => {
		expect(isHeavyContent('some text\n$$\na^2 + b^2 = c^2\n$$')).toBe(true);
	});

	it('flags mermaid fenced blocks', () => {
		expect(isHeavyContent('## Diagram\n```mermaid\ngraph TD;\nA-->B;\n```')).toBe(true);
	});

	it('does not flag inline math ($...$ is too common to be a signal)', () => {
		expect(isHeavyContent('The area is $\\pi r^2$.')).toBe(false);
	});

	it('does not flag tables, callouts, or code fences', () => {
		expect(isHeavyContent('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(false);
		expect(isHeavyContent('> [!note] Callout\n> body')).toBe(false);
		expect(isHeavyContent('```js\nconst x = 1;\n```')).toBe(false);
	});

	it('does not flag plain prose', () => {
		expect(isHeavyContent('# Heading\n\nSome paragraph with **bold** and [a link](https://x.example).')).toBe(false);
	});
});

describe('buildPlaceholderContent', () => {
	it('replaces a multiline $$ block with a math placeholder and keeps surrounding text', () => {
		const src = '# Title\n\nIntro.\n\n$$\nE = mc^2\n$$\n\nOutro.';
		const out = buildPlaceholderContent(src);
		expect(out).toContain('# Title');
		expect(out).toContain('Intro.');
		expect(out).toContain('Outro.');
		expect(out).not.toContain('$$');
		expect(out).toContain('class="book-view-ph book-view-ph-math"');
	});

	it('replaces a single-line $$...$$ block', () => {
		const out = buildPlaceholderContent('$$\nx^2 + y^2 = 1\n$$\n\nMore.');
		expect(out).not.toContain('$$');
		expect(out).toContain('book-view-ph-math');
		expect(out).toContain('More.');
	});

	it('replaces a mermaid fence with a mermaid placeholder', () => {
		const out = buildPlaceholderContent('## Flow\n```mermaid\ngraph TD;\nA-->B;\nB-->C;\n```');
		expect(out).not.toContain('```');
		expect(out).not.toContain('graph TD;');
		expect(out).toContain('## Flow');
		expect(out).toContain('class="book-view-ph book-view-ph-mermaid"');
	});

	it('keeps a normal code fence intact', () => {
		const src = '```js\nconst x = 1;\n```';
		const out = buildPlaceholderContent(src);
		expect(out).toContain('```js');
		expect(out).toContain('const x = 1;');
		expect(out).toContain('```');
		expect(out).not.toContain('book-view-ph');
	});

	it('keeps inline $...$ math untouched', () => {
		const src = 'The area is $\\pi r^2$ and the radius is $r$.';
		expect(buildPlaceholderContent(src)).toBe(src);
	});

	it('keeps tables, callouts and headings untouched', () => {
		const src = '| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!note] Callout\n> body\n\n## Heading';
		expect(buildPlaceholderContent(src)).toBe(src);
	});

	it('handles a begin/end style block that opens on a content line', () => {
		const src = '$$\n\\begin{aligned}\nx + y &= 1 \\\\\nx - y &= 3\n\\end{aligned}\n$$';
		const out = buildPlaceholderContent(src);
		expect(out).not.toContain('$$');
		expect(out).not.toContain('\\begin');
		expect(out).toContain('book-view-ph-math');
	});

	it('strips display math from a mixed line but keeps the text', () => {
		const out = buildPlaceholderContent('Now solve $$x^2=4$$ for x.');
		expect(out).not.toContain('$$');
		expect(out).toContain('Now solve');
		expect(out).toContain('for x.');
		expect(out).toContain('book-view-ph-math');
	});

	it('sizes the placeholder from the block: taller math gets a taller estimate', () => {
		const small = buildPlaceholderContent('$$\na=b\n$$');
		const tall = buildPlaceholderContent('$$\na=b\n\nc=d\n\ne=f\n\n$$');
		const h = (s: string) => Number(/height:(\d+)px/.exec(s)?.[1] ?? 0);
		expect(h(tall)).toBeGreaterThan(h(small));
	});

	it('bounds a long note to a leading excerpt and drops the far tail', () => {
		const longLine = 'x'.repeat(60);
		const src = '# Title\n\nLead paragraph.\n\n$$\nE = mc^2\n$$\n\n'.concat(Array.from({ length: 30 }, () => longLine).join('\n'));
		const out = buildPlaceholderContent(src);
		expect(out).toContain('# Title');
		expect(out).toContain('Lead paragraph.');
		expect(out).not.toContain('$$');
		expect(out).toContain('book-view-ph-math');
		expect(out.length).toBeLessThan(700);
	});

	it('strips a math block that straddles the excerpt cut', () => {
		const src = '# T\n\n$$\n'.concat('a'.repeat(120).concat('\n').repeat(12)).concat('$$\n\nTail.');
		const out = buildPlaceholderContent(src);
		expect(out).not.toContain('$$');
		expect(out).not.toContain('Tail.');
		expect(out).toContain('# T');
	});
});
