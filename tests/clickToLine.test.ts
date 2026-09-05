import { describe, it, expect } from 'vitest';
import { foldIdLine, domToSectionOffset, lineAtFraction, type LineSection, type DomHeading } from '../src/utils/clickToLine';

const sections = (rows: Array<[string, number, number]>): LineSection[] =>
	rows.map(([type, startLine, endLine]) => ({ type, startLine, endLine }));

const headings = (rows: Array<[number, number]>): DomHeading[] =>
	rows.map(([blockIndex, line]) => ({ blockIndex, line }));

describe('foldIdLine', () => {
	it('extracts the line from a data-fold-id', () => {
		expect(foldIdLine('notes/a.md#L12')).toBe(12);
	});

	it('returns null for ids without a line', () => {
		expect(foldIdLine('notes/a.md')).toBeNull();
		expect(foldIdLine('')).toBeNull();
	});
});

describe('domToSectionOffset', () => {
	it('returns 0 for a note without headings (lockstep after yaml filter)', () => {
		const secs = sections([
			['paragraph', 0, 2],
			['list', 3, 7],
		]);
		expect(domToSectionOffset([], secs)).toBe(0);
	});

	it('finds a constant offset when yaml is not filtered (DOM has no yaml block)', () => {
		const secs = sections([
			['yaml', 0, 5],
			['heading', 6, 6],
			['paragraph', 7, 9],
			['heading', 10, 10],
		]);
		// DOM: heading(block 0), paragraph(block 1), heading(block 2) — the
		// yaml section (index 0) has no rendered block, so every DOM index
		// maps to sections index + 1.
		const dom = headings([
			[0, 6],
			[2, 10],
		]);
		expect(domToSectionOffset(dom, secs)).toBe(1);
	});

	it('returns null when anchors disagree (wrapper blocks break lockstep)', () => {
		const secs = sections([
			['heading', 0, 0],
			['paragraph', 1, 2],
			['heading', 3, 3],
			['paragraph', 4, 5],
		]);
		// The second DOM heading sits at a block index that implies a
		// different offset than the first one.
		const dom = headings([
			[0, 0],
			[5, 3],
		]);
		expect(domToSectionOffset(dom, secs)).toBeNull();
	});

	it('returns null when a rendered heading never matches a section', () => {
		const secs = sections([
			['paragraph', 0, 5],
		]);
		expect(domToSectionOffset(headings([[0, 0]]), secs)).toBeNull();
	});
});

describe('lineAtFraction', () => {
	it('maps fraction onto single- and multi-line sections', () => {
		expect(lineAtFraction({ type: 'paragraph', startLine: 4, endLine: 4 }, 0.5)).toBe(4);
		expect(lineAtFraction({ type: 'paragraph', startLine: 0, endLine: 3 }, 0)).toBe(0);
		expect(lineAtFraction({ type: 'paragraph', startLine: 0, endLine: 3 }, 1)).toBe(3);
		expect(lineAtFraction({ type: 'paragraph', startLine: 0, endLine: 3 }, 0.5)).toBe(2);
	});

	it('clamps the fraction', () => {
		expect(lineAtFraction({ type: 'paragraph', startLine: 2, endLine: 5 }, -1)).toBe(2);
		expect(lineAtFraction({ type: 'paragraph', startLine: 2, endLine: 5 }, 2)).toBe(5);
	});
});