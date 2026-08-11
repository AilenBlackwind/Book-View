import { describe, it, expect } from 'vitest';
import {
	FoldContext,
	isFoldedSubtree,
	isSectionHidden,
	getFoldMode,
	sectionNeedsFoldStub,
	nextVisibleIndex,
} from '../src/utils/fold';

/** Builds a FoldContext over the given file order and headings. `folded`
 *  lists directly-folded heading ids; `haveSection` lists paths with layout
 *  data (otherwise getFoldMode treats them as absent). */
function makeCtx(options: {
	fileOrder: string[];
	headings: { id: string; path: string; level: number }[];
	folded?: string[];
	haveSection?: string[];
}): FoldContext {
	const fileIdxOf = new Map(options.fileOrder.map((p, i) => [p, i]));
	const headingIndex = options.headings.map((h, idx) => ({
		...h,
		text: '',
		idx,
		fileIdx: fileIdxOf.get(h.path) ?? -1,
	}));
	const headingIndexById = new Map(headingIndex.map((h) => [h.id, h]));
	const firstHeadingByPath = new Map<string, typeof headingIndex[number]>();
	for (const h of headingIndex) {
		if (!firstHeadingByPath.has(h.path)) firstHeadingByPath.set(h.path, h);
	}
	const sections = new Set(options.haveSection ?? options.fileOrder);
	return {
		foldedHeadings: new Set(options.folded ?? []),
		headingIndex,
		headingIndexById,
		firstHeadingByPath,
		fileOrder: options.fileOrder,
		hasSection: (p) => sections.has(p),
	};
}

describe('isFoldedSubtree', () => {
	const ctx = makeCtx({
		fileOrder: ['f1', 'f2'],
		headings: [
			{ id: 'a', path: 'f1', level: 1 },
			{ id: 'b', path: 'f1', level: 2 },
			{ id: 'c', path: 'f1', level: 3 },
			{ id: 'd', path: 'f2', level: 1 },
		],
	});

	it('returns true for a directly folded heading', () => {
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [{ id: 'b', path: 'f1', level: 2 }],
			folded: ['b'],
		});
		expect(isFoldedSubtree('b', c)).toBe(true);
	});

	it('returns true for a heading inside a folded ancestor subtree', () => {
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'b', path: 'f1', level: 2 },
				{ id: 'c', path: 'f1', level: 3 },
			],
			folded: ['a'],
		});
		expect(isFoldedSubtree('c', c)).toBe(true);
	});

	it('returns false when the fold lives in a different tree', () => {
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'b', path: 'f1', level: 2 },
				{ id: 'd', path: 'f2', level: 1 },
			],
			folded: ['d'],
		});
		expect(isFoldedSubtree('b', c)).toBe(false);
	});

	it('a folded descendant does not hide its ancestors', () => {
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'c', path: 'f1', level: 3 },
			],
			folded: ['c'],
		});
		expect(isFoldedSubtree('a', c)).toBe(false);
	});

	it('returns false for an unknown heading id', () => {
		expect(isFoldedSubtree('zzz', ctx)).toBe(false);
	});

	it('short-circuits when no heading is folded at all', () => {
		// Mirrors the stress-book shape (every section starts with an h1, no
		// folds): previously every call scanned back to index 0, making a
		// recalcOffsets pass over N sections O(N²).
		const headings = Array.from({ length: 1000 }, (_, i) => ({ id: `h${i}`, path: 'f1', level: 1 }));
		const c = makeCtx({ fileOrder: ['f1'], headings });
		expect(isFoldedSubtree('h999', c)).toBe(false);
	});

	it('does not scan past the top-level heading when folds exist', () => {
		// 'c' is an h1 under other h1s; folding 'd' (h2 below it) must not hide
		// 'c', and the scan must stop at the h1 instead of walking to index 0.
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'b', path: 'f1', level: 1 },
				{ id: 'c', path: 'f1', level: 1 },
				{ id: 'd', path: 'f1', level: 2 },
			],
			folded: ['d'],
		});
		expect(isFoldedSubtree('c', c)).toBe(false);
		expect(isFoldedSubtree('d', c)).toBe(true);
	});
});

