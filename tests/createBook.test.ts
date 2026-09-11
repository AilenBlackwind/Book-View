import { describe, it, expect } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import {
	collectMarkdownFiles,
	buildManifestContent,
	manifestFilename,
} from '../src/components/CreateBook';

const md = (path: string): TFile => {
	const f = new TFile();
	(f as TFile & { path: string }).path = path;
	(f as TFile & { extension: string }).extension = 'md';
	return f;
};

const folder = (name: string): TFolder => {
	const f = new TFolder();
	(f as TFolder & { name: string }).name = name;
	(f as TFolder & { children: TFile[] | TFolder[] }).children = [];
	return f;
};

describe('collectMarkdownFiles', () => {
	it('collects markdown files recursively in missorted input order', () => {
		const sub = folder('sub');
		(sub as unknown as { children: (TFile | TFolder)[] }).children = [md('Root/sub/C.md')];
		const root = folder('Root');
		(root as unknown as { children: (TFile | TFolder)[] }).children = [
			md('Root/A.md'),
			sub,
			md('Root/B.md'),
		];
		// Order is preserved as walked (children order); sorting is left to
		// buildManifestContent.
		expect(collectMarkdownFiles(root).map((f) => f.path)).toEqual([
			'Root/A.md',
			'Root/sub/C.md',
			'Root/B.md',
		]);
	});

	it('ignores non-markdown files', () => {
		const png = new TFile();
		(png as TFile & { path: string }).path = 'Root/Image.png';
		(png as TFile & { extension: string }).extension = 'png';

		const root = folder('Root');
		(root as unknown as { children: (TFile | TFolder)[] }).children = [md('Root/A.md'), png];
		expect(collectMarkdownFiles(root).map((f) => f.path)).toEqual(['Root/A.md']);
	});
});

describe('buildManifestContent', () => {
	it('emits wikilinks in alphabetical order, natural, case-insensitive', () => {
		const files = [
			{ path: 'Root/note10.md' },
			{ path: 'Root/Note2.md' },
			{ path: 'Root/a.md' },
			{ path: 'Root/sub/B.md' },
		];
		const content = buildManifestContent('Root', files, 'Root/Root Book.md');
		expect(content).toBe([
			'---',
			'book-view: true',
			'---',
			'',
			'# Root',
			'',
			'[[Root/a]]',
			'[[Root/Note2]]',
			'[[Root/note10]]',
			'[[Root/sub/B]]',
			'',
		].join('\n'));
	});

	it('excludes the manifest itself', () => {
		const files = [{ path: 'Root/Root Book.md' }, { path: 'Root/A.md' }];
		const content = buildManifestContent('Root', files, 'Root/Root Book.md');
		expect(content).not.toContain('[[Root/Root Book]]');
		expect(content).toContain('[[Root/A]]');
	});
});

describe('manifestFilename', () => {
	it('is "<folder name> Book.md"', () => {
		expect(manifestFilename(folder('Проект'))).toBe('Проект Book.md');
	});
});