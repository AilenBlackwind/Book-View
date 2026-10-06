import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { BufferManager } from '../src/BufferManager';

// FNV-1a hash of "old" in buffers produced by user scripts.
const originalHash = 'bd2b9bd6';

function setup(atoms: Record<string, string>, sections: Record<string, string>, current: Record<string, string>) {
	const buffer = Object.assign(new TFile(), { path: '_BUFFER_test.md' });
	const files = new Map(Object.keys(current).map((path) => [path, Object.assign(new TFile(), { path, basename: path })]));
	const content = [
		'---', 'buffer_master: "Book.md"', 'atoms:',
		...Object.entries(atoms).map(([path, hash]) => `  "${path}": "${hash}"`), '---',
		...Object.entries(sections).map(([path, text]) => `<!-- atom:${path} -->\n${text}\n<!-- /atom -->`),
	].join('\n');
	const process = vi.fn((file: TFile, update: (text: string) => string) => {
		current[file.path] = update(current[file.path]!);
		return Promise.resolve(current[file.path]!);
	});
	const trashFile = vi.fn(() => Promise.resolve());
	const app = {
		vault: {
			getFileByPath: (path: string) => path === buffer.path ? buffer : files.get(path),
			read: () => Promise.resolve(content), process,
		},
		metadataCache: { getFileCache: () => null },
		fileManager: { trashFile },
	} as unknown as App;
	return { manager: new BufferManager(app), current, process, trashFile, buffer };
}

describe('applyBuffer', () => {
	it('keeps the buffer when every atom conflicts', async () => {
		const state = setup({ 'A.md': originalHash }, { 'A.md': 'edit' }, { 'A.md': 'external change' });
		await state.manager.applyBuffer(state.buffer.path);
		expect(state.current['A.md']).toBe('external change');
		expect(state.trashFile).not.toHaveBeenCalled();
	});

	it('keeps partial changes and permits a safe retry of already-applied atoms', async () => {
		const state = setup({ 'A.md': originalHash, 'B.md': originalHash },
			{ 'A.md': 'edit A', 'B.md': 'edit B' }, { 'A.md': 'old', 'B.md': 'external change' });
		await state.manager.applyBuffer(state.buffer.path);
		expect(state.current).toEqual({ 'A.md': 'edit A', 'B.md': 'external change' });
		expect(state.trashFile).not.toHaveBeenCalled();
		state.current['B.md'] = 'old';
		await state.manager.applyBuffer(state.buffer.path);
		expect(state.current).toEqual({ 'A.md': 'edit A', 'B.md': 'edit B' });
		expect(state.trashFile).toHaveBeenCalledExactlyOnceWith(state.buffer);
	});

	it('keeps the buffer when an atom is missing', async () => {
		const state = setup({ 'Missing.md': originalHash }, { 'Missing.md': 'edit' }, {});
		await state.manager.applyBuffer(state.buffer.path);
		expect(state.trashFile).not.toHaveBeenCalled();
	});

	it('keeps the buffer when a section is missing', async () => {
		const state = setup({ 'A.md': originalHash }, {}, { 'A.md': 'old' });
		await state.manager.applyBuffer(state.buffer.path);
		expect(state.current['A.md']).toBe('old');
		expect(state.trashFile).not.toHaveBeenCalled();
	});

	it('keeps the buffer if writing fails', async () => {
		const state = setup({ 'A.md': originalHash }, { 'A.md': 'edit' }, { 'A.md': 'old' });
		state.process.mockRejectedValueOnce(new Error('Disk full'));
		await expect(state.manager.applyBuffer(state.buffer.path)).rejects.toThrow('Disk full');
		expect(state.trashFile).not.toHaveBeenCalled();
	});
});
