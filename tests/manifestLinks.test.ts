import { describe, expect, it } from 'vitest';
import { App, TFile } from 'obsidian';
import { getManifestLinks } from '../src/components/ManifestParser';
import { parseBookViewBlocks } from '../src/components/CodeBlockParser';

describe('manifest link boundaries', () => {
	it('combines body links with book-view links and deduplicates notes', async () => {
		const source = '[[Body]]\n```book-view\n[[Body]]\n[[Chapter]]\n```';
		const files = new Map(['Body', 'Chapter'].map((name) => [name,
			Object.assign(new TFile(), { path: `${name}.md`, extension: 'md', stat: { size: 10 } })]));
		const app = {
			vault: { getFileByPath: (path: string) => files.get(path.replace(/\.md$/, '')) },
			metadataCache: {
				getFileCache: () => ({ links: [{ link: 'Body', original: '[[Body]]', position: { start: { offset: 0 } } }] }),
				getFirstLinkpathDest: (target: string) => files.get(target),
			},
		} as unknown as App;
		expect(await getManifestLinks(app, new TFile(), source)).toEqual([
			{ type: 'file', file: files.get('Body') }, { type: 'file', file: files.get('Chapter') },
		]);
	});
	it.each(['\n', '\r\n'])('ignores properties and ordinary code blocks without a book-view block (%j)', async (newline) => {
		const source = ['---', 'book-view: true', 'chapters: ["[[Metadata]]"]', '---',
			'[[Chapter]]', '```js', '[[Example]]', '```'].join(newline);
		const chapter = Object.assign(new TFile(), { path: 'Chapter.md', extension: 'md', stat: { size: 10 } });
		const app = {
			vault: { getFileByPath: () => chapter },
			metadataCache: {
				getFileCache: () => ({ links: ['Metadata', 'Chapter'].map((link) => ({
					link, original: `[[${link}]]`, position: { start: { offset: source.indexOf(`[[${link}]]`) } },
				})) }),
				getFirstLinkpathDest: () => chapter,
			},
		} as unknown as App;
		const master = Object.assign(new TFile(), { path: 'Book.md' });
		expect(await getManifestLinks(app, master, source)).toEqual([{ type: 'file', file: chapter }]);
		expect(parseBookViewBlocks(source)).toEqual([]);
	});

	it('does not render a property-only manifest as a book chapter', async () => {
		const source = '---\nbook-view: true\nchapters: ["[[Metadata]]"]\n---\n';
		const app = { metadataCache: { getFileCache: () => ({ links: [] }) } } as unknown as App;
		expect(await getManifestLinks(app, new TFile(), source)).toEqual([]);
	});

	it('ignores book-view fence examples inside another fenced block', () => {
		const source = '````markdown\n```book-view\n[[Example]]\n```\n````\n```book-view\n[[Chapter]]\n```';
		expect(parseBookViewBlocks(source).map((link) => link.target)).toEqual(['Chapter']);
	});

	it('supports multiple blocks, tilde fences, trailing spaces and an unclosed final block', () => {
		const source = '~~~book-view  \n[[A]]\n~~~\n[[Ignored]]\n```book-view\n[[B]]';
		expect(parseBookViewBlocks(source).map((link) => link.target)).toEqual(['A', 'B']);
	});

	it('excludes a fence-looking YAML value before scanning book blocks', async () => {
		const source = '---\nexample: |\n  ```book-view\n  [[Metadata]]\n  ```\n---\n';
		const app = { metadataCache: { getFileCache: () => ({ links: [] }) } } as unknown as App;
		expect(await getManifestLinks(app, new TFile(), source)).toEqual([]);
	});
});
