import { describe, it, expect, vi } from 'vitest';
import type { Editor, MarkdownPostProcessorContext } from 'obsidian';
import { cssClassesFromFrontmatter, frontmatterEndOffset } from '../src/components/ManifestParser';
import { updateLinksInContent } from '../src/components/LinkUpdater';
import { parseBookViewBlocks, parseCodeBlockLinks } from '../src/components/CodeBlockParser';
import { insertCodeBlockLink, locateCodeBlock, removeCodeBlockLink, reorderCodeBlockLinks } from '../src/components/CodeBlockEdits';

describe('parseCodeBlockLinks scoping', () => {
	it('ignores links outside book-view fences in full-file content (frontmatter + body)', () => {
		const content = `---
book-view: true
chapters:
  - "[[FrontmatterOnly]]"
---
Intro [[BodyLink]]
\`\`\`book-view
[[InBlock]]
\`\`\`
`;
		const targets = parseBookViewBlocks(content).map((l) => l.target);
		expect(targets).toEqual(['InBlock']);
		expect(targets).not.toContain('FrontmatterOnly');
		expect(targets).not.toContain('BodyLink');
	});

	it('scans whole input when no fence present (code-block processor inner content)', () => {
		const inner = '[[A]]\n[[B|Alias]]\nplain line\n[C](/C.md)';
		const targets = parseCodeBlockLinks(inner).map((l) => l.target);
		expect(targets).toEqual(['A', 'B', '/C.md']);
	});

	it('handles CRLF fences', () => {
		const content = '```book-view\r\n[[A]]\r\n[[B]]\r\n```';
		expect(parseBookViewBlocks(content).map((l) => l.target)).toEqual(['A', 'B']);
	});

	it('records the source offset of each link for click-to-edit line mapping', () => {
		const inner = '[[A]]\n[[B|Alias]]\nplain line\n[C](/C.md)';
		const links = parseCodeBlockLinks(inner);
		expect(links.map((l) => l.offset)).toEqual([0, 6, 29]);
		const lineOf = (offset: number): number =>
			inner.slice(0, offset).split('\n').length - 1;
		expect(links.map((l) => lineOf(l.offset))).toEqual([0, 1, 3]);
	});
});

describe('code-block list edits', () => {
	it('removes only the selected link, including placeholders and duplicate targets', () => {
		const body = '[[A]]\r\n  [[]]\r\n[[A]] and [[B]]\r\n';
		const links = parseCodeBlockLinks(body, true);
		expect(removeCodeBlockLink(body, links[1]!)).toBe('[[A]]\r\n[[A]] and [[B]]\r\n');
		expect(removeCodeBlockLink(body, links[2]!)).toBe('[[A]]\r\n  [[]]\r\n and [[B]]\r\n');
		expect(removeCodeBlockLink('[[A]]\r\n', links[0]!)).toBe('');
	});

	it('reorders exact links and preserves prefixes, separators and trailing text', () => {
		const body = '  - [[A|Alias]] and [B](./b.md)\n\n  [[C]] trailing\n';
		expect(reorderCodeBlockLinks(body, 0, 2))
			.toBe('  - [B](./b.md) and [[C]]\n\n  [[A|Alias]] trailing\n');
	});

	it('inserts below the selected link even when the next link shares a line', () => {
		const body = '[[A]] [[B]]\n[[C]]\n';
		expect(insertCodeBlockLink(body, 0, '[[/Draft.md]]', ''))
			.toBe('[[A]]\n[[/Draft.md]]\n [[B]]\n[[C]]\n');
		expect(insertCodeBlockLink(body, 1, '[[/Draft.md]]', ''))
			.toBe('[[A]] [[B]]\n[[/Draft.md]]\n[[C]]\n');
	});

	it('keeps empty link slots editable and excludes them from book chapters', () => {
		const body = '[[A]]\n[[]]\n[[B]]\n';
		expect(parseBookViewBlocks('```book-view\n' + body + '```').map((link) => link.target)).toEqual(['A', 'B']);
		expect(parseCodeBlockLinks(body, true).map((link) => link.target)).toEqual(['A', '', 'B']);
		expect(reorderCodeBlockLinks(body, 1, 2)).toBe('[[A]]\n[[B]]\n[[]]\n');
		expect(insertCodeBlockLink(body, 1, '[[C]]', '')).toBe('[[A]]\n[[]]\n[[C]]\n[[B]]\n');
	});

	it('keeps the viewport snapshot in the same transaction as the reorder', () => {
		const lines = ['```book-view', '[[A]]', '[[B]]', '```'];
		const body = '[[A]]\n[[B]]\n';
		const changes = vi.fn((change: object) => change);
		const effect = {};
		const map = vi.fn(() => effect);
		const dispatch = vi.fn();
		const editor = {
			lineCount: () => lines.length, getLine: (line: number) => lines[line],
			getRange: () => body, posToOffset: () => lines[0]!.length + 1,
			cm: { state: { changes }, scrollSnapshot: () => ({ map }), dispatch },
		} as unknown as Editor;
		const ctx = {
			getSectionInfo: () => ({ lineStart: 0, lineEnd: 3 }),
		} as unknown as MarkdownPostProcessorContext;
		const block = locateCodeBlock(editor, ctx, {} as HTMLElement, body.trimEnd());
		expect(block).toBeDefined();
		block?.replaceKeepingScroll(reorderCodeBlockLinks(body, 0, 1));
		const change = { from: 15, to: 22, insert: 'B]]\n[[A' };
		expect(map).toHaveBeenCalledWith(change);
		expect(dispatch).toHaveBeenCalledExactlyOnceWith({ changes: change, effects: effect, userEvent: 'input.drop' });
	});
});

