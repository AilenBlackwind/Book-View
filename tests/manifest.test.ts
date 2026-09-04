import { describe, it, expect } from 'vitest';
import { cssClassesFromFrontmatter, frontmatterEndOffset } from '../src/components/ManifestParser';
import { updateLinksInContent } from '../src/components/LinkUpdater';
import { parseCodeBlockLinks } from '../src/components/CodeBlockParser';

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
		const targets = parseCodeBlockLinks(content).map((l) => l.target);
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
		expect(parseCodeBlockLinks(content).map((l) => l.target)).toEqual(['A', 'B']);
	});

	it('records the source offset of each link for click-to-edit line mapping', () => {
		const inner = '[[A]]\n[[B|Alias]]\nplain line\n[C](/C.md)';
		const links = parseCodeBlockLinks(inner);
		expect(links.map((l) => l.offset)).toEqual([0, 6, 29]);
		const lineOf = (offset: number): number =>
			inner.slice(0, offset).split('\n').length - 1;
		expect(links.map((l) => lineOf(l.offset as number))).toEqual([0, 1, 3]);
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
