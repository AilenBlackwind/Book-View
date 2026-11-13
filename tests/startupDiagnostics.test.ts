/* eslint-disable @typescript-eslint/unbound-method -- These tests intentionally inspect and replace prototype methods to verify wrapper ownership and restoration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLeaf } from 'obsidian';
import type { ViewState } from 'obsidian';
import type BookViewPlugin from '../src/main';
import { StartupDiagnostics } from '../src/diagnostics/StartupDiagnostics';

const { restore } = vi.hoisted(() => ({ restore: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<object>(),
	apiVersion: 'test', normalizePath: (path: string) => path,
	WorkspaceLeaf: class {
		isDeferred = false;
		getViewState(): ViewState { return { type: 'markdown', state: { file: 'private-note.md' } }; }
		setViewState(...args: unknown[]): Promise<void> { return restore.apply(this, args); }
	},
}));

const cleanups: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
	vi.stubGlobal('document', { visibilityState: 'visible' });
	vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
	restore.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function setup(history: unknown = [], layoutReady = false) {
	const leaf = new WorkspaceLeaf();
	let saved = '';
	const adapter = {
		exists: vi.fn(() => Promise.resolve(true)),
		read: vi.fn(() => Promise.resolve(JSON.stringify(history))),
		write: vi.fn((_path: string, value: string) => { saved = value; return Promise.resolve(); }),
	};
	let layoutCallback = () => {};
	const workspace = {
		layoutReady, iterateAllLeaves: (visit: (leaf: WorkspaceLeaf) => void) => visit(leaf),
		on: vi.fn(), onLayoutReady: (callback: () => void) => { layoutCallback = callback; },
	};
	const plugin = {
		manifest: { id: 'Book-View', dir: 'config-test/plugins/Book-View', version: '1.0.0' },
		app: { workspace, vault: { configDir: 'config-test', adapter } },
		register: (cleanup: () => void) => cleanups.push(cleanup),
		registerEvent: vi.fn(), registerDomEvent: vi.fn(), registerInterval: vi.fn(),
	};
	const original = WorkspaceLeaf.prototype.setViewState;
	const diagnostics = new StartupDiagnostics(plugin as unknown as BookViewPlugin, 100);
	return { diagnostics, original, adapter, leaf, workspace, layoutReady: () => layoutCallback(), saved: () => JSON.parse(saved) as unknown[] };
}

describe('startup capture lifecycle', () => {
	it('keeps previous launches, limits history, and does not serialize tab file paths', async () => {
		const old = Array.from({ length: 25 }, (_, i) => ({ startedAt: `old-${i}`, entries: [] }));
		const state = setup(old);
		await state.leaf.setViewState({ type: 'book-view', state: { file: 'private-book.md' } });
		state.layoutReady();
		await state.diagnostics.copyReports();
		expect(state.saved()).toHaveLength(20);
		expect(state.saved()[0]).toEqual(old[6]);
		const copied = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0];
		expect(copied).toContain('setViewState book-view');
		expect(copied).not.toContain('private-book.md');
		expect(copied).not.toContain('private-note.md');
	});

	it('saves still-pending restores at a checkpoint and stops at 60 seconds', async () => {
		const state = setup();
		let resolve = () => {};
		restore.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
		const operation = state.leaf.setViewState({ type: 'book-view' });
		await vi.advanceTimersByTimeAsync(5000);
		expect(JSON.stringify(state.saved())).toContain('setViewState book-view');
		expect(JSON.stringify(state.saved())).toContain('pending');
		await vi.advanceTimersByTimeAsync(55000);
		expect(state.diagnostics.active).toBe(false);
		expect(WorkspaceLeaf.prototype.setViewState).toBe(state.original);
		resolve();
		await operation;
	});

	it('preserves receiver, arguments and rejection, and releases the wrapper on unload', async () => {
		const state = setup();
		const error = new Error('bad restore');
		restore.mockRejectedValueOnce(error);
		const requested: ViewState = { type: 'book-view' };
		await expect(state.leaf.setViewState(requested, { focus: true })).rejects.toBe(error);
		expect(restore).toHaveBeenCalledWith(requested, { focus: true });
		expect(restore.mock.contexts[0]).toBe(state.leaf);
		expect(state.diagnostics.report.entries.some((entry) => entry.event.startsWith('failed'))).toBe(true);
		cleanups.at(-1)?.();
		expect(WorkspaceLeaf.prototype.setViewState).toBe(state.original);
		expect(state.diagnostics.active).toBe(false);
	});

	it('keeps synchronous exceptions synchronous', () => {
		const state = setup();
		const error = new Error('sync restore failure');
		restore.mockImplementationOnce(() => { throw error; });
		expect(() => state.leaf.setViewState({ type: 'markdown' })).toThrow(error);
		expect(state.diagnostics.pending.size).toBe(0);
	});

	it('does not remove a wrapper installed by another plugin afterwards', async () => {
		const state = setup();
		const ours = WorkspaceLeaf.prototype.setViewState;
		const later: typeof ours = function (this: WorkspaceLeaf, ...args) { return ours.apply(this, args); };
		WorkspaceLeaf.prototype.setViewState = later;
		state.diagnostics.stop('disabled');
		expect(WorkspaceLeaf.prototype.setViewState).toBe(later);
		await state.leaf.setViewState({ type: 'markdown' });
		WorkspaceLeaf.prototype.setViewState = state.original;
	});

	it('marks plugin reloads and reports failed disk writes without failing restoration', async () => {
		const state = setup([], true);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.adapter.write.mockRejectedValue(new Error('disk denied'));
		await expect(state.leaf.setViewState({ type: 'markdown' })).resolves.toBeUndefined();
		await state.diagnostics.copyReports();
		expect(state.diagnostics.report.mode).toBe('plugin reload');
		expect(vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0]).toContain('disk denied');
		state.diagnostics.stop('test ended');
		await state.diagnostics.copyReports();
		warning.mockRestore();
	});
});
/* eslint-enable @typescript-eslint/unbound-method -- End of the intentional prototype inspection tests. */
