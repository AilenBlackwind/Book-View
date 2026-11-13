import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { BookView } from '../src/views/BookView';
import { BookTocView } from '../src/views/BookTocView';
import { collectActiveManuscript } from '../src/commands/collectManuscript';
import { collectManuscript } from '../src/components/CollectManuscript';

vi.mock('../src/views/BookView', () => ({ BookView: class {} }));
vi.mock('../src/views/BookTocView', () => ({ BookTocView: class {} }));
vi.mock('../src/components/CollectManuscript', () => ({ collectManuscript: vi.fn() }));

describe('manuscript command', () => {
	it.each(['book', 'toc'])('exports the right book with focus on %s and opens the result', async (focus) => {
		const book = { filePath: 'Books/Manifest.md' };
		const manifest = new TFile();
		const output = new TFile();
		const openFile = vi.fn(() => Promise.resolve());
		const app = {
			workspace: {
				getActiveViewOfType: (type: unknown) => {
					if (type === BookView && focus === 'book') return book;
					if (type === BookTocView && focus === 'toc') return { getBoundBook: () => book };
					return null;
				},
				getLeaf: () => ({ openFile }),
			},
			vault: { getFileByPath: (path: string) => path === book.filePath ? manifest : null },
		} as unknown as App;
		vi.mocked(collectManuscript).mockResolvedValueOnce(output);
		await collectActiveManuscript(app);
		expect(collectManuscript).toHaveBeenLastCalledWith(app, manifest);
		expect(openFile).toHaveBeenCalledWith(output);
	});
});