describe('frontmatterEndOffset', () => {
	it('returns 0 when there is no frontmatter block', () => {
		expect(frontmatterEndOffset('just body\n[[Note]]')).toBe(0);
	});

	it('returns the offset after the closing --- for a standard block', () => {
		const content = '---\nchapters:\n  - "[[A]]"\n---\n\n[[Body]]\n';
		// The boundary is right after the closing `---\n` (where the body
		// content begins); the blank separator line is body.
		expect(frontmatterEndOffset(content)).toBe('---\nchapters:\n  - "[[A]]"\n---\n'.length);
	});

	it('handles CRLF line endings', () => {
		const content = '---\r\nchapters:\r\n  - "[[A]]"\r\n---\r\n\r\n[[Body]]\r\n';
		expect(frontmatterEndOffset(content)).toBe('---\r\nchapters:\r\n  - "[[A]]"\r\n---\r\n'.length);
	});
});

describe('updateLinksInContent', () => {
	const manifest = 'Books/Manifest.md';

	it.each([
		['[[Folder/Note.md]]', '[[Folder/New.md]]'],
		['[[Folder/Note.md|Alias]]', '[[Folder/New.md|Alias]]'],
		['[[Folder/Note]]', '[[Folder/New]]'],
		['[Note](/Folder/Note.md)', '[Note](/Folder/New.md)'],
		['[Note](../Folder/Note.md)', '[Note](./../Folder/New.md)'],
	])('handles actual rename event paths for %s', (before, after) => {
		const content = `\`\`\`book-view\n${before}\n\`\`\``;
		expect(updateLinksInContent(content, 'Folder/Note.md', 'Folder/New.md', manifest))
			.toBe(`\`\`\`book-view\n${after}\n\`\`\``);
	});

	it('rewrites a wikilink pointing at the renamed file', () => {
		const content = '```book-view\n[[Folder/Note]]\n```\n';
		const updated = updateLinksInContent(content, 'Folder/Note', 'Folder/NoteNew', manifest);
		expect(updated).toBe('```book-view\n[[Folder/NoteNew]]\n```\n');
	});

	it('rewrites a wikilink with alias, preserving the alias', () => {
		const content = '```book-view\n[[Folder/Note|My Alias]]\n```\n';
		const updated = updateLinksInContent(content, 'Folder/Note', 'Folder/NoteNew', manifest);
		expect(updated).toBe('```book-view\n[[Folder/NoteNew|My Alias]]\n```\n');
	});

	it('rewrites a wikilink written with an explicit .md extension', () => {
		const content = '```book-view\n[[Folder/Note.md]]\n```\n';
		const updated = updateLinksInContent(content, 'Folder/Note', 'Folder/NoteNew', manifest);
		expect(updated).toBe('```book-view\n[[Folder/NoteNew.md]]\n```\n');
	});

	it('rewrites an absolute markdown link target keeping its display text', () => {
		const content = '```book-view\n[Show Me](/Folder/Note.md)\n```\n';
		const updated = updateLinksInContent(content, 'Folder/Note', 'Folder/NoteNew', manifest);
		expect(updated).toBe('```book-view\n[Show Me](/Folder/NoteNew.md)\n```\n');
	});

	it('rewrites a relative markdown link against the manifest directory', () => {
		const content = '```book-view\n[Note](./Note.md)\n```\n';
		const updated = updateLinksInContent(content, 'Books/Note', 'Books/NoteNew', manifest);
		expect(updated).toBe('```book-view\n[Note](./NoteNew.md)\n```\n');
	});

	it('ignores links to other files', () => {
		const content = '```book-view\n[[Other/File]]\n```\n';
		expect(updateLinksInContent(content, 'Folder/Note', 'Folder/NoteNew', manifest)).toBeNull();
	});

	it('ignores content outside book-view code blocks', () => {
		const content = '[[Folder/Note]]\n```js\n[[Folder/Note]]\n```\n';
		expect(updateLinksInContent(content, 'Folder/Note', 'Folder/NoteNew', manifest)).toBeNull();
	});

	it('rewrites multiple links inside one block', () => {
		const content = '```book-view\n[[A/Note]]\n[[A/Note|X]]\n[A/Note](/A/Note.md)\n```\n';
		const updated = updateLinksInContent(content, 'A/Note', 'A/Renamed', manifest);
		expect(updated).toBe('```book-view\n[[A/Renamed]]\n[[A/Renamed|X]]\n[A/Note](/A/Renamed.md)\n```\n');
	});
});

describe('cssClassesFromFrontmatter', () => {
	it('returns [] for missing or empty frontmatter', () => {
		expect(cssClassesFromFrontmatter(null)).toEqual([]);
		expect(cssClassesFromFrontmatter(undefined)).toEqual([]);
		expect(cssClassesFromFrontmatter({})).toEqual([]);
	});

	it('reads a YAML list from `cssclasses`', () => {
		expect(cssClassesFromFrontmatter({ cssclasses: ['my-book', 'dark-book'] })).toEqual(['my-book', 'dark-book']);
	});

	it('splits a comma-separated string value', () => {
		expect(cssClassesFromFrontmatter({ cssclasses: 'my-book, dark-book' })).toEqual(['my-book', 'dark-book']);
	});

	it('reads the legacy `cssclass` key and merges it with the modern one', () => {
		const fm = { cssclasses: 'a', cssclass: ['b', 'c'] };
		expect(cssClassesFromFrontmatter(fm)).toEqual(['a', 'b', 'c']);
	});

	it('trims entries, drops empties and deduplicates', () => {
		const fm = { cssclasses: '  a ,  , b', cssclass: ['a', 'b '] };
		expect(cssClassesFromFrontmatter(fm)).toEqual(['a', 'b']);
	});
});
