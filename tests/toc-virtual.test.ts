import { describe, it, expect } from 'vitest';
import { buildVirtualItems, computeVirtualOffsets, firstItemAt, firstItemAfter } from '../src/toc/virtual';

const entries = [
	{ file: { path: 'a.md' }, level: 1 },
	{ file: { path: 'a.md' }, level: 2 },
	{ file: { path: 'a.md' }, level: 2 },
	{ file: { path: 'b.md' }, level: 1 },
	{ file: { path: 'b.md' }, level: 3 },
];
const files = [{ path: 'a.md' }, { path: 'b.md' }];
const ALL = [false, false, false, false, false];

describe('buildVirtualItems', () => {
	it('flattens files + visible headings in order with file rows', () => {
		const { items, entryToItem } = buildVirtualItems(entries, files, ALL, true);
		expect(items).toEqual([
			{ type: 'file', index: 0 },
			{ type: 'heading', index: 0, level: 1 },
			{ type: 'heading', index: 1, level: 2 },
			{ type: 'heading', index: 2, level: 2 },
			{ type: 'file', index: 1 },
			{ type: 'heading', index: 3, level: 1 },
			{ type: 'heading', index: 4, level: 3 },
		]);
		expect(entryToItem).toEqual([1, 2, 3, 5, 6]);
	});

	it('skips file rows when tocShowFileNames is off', () => {
		const { items } = buildVirtualItems(entries, files, ALL, false);
		expect(items.filter((i) => i.type === 'file')).toHaveLength(0);
		expect(items).toHaveLength(5);
	});

	it('drops hidden headings but keeps their file row', () => {
		const hidden = [false, true, true, false, false];
		const { items, entryToItem } = buildVirtualItems(entries, files, hidden, true);
		expect(items).toEqual([
			{ type: 'file', index: 0 },
			{ type: 'heading', index: 0, level: 1 },
			{ type: 'file', index: 1 },
			{ type: 'heading', index: 3, level: 1 },
			{ type: 'heading', index: 4, level: 3 },
		]);
		expect(entryToItem).toEqual([1, -1, -1, 3, 4]);
	});

	it('skips files without headings entirely', () => {
		const onlyA = [{ file: { path: 'a.md' }, level: 1 }];
		const withB = [{ path: 'a.md' }, { path: 'b.md' }];
		const { items } = buildVirtualItems(onlyA, withB, [false], true);
		expect(items).toEqual([
			{ type: 'file', index: 0 },
			{ type: 'heading', index: 0, level: 1 },
		]);
	});

	it('handles an empty ToC', () => {
		const { items, entryToItem } = buildVirtualItems([], [], [], true);
		expect(items).toEqual([]);
		expect(entryToItem).toEqual([]);
	});
});

describe('computeVirtualOffsets', () => {
	it('accumulates heading and file heights', () => {
		const { items } = buildVirtualItems(entries, files, ALL, true);
		const offsets = computeVirtualOffsets(items, 26, 30);
		// file(30) + 3 headings(26) + file(30) + 2 headings(26)
		expect(offsets).toEqual([0, 30, 56, 82, 108, 138, 164, 190]);
	});

	it('returns [0] for an empty list', () => {
		expect(computeVirtualOffsets([], 26, 30)).toEqual([0]);
	});
});

describe('firstItemAt / firstItemAfter', () => {
	const offsets = [0, 30, 56, 82, 108, 138, 164, 190];

	it('firstItemAt finds the row covering y', () => {
		expect(firstItemAt(offsets, 0, 7)).toBe(0);
		expect(firstItemAt(offsets, 29, 7)).toBe(0);
		expect(firstItemAt(offsets, 30, 7)).toBe(1);
		expect(firstItemAt(offsets, 55, 7)).toBe(1);
		expect(firstItemAt(offsets, 150, 7)).toBe(5);
	});

	it('firstItemAt clamps past the end to the last row', () => {
		expect(firstItemAt(offsets, 10_000, 7)).toBe(7);
	});

	it('firstItemAfter finds the exclusive end of the visible range', () => {
		expect(firstItemAfter(offsets, 0, 7)).toBe(0);
		expect(firstItemAfter(offsets, 60, 7)).toBe(3);
		expect(firstItemAfter(offsets, 190, 7)).toBe(7);
		expect(firstItemAfter(offsets, 10_000, 7)).toBe(7);
	});
});
