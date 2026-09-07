import { describe, it, expect } from 'vitest';
import {
	foldIdLine,
	domToSectionOffset,
	lineAtFraction,
	lineForListItem,
	listItemStartLines,
	scanContentBlocks,
	type LineSection,
	type DomHeading,
} from '../src/utils/clickToLine';

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

describe('lineForListItem', () => {
	it('maps the clicked item to its exact start line', () => {
		const sec: LineSection = { type: 'list', startLine: 10, endLine: 12 };
		// Three rendered items -> three cache item lines inside the span.
		const itemLines = [10, 11, 12];
		expect(lineForListItem(sec, 3, itemLines, 0)).toBe(10);
		expect(lineForListItem(sec, 3, itemLines, 1)).toBe(11);
		expect(lineForListItem(sec, 3, itemLines, 2)).toBe(12);
	});

	it('returns null when the rendered count disagrees with the cache span', () => {
		const sec: LineSection = { type: 'list', startLine: 5, endLine: 6 };
		// Only one cache item spans 5..6 but two items rendered -> drift.
		expect(lineForListItem(sec, 2, [5], 1)).toBeNull();
	});

	it('returns null for an out-of-range item index', () => {
		const sec: LineSection = { type: 'list', startLine: 5, endLine: 5 };
		expect(lineForListItem(sec, 1, [5], 1)).toBeNull();
		expect(lineForListItem(sec, 1, [5], -1)).toBeNull();
	});

	it('handles nested items: dom order matches listItems span order', () => {
		const sec: LineSection = { type: 'list', startLine: 0, endLine: 2 };
		// - A      <- A'li, nested B'li below
		//   - B
		// - C
		// DOM: <ul><li>A<ul><li>B</li></ul></li><li>C</li></ul> -> 3 li.
		// Obsidian listItems record every item, nested included.
		const itemLines = [0, 1, 2];
		expect(lineForListItem(sec, 3, itemLines, 0)).toBe(0); // A
		expect(lineForListItem(sec, 3, itemLines, 1)).toBe(1); // B (nested)
		expect(lineForListItem(sec, 3, itemLines, 2)).toBe(2); // C
	});

	it('maps items whose enclosing section is a callout, not a list', () => {
		// > [!note]
		// > - one
		// > - two
		// A callout is one root 'callout' section spanning the whole block;
		// its inner list items are still recorded in cache.listItems.
		const sec: LineSection = { type: 'callout', startLine: 0, endLine: 2 };
		const itemLines = [1, 2];
		expect(lineForListItem(sec, 2, itemLines, 0)).toBe(1);
		expect(lineForListItem(sec, 2, itemLines, 1)).toBe(2);
	});
});

describe('scanContentBlocks', () => {
	it('splits a note into root blocks in source order, yaml excluded', () => {
		const content = [
			'---',
			'title: x',
			'---',
			'# One',
			'text a',
			'text b',
			'',
			'- item 1',
			'- item 2',
			'  - sub',
			'',
			'```js',
			'- not an item',
			'```',
			'',
			'> [!note]',
			'> - in callout',
			'> - two',
			'',
			'h2 below',
			'===',
			'',
			'a | b',
			'--|--',
			'1 | 2',
		].join('\n');
		expect(scanContentBlocks(content)).toEqual([
			{ type: 'heading', startLine: 3, endLine: 3 },
			{ type: 'paragraph', startLine: 4, endLine: 5 },
			{ type: 'list', startLine: 7, endLine: 9 },
			{ type: 'code', startLine: 11, endLine: 13 },
			{ type: 'blockquote', startLine: 15, endLine: 17 },
			{ type: 'heading', startLine: 19, endLine: 20 },
			{ type: 'table', startLine: 22, endLine: 24 },
		]);
	});

	it('treats a `---` underline as a setext heading, not a break', () => {
		// title
		// ---
		// More
		expect(scanContentBlocks(['title', '---', 'More'].join('\n'))).toEqual([
			{ type: 'heading', startLine: 0, endLine: 1 },
			{ type: 'paragraph', startLine: 2, endLine: 2 },
		]);
	});

	it('keeps a standalone `---` between paragraphs as a thematic break', () => {
		expect(scanContentBlocks(['a', '', '---'].join('\n'))).toEqual([
			{ type: 'paragraph', startLine: 0, endLine: 0 },
			{ type: 'hr', startLine: 2, endLine: 2 },
		]);
	});

	it('does not mistake fenced-code content or a dash menu for blocks', () => {
		const content = [
			'para',
			'- an actual list',
			'  continuation',
			'- c',
			'',
			'```',
			'# fake',
			'- fake item',
			'---',
			'```',
		].join('\n');
		expect(scanContentBlocks(content)).toEqual([
			{ type: 'paragraph', startLine: 0, endLine: 0 },
			{ type: 'list', startLine: 1, endLine: 3 },
			{ type: 'code', startLine: 5, endLine: 9 },
		]);
	});
});

describe('listItemStartLines', () => {
	it('collects bullets, ordered, tasks and quoted items in DOM order', () => {
		const content = [
			'---',
			'tags: [a, - b]',
			'---',
			'- one',
			'- two',
			'  - nested',
			'2. ordered',
			'> - in callout',
			'> - two',
		].join('\n');
		expect(listItemStartLines(content)).toEqual([3, 4, 5, 6, 7, 8]);
	});

	it('skips yaml and fenced-code lookalikes', () => {
		const content = [
			'text',
			'',
			'```',
			'- one',
			'```',
			'- two',
		].join('\n');
		expect(listItemStartLines(content)).toEqual([5]);
	});

	it('does not count continuation lines as new items', () => {
		// - a
		//   b
		// - c
		const content = ['- a', '  b', '- c'].join('\n');
		expect(listItemStartLines(content)).toEqual([0, 2]);
	});
});