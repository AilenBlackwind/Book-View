import { describe, expect, it, vi } from 'vitest';
import { type App, TFile } from 'obsidian';
import { buildTocEntries } from '../src/toc/entries';
import { readTocSection } from '../src/toc/section';

function book(notes: { text: string; headings: [number, number, string][] }[]) {
	const files = notes.map((_, i) => Object.assign(new TFile(), { path: `${i}.md` }));
	const cachedRead = vi.fn((file: TFile) => Promise.resolve(notes[files.indexOf(file)]!.text));
	const app = {
		vault: { cachedRead },
		metadataCache: {
			getFileCache: (file: TFile) => ({
				headings: notes[files.indexOf(file)]!.headings.map(([line, level, heading]) => ({
					position: { start: { line } }, level, heading,
				})),
			}),
		},
	} as unknown as App;
	return { app, files, entries: buildTocEntries(app, files), cachedRead };
}

describe('readTocSection', () => {
	it('includes the heading and nested sections, stopping before its sibling', async () => {
		const b = book([{
			text: 'Intro\n## Part\nText\n### Child\nChild text\n\n## Next\nOther',
			headings: [[1, 2, 'Part'], [3, 3, 'Child'], [6, 2, 'Next']],
		}]);
		expect(await readTocSection(b.app, b.files, b.entries[0]!))
			.toBe('## Part\nText\n### Child\nChild text');
	});

	it('stops at a higher-level heading even without a same-level sibling', async () => {
		const b = book([{
			text: '### Part\nText\n# Next\nOther',
			headings: [[0, 3, 'Part'], [2, 1, 'Next']],
		}]);
		expect(await readTocSection(b.app, b.files, b.entries[0]!)).toBe('### Part\nText');
	});

	it('copies across notes without headings, strips properties, and stops within the boundary note', async () => {
		const b = book([
			{ text: '---\ntitle: Source\n---\n# Chapter\nStart\n', headings: [[3, 1, 'Chapter']] },
			{ text: '---\nsecret: metadata\n---\n\nContinuation\n', headings: [] },
			{ text: '## Child\nNested\n# Next\nOther', headings: [[0, 2, 'Child'], [2, 1, 'Next']] },
			{ text: '# Unrelated', headings: [[0, 1, 'Unrelated']] },
		]);
		expect(await readTocSection(b.app, b.files, b.entries[0]!))
			.toBe('# Chapter\nStart\n\nContinuation\n\n## Child\nNested');
		expect(b.cachedRead.mock.calls.map(([file]) => file.path)).toEqual(['0.md', '1.md', '2.md']);
	});

	it('copies to the end of the book and preserves hard breaks and CRLF', async () => {
		const b = book([
			{ text: '# Last\r\nLine  \r\nText\r\n', headings: [[0, 1, 'Last']] },
			{ text: 'Ending  ', headings: [] },
		]);
		expect(await readTocSection(b.app, b.files, b.entries[0]!))
			.toBe('# Last\r\nLine  \r\nText\n\nEnding  ');
	});

	it('uses parsed headings so fences do not end sections and setext headings are included', async () => {
		const b = book([{
			text: 'Part\n----\n```md\n## Not a heading\n```\n## Next\nOther',
			headings: [[0, 2, 'Part'], [5, 2, 'Next']],
		}]);
		expect(await readTocSection(b.app, b.files, b.entries[0]!))
			.toBe('Part\n----\n```md\n## Not a heading\n```');
	});

	it('distinguishes repeated heading names by position', async () => {
		const b = book([{
			text: '## Same\nFirst\n## Same\nSecond',
			headings: [[0, 2, 'Same'], [2, 2, 'Same']],
		}]);
		expect(await readTocSection(b.app, b.files, b.entries[1]!)).toBe('## Same\nSecond');
	});

	it('does not read the next note when its first line is the boundary', async () => {
		const b = book([
			{ text: '# One\nText', headings: [[0, 1, 'One']] },
			{ text: '# Two\nOther', headings: [[0, 1, 'Two']] },
		]);
		expect(await readTocSection(b.app, b.files, b.entries[0]!)).toBe('# One\nText');
		expect(b.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('rejects a stale menu selection before reading or copying', async () => {
		const b = book([{ text: '# New\nText', headings: [[0, 1, 'New']] }]);
		await expect(readTocSection(b.app, b.files, { ...b.entries[0]!, text: 'Old' }))
			.rejects.toThrow('The heading changed');
		expect(b.cachedRead).not.toHaveBeenCalled();
	});
});
