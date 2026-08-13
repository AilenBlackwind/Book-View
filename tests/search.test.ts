import { describe, it, expect } from 'vitest';
import { searchLines } from '../src/search/matcher';

const inputs = [
	{ path: 'a.md', content: 'The quick brown fox\njumps over the lazy dog' },
	{ path: 'b.md', content: 'Quick brown\n\nAnother line' },
];

describe('searchLines', () => {
	it('finds case-insensitive matches with 0-based line numbers', () => {
		const hits = searchLines(inputs, 'brown');
		expect(hits).toEqual([
			{ filePath: 'a.md', line: 0, column: 10, lineText: 'The quick brown fox', match: 'brown', index: 0 },
			{ filePath: 'b.md', line: 0, column: 6, lineText: 'Quick brown', match: 'brown', index: 0 },
		]);
	});

	it('matches query case-insensitively by default', () => {
		const hits = searchLines(inputs, 'QUICK');
		expect(hits.map((h) => h.lineText)).toEqual(['The quick brown fox', 'Quick brown']);
	});

	it('respects caseSensitive', () => {
		const hits = searchLines(inputs, 'quick', { caseSensitive: true });
		expect(hits.map((h) => h.lineText)).toEqual(['The quick brown fox']);
	});

	it('reports every occurrence on one line', () => {
		const hits = searchLines([{ path: 'a.md', content: 'aaa' }], 'a');
		expect(hits.map((h) => h.column)).toEqual([0, 1, 2]);
	});

	it('returns no hits for an empty or whitespace-only query', () => {
		expect(searchLines(inputs, '')).toEqual([]);
		expect(searchLines(inputs, '   ')).toEqual([]);
	});

	it('returns no hits when nothing matches', () => {
		expect(searchLines(inputs, 'zzz')).toEqual([]);
	});

	it('handles CRLF line endings with clean columns', () => {
		const hits = searchLines([{ path: 'a.md', content: 'foo\r\nbar\r\nbaz' }], 'bar');
		expect(hits).toEqual([
			{ filePath: 'a.md', line: 1, column: 0, lineText: 'bar', match: 'bar', index: 0 },
		]);
	});

	it('numbers hits sequentially within each file in document order', () => {
		const hits = searchLines(
			[
				{ path: 'a.md', content: 'мир и умирать\nа потом снова мир' },
				{ path: 'b.md', content: 'мир только тут' },
			],
			'мир',
		);
		expect(hits.map((h) => [h.filePath, h.line, h.index])).toEqual([
			['a.md', 0, 0],
			['a.md', 0, 1],
			['a.md', 1, 2],
			['b.md', 0, 0],
		]);
	});

	it('caps results at maxResults', () => {
		const hits = searchLines([{ path: 'a.md', content: 'a\na\na\na' }], 'a', { maxResults: 3 });
		expect(hits).toHaveLength(3);
	});

	it('does not match across a trailing line without a newline', () => {
		const hits = searchLines([{ path: 'a.md', content: 'word' }], 'word');
		expect(hits).toHaveLength(1);
		const first = hits[0];
		if (!first) throw new Error('expected one hit');
		expect(first.line).toBe(0);
	});
});
