import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { collectManuscript } from '../src/components/CollectManuscript';
import { getManifestFiles } from '../src/components/ManifestParser';

vi.mock('../src/components/ManifestParser', () => ({ getManifestFiles: vi.fn() }));

describe('collectManuscript', () => {
	it.each(['Books/One', 'Books/Two', ''])('saves beside the source book in %s without overwriting exports', async (folder) => {
		const prefix = folder ? `${folder}/` : '';
		const manifest = Object.assign(new TFile(), { basename: 'Book', parent: { path: folder } });
		const atom = new TFile();
		vi.mocked(getManifestFiles).mockResolvedValueOnce([atom]);
		const create = vi.fn((path: string, content: string) => Promise.resolve(Object.assign(new TFile(), { path, content })));
		const modify = vi.fn();
		const app = {
			vault: {
				cachedRead: () => Promise.resolve('---\ntitle: Chapter\n---\n\nChapter text\n'),
				getAbstractFileByPath: (path: string) => path === `${prefix}Book — Manuscript.md` ? new TFile() : null,
				create, modify,
			},
		} as unknown as App;
		await collectManuscript(app, manifest);
		expect(create).toHaveBeenCalledWith(`${prefix}Book — Manuscript (2).md`, 'Chapter text');
		expect(modify).not.toHaveBeenCalled();
	});
});
