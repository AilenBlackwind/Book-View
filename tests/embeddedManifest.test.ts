import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, resolveSubpath, TFile } from 'obsidian';
import { getManifestFiles, getManifestLinks } from '../src/components/ManifestParser';
import { collectManifestLinks, type ChapterListSource } from '../src/components/EmbeddedManifest';

vi.mock('obsidian', async (original) => ({ ...await original<object>(), resolveSubpath: vi.fn() }));

function setup(notes: Record<string, string>) {
	const files = new Map(Object.entries(notes).map(([path, text]) => [path,
		Object.assign(new TFile(), { path, extension: path.split('.').pop(), stat: { size: text.length } }),
	]));
	const resolve = vi.fn((target: string, from: string) => {
		const path = target.endsWith('.md') || target.endsWith('.png') ? target : `${target}.md`;
		if (target.startsWith('.')) {
			return files.get(new URL(path, `https://vault/${from}`).pathname.slice(1));
		}
		return files.get(path);
	});
	const read = vi.fn((file: TFile) => Promise.resolve(notes[file.path]!));
	const app = {
		vault: { cachedRead: read, getFileByPath: (path: string) => files.get(path) },
		metadataCache: {
			getFirstLinkpathDest: resolve,
			getFileCache: (file: TFile) => {
				const entries = [...(notes[file.path] ?? '').matchAll(/(!?)\[\[([^\]]+)\]\]/g)].map((m) => ({
					embed: !!m[1], link: m[2]!.split('|')[0]!, original: m[0],
					position: { start: { offset: m.index } },
				}));
				return { links: entries.filter((e) => !e.embed), embeds: entries.filter((e) => e.embed) };
			},
		},
	} as unknown as App;
	return { app, files, read, resolve, paths: async (book = 'Book.md') =>
		(await getManifestFiles(app, files.get(book)!)).map((f) => f.path) };
}

beforeEach(() => vi.mocked(resolveSubpath).mockReset());

describe('embedded chapter lists', () => {
	it('reports writable source ranges for direct and embedded blocks, including empty lists', async () => {
		const notes = {
			'Book.md': '![[Shared]]\r\n\r\n```book-view\r\n[[]]\r\n```',
			'Shared.md': '# Contents\n~~~book-view\n~~~\n',
		};
		const state = setup(notes);
		const lists: ChapterListSource[] = [];
		await collectManifestLinks(state.app, state.files.get('Book.md')!, undefined, undefined, (list) => lists.push(list));
		expect(lists.map(({ file, raw, from, to }) => [file.path, raw.slice(from, to)])).toEqual([
			['Shared.md', ''],
			['Book.md', '[[]]\r\n'],
		]);
	});
	it('inserts shared chapters at the embed position without rendering the list note', async () => {
		const state = setup({ 'Book.md': '[[Before]]\n![[Shared|List]]\n[[After]]',
			'Shared.md': '[[B]]\n[[A]]', 'Before.md': 'before', 'After.md': 'after', 'A.md': 'a', 'B.md': 'b' });
		expect(await state.paths()).toEqual(['Before.md', 'B.md', 'A.md', 'After.md']);
	});

	it('resolves relative targets from each embedded note, including nested lists', async () => {
		const state = setup({ 'Book.md': '![[Lists/Shared]]', 'Lists/Shared.md': '![[./Nested]]',
			'Lists/Nested.md': '[[../Chapters/A]]', 'Chapters/A.md': 'chapter' });
		expect(await state.paths()).toEqual(['Chapters/A.md']);
		expect(state.resolve).toHaveBeenCalledWith('../Chapters/A', 'Lists/Nested.md');
	});

	it('deduplicates direct and embedded chapters, and reads repeated lists once', async () => {
		const state = setup({ 'Book.md': '[[A]]\n![[Shared]]\n![[Shared]]\n[[B]]',
			'Shared.md': '[[A]]\n[[B]]', 'A.md': 'a', 'B.md': 'b' });
		expect(await state.paths()).toEqual(['A.md', 'B.md']);
		expect(state.read.mock.calls.map(([file]) => file.path)).toEqual(['Book.md', 'Shared.md']);
	});

	it('terminates cycles through the master and through nested lists', async () => {
		const state = setup({ 'Book.md': '![[Shared]]', 'Shared.md': '![[Nested]]\n[[A]]',
			'Nested.md': '![[Book]]\n![[Shared]]\n[[B]]', 'A.md': 'a', 'B.md': 'b' });
		expect(await state.paths()).toEqual(['B.md', 'A.md']);
	});

	it('does not follow the links in ordinary chapter notes', async () => {
		const state = setup({ 'Book.md': '![[Shared]]', 'Shared.md': '[[A]]',
			'A.md': '[[B]]\n![[Other]]', 'B.md': 'b', 'Other.md': '[[B]]' });
		expect(await state.paths()).toEqual(['A.md']);
	});

	it('tracks empty sources and re-reads the shared list independently for each book', async () => {
		const notes = { 'Book.md': '![[Shared]]', 'Other book.md': '![[Shared]]', 'Shared.md': '', 'A.md': 'a' };
		const state = setup(notes);
		const sources = new Set<string>();
		expect(await getManifestLinks(state.app, state.files.get('Book.md')!, undefined, sources)).toEqual([]);
		expect([...sources]).toEqual(['Book.md', 'Shared.md']);
		notes['Shared.md'] = '[[A]]';
		expect(await state.paths()).toEqual(['A.md']);
		expect(await state.paths('Other book.md')).toEqual(['A.md']);
	});

	it('keeps broken/empty chapter warnings and ignores image embeds', async () => {
		const state = setup({ 'Book.md': '![[Shared]]\n![[picture.png]]\n![[Missing]]',
			'Shared.md': '[[Empty]]\n[[Gone]]', 'Empty.md': '', 'picture.png': 'image' });
		expect(await getManifestLinks(state.app, state.files.get('Book.md')!)).toEqual([
			{ type: 'empty', file: state.files.get('Empty.md') },
			{ type: 'broken', display: '[[Gone]]' },
			{ type: 'broken', display: '![[Missing]]' },
		]);
	});

	it('ignores embedded frontmatter links and supports book-view blocks in shared lists', async () => {
		const state = setup({ 'Book.md': '![[Shared]]',
			'Shared.md': '---\nlist: "![[Ignored]]"\n---\n```book-view\n[[A]]\n```',
			'Ignored.md': '[[B]]', 'A.md': 'a', 'B.md': 'b' });
		// Obsidian excludes fenced links from cache.links.
		const original = state.app.metadataCache.getFileCache.bind(state.app.metadataCache);
		state.app.metadataCache.getFileCache = (file) => file.path === 'Shared.md'
			? { embeds: original(file)?.embeds } : original(file);
		expect(await state.paths()).toEqual(['A.md']);
	});

	it.each(['#Selected', '#^list'])('limits %s embeds to the native Obsidian subpath range', async (subpath) => {
		const source = '[[Before]]\n[[A]]\n[[After]]';
		vi.mocked(resolveSubpath).mockReturnValue({ start: { offset: source.indexOf('[[A]]'), line: 1, col: 0 },
			end: { offset: source.indexOf('[[After]]'), line: 2, col: 0 } } as ReturnType<typeof resolveSubpath>);
		const state = setup({ 'Book.md': `![[Shared${subpath}]]`, 'Shared.md': source,
			'Before.md': 'before', 'A.md': 'a', 'After.md': 'after' });
		expect(await state.paths()).toEqual(['A.md']);
		expect(resolveSubpath).toHaveBeenCalledWith(expect.anything(), subpath);
	});
});