describe('isSectionHidden', () => {
	it('hides a section whose own first heading is folded', () => {
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'd', path: 'f2', level: 1 },
			],
			folded: ['a'],
		});
		expect(isSectionHidden('f1', c)).toBe(true);
		expect(isSectionHidden('f2', c)).toBe(false);
	});

	it('hides a text-only section that follows a folded heading', () => {
		// f2 has no headings of its own; it is hidden when the last heading
		// before it (a, the only heading of f1) is folded.
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
		});
		expect(isSectionHidden('f2', c)).toBe(false);
		const c2 = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
			folded: ['a'],
		});
		expect(isSectionHidden('f2', c2)).toBe(true);
	});

	it('keeps a text-only section visible when a later sibling heading is not folded', () => {
		// Folding 'a' hides content up to the next level-1 heading 'd', so a
		// text-only section after 'd' stays visible.
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'd', path: 'f1', level: 1 },
			],
			folded: ['a'],
		});
		expect(isSectionHidden('f2', c)).toBe(false);
	});

	it('returns false for an unknown path', () => {
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
		});
		expect(isSectionHidden('zzz', c)).toBe(false);
	});
});

describe('getFoldMode', () => {
	it('is none when the section is not hidden', () => {
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
		});
		expect(getFoldMode('f1', c)).toBe('none');
	});

	it('is full when the section has no layout data', () => {
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
			folded: ['a'],
			haveSection: ['f1'],
		});
		expect(getFoldMode('f2', c)).toBe('full');
	});

	it('is full when hidden by an ancestor but its own heading is not folded', () => {
		// f2's heading is a descendant of folded 'a' → hidden, but f2's own
		// heading is not directly folded → nothing to show as a stub.
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'd', path: 'f2', level: 2 },
			],
			folded: ['a'],
		});
		expect(getFoldMode('f2', c)).toBe('full');
	});

	it('is heading when the section own first heading is folded', () => {
		const c = makeCtx({
			fileOrder: ['f1'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
			folded: ['a'],
		});
		expect(getFoldMode('f1', c)).toBe('heading');
	});
});

describe('sectionNeedsFoldStub', () => {
	it('is true only for a hidden section whose own heading is folded', () => {
		const own = makeCtx({
			fileOrder: ['f1'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
			folded: ['a'],
		});
		expect(sectionNeedsFoldStub('f1', own)).toBe(true);

		const byAncestor = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'd', path: 'f2', level: 2 },
			],
			folded: ['a'],
		});
		expect(sectionNeedsFoldStub('f2', byAncestor)).toBe(false);

		const visible = makeCtx({
			fileOrder: ['f1'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
		});
		expect(sectionNeedsFoldStub('f1', visible)).toBe(false);
	});

	it('is false for a hidden section without its own heading', () => {
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [{ id: 'a', path: 'f1', level: 1 }],
			folded: ['a'],
		});
		expect(sectionNeedsFoldStub('f2', c)).toBe(false);
	});
});

describe('nextVisibleIndex', () => {
	it('returns the next file index whose section is not fully hidden', () => {
		// f1 folded (heading), f2 hidden-by-ancestor (full), f3 visible.
		const c = makeCtx({
			fileOrder: ['f1', 'f2', 'f3'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'd', path: 'f2', level: 2 },
				{ id: 'g', path: 'f3', level: 1 },
			],
			folded: ['a'],
		});
		expect(nextVisibleIndex(0, c)).toBe(2);
		expect(nextVisibleIndex(1, c)).toBe(2);
		expect(nextVisibleIndex(2, c)).toBe(-1);
	});

	it('returns -1 when every following section is fully hidden', () => {
		const c = makeCtx({
			fileOrder: ['f1', 'f2'],
			headings: [
				{ id: 'a', path: 'f1', level: 1 },
				{ id: 'd', path: 'f2', level: 2 },
			],
			folded: ['a'],
		});
		expect(nextVisibleIndex(0, c)).toBe(-1);
	});
});
