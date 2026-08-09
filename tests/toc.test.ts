import { describe, it, expect } from 'vitest';
import { pickActiveIndex, computeActivePath, computeHiddenState } from '../src/utils/toc';
import { computeHeadingFoldState } from '../src/utils/fold';

describe('pickActiveIndex', () => {
	it('returns the last entry above the trigger line', () => {
		const positions = [0, 500, 1000];
		// scrollTop 200 + 30% of a 1000px viewport = 500 → the heading at 500 wins.
		expect(pickActiveIndex(positions, 200, 1000)).toBe(1);
	});

	it('returns -1 when scrolled above the first heading', () => {
		const positions = [100, 500];
		// triggerY = 0 + 30% of 100px = 30, nothing is above it.
		expect(pickActiveIndex(positions, 0, 100)).toBe(-1);
	});

	it('returns -1 for an empty ToC', () => {
		expect(pickActiveIndex([], 0, 800)).toBe(-1);
	});

	it('recomputes from the fresh positions after section offsets shift', () => {
		// A height correction moved the second heading below the trigger line,
		// so the active entry must move up even though scrollTop is unchanged.
		// This is the "highlight flies away" regression: the highlight must
		// follow the *new* offsets, not keep pointing at the stale one.
		const scrollTop = 300;
		const before = [0, 400, 700];
		const after = [0, 900, 1300];
		expect(pickActiveIndex(before, scrollTop, 1000)).toBe(1);
		expect(pickActiveIndex(after, scrollTop, 1000)).toBe(0);
	});
});

describe('computeActivePath', () => {
	it('includes the entry itself when it has children', () => {
		// levels: [1, 2, 3, 3, 2], active = index 3 (a level-3 heading).
		const entries = [{ level: 1 }, { level: 2 }, { level: 3 }, { level: 3 }, { level: 2 }];
		expect(computeActivePath(entries, 3)).toEqual(new Set([0, 1]));
	});

	it('returns an empty set for an out-of-range index', () => {
		const entries = [{ level: 1 }];
		expect(computeActivePath(entries, 5)).toEqual(new Set());
	});

	it('returns an empty set for an empty ToC', () => {
		expect(computeActivePath([], 0)).toEqual(new Set());
	});
});

describe('computeHiddenState', () => {
	const entries = [{ level: 1 }, { level: 2 }, { level: 2 }, { level: 1 }, { level: 3 }];

	it('hides nothing when every ancestor is expanded', () => {
		const state = computeHiddenState(entries, () => true);
		expect(state).toEqual([false, false, false, false, false]);
	});

	it('hides all descendants of a collapsed root', () => {
		const state = computeHiddenState(entries, (i) => i !== 0);
		// Root itself stays visible; its whole subtree hides.
		expect(state).toEqual([false, true, true, false, false]);
	});

	it('keeps a collapsed entry itself visible while hiding its children', () => {
		// Chain [1, 2, 3]: collapsing the middle heading hides its child.
		const chain = [{ level: 1 }, { level: 2 }, { level: 3 }];
		const state = computeHiddenState(chain, (i) => i !== 1);
		expect(state).toEqual([false, false, true]);
	});
});

describe('computeHeadingFoldState', () => {
	// Mirrors AbsoluteSectionManager.isFoldedSubtree: a heading is folded when
	// it or any ancestor heading is directly folded.
	function inFoldedSubtree(levels: number[], directlyFolded: Set<number>, i: number): boolean {
		if (directlyFolded.has(i)) return true;
		let level = levels[i]!;
		for (let j = i - 1; j >= 0; j--) {
			const l = levels[j]!;
			if (l < level) {
				if (directlyFolded.has(j)) return true;
				level = l;
			}
		}
		return false;
	}

	const folded = (levels: number[], direct: number[]) => (i: number) =>
		inFoldedSubtree(levels, new Set(direct), i);

	it('hides the subtree of a folded low-level heading until the next heading of the same level', () => {
		const levels = [1, 2, 2];
		const state = computeHeadingFoldState(levels, folded(levels, [1]));
		expect(state).toEqual([
			{ hiddenByAncestor: false, startsFold: false, active: false },
			{ hiddenByAncestor: false, startsFold: true, active: true },
			{ hiddenByAncestor: false, startsFold: false, active: false },
		]);
	});

	it('keeps a nested heading inside a folded subtree hidden but visible at its own level', () => {
		// [1, 2, 3, 3, 2]: folding the level-2 heading hides the nested level-3
		// headings; the trailing sibling level-2 heading is unaffected.
		const levels = [1, 2, 3, 3, 2];
		const state = computeHeadingFoldState(levels, folded(levels, [1]));
		expect(state).toEqual([
			{ hiddenByAncestor: false, startsFold: false, active: false },
			{ hiddenByAncestor: false, startsFold: true, active: true },
			{ hiddenByAncestor: true, startsFold: true, active: true },
			{ hiddenByAncestor: true, startsFold: true, active: true },
			{ hiddenByAncestor: false, startsFold: false, active: false },
		]);
	});

	it('folding a root-level heading hides every following heading', () => {
		const levels = [1, 2, 3];
		const state = computeHeadingFoldState(levels, folded(levels, [0]));
		expect(state).toEqual([
			{ hiddenByAncestor: false, startsFold: true, active: true },
			{ hiddenByAncestor: true, startsFold: true, active: true },
			{ hiddenByAncestor: true, startsFold: true, active: true },
		]);
	});

	it('handles an empty heading list', () => {
		expect(computeHeadingFoldState([], () => false)).toEqual([]);
	});
});
