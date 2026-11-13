import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { BookView } from '../src/views/BookView';
import type { SearchHit } from '../src/search/matcher';

vi.mock('obsidian', async (importOriginal) => ({ ...await importOriginal<object>(), FileView: class {} }));
vi.mock('../src/components/AbsoluteSectionManager', () => ({ AbsoluteSectionManager: class {} }));
vi.mock('../src/components/WheelAccelerator', () => ({ WheelAccelerator: class {} }));
vi.mock('../src/editor/NativeLeafPopover', () => ({ NativeLeafPopover: class {} }));
vi.mock('../src/ui/ContextMenu', () => ({ showScriptMenu: vi.fn() }));

interface SearchView {
	runFind(query: string, refresh?: boolean): Promise<void>;
	scheduleRefresh(path: string): void;
	closeFindBar(): void;
	findMatches: SearchHit[];
	findIndex: number;
	findAllActive: boolean;
}

function setup(initial = 'target target') {
	let content = initial;
	let open = true;
	const file = Object.assign(new TFile(), { path: 'Chapter.md' });
	const count = vi.fn();
	const navigate = vi.fn(() => Promise.resolve());
	const highlightAll = vi.fn();
	const read = vi.fn(() => Promise.resolve(content));
	const view = Object.assign(Object.create(BookView.prototype) as SearchView, {
		app: { vault: { cachedRead: read } }, currentFiles: [file],
		absoluteManager: { getRawContent: () => initial, markDirty: vi.fn() },
		findBar: { isOpen: () => open, getQuery: () => 'target', setCount: count,
			setFindAllActive: vi.fn(), hide: () => { open = false; } },
		findMatches: [], findIndex: -1, findQuery: '', findRequestId: 0,
		findDebounce: 0, findAllActive: false, refreshTimers: new Map(),
		clearFindMarks: vi.fn(), gotoFindMatch: navigate, highlightAll,
	});
	return { view, count, navigate, highlightAll, read, edit: (text: string) => { content = text; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('live book search', () => {
	it('removes deleted words and updates navigation without retyping the query', async () => {
		const state = setup();
		await state.view.runFind('target');
		expect(state.view.findMatches).toHaveLength(2);
		state.navigate.mockClear();
		state.view.findIndex = 1;
		state.edit('target');
		state.view.scheduleRefresh('Chapter.md');
		await vi.advanceTimersByTimeAsync(450);
		expect(state.view.findMatches).toHaveLength(1);
		expect(state.view.findIndex).toBe(0);
		expect(state.count).toHaveBeenLastCalledWith(1, 1);
		expect(state.navigate).not.toHaveBeenCalled();
		state.edit('word removed');
		state.view.scheduleRefresh('Chapter.md');
		await vi.advanceTimersByTimeAsync(450);
		expect(state.view.findMatches).toEqual([]);
		expect(state.view.findIndex).toBe(-1);
		expect(state.count).toHaveBeenLastCalledWith(0, 0);
	});

	it('preserves find-all mode and counts newly added matches', async () => {
		const state = setup('target');
		await state.view.runFind('target');
		state.view.findAllActive = true;
		state.edit('target target target');
		state.view.scheduleRefresh('Chapter.md');
		await vi.advanceTimersByTimeAsync(450);
		expect(state.view.findMatches).toHaveLength(3);
		expect(state.view.findAllActive).toBe(true);
		expect(state.highlightAll).toHaveBeenCalledWith('target');
	});

	it('does not restore stale asynchronous results after the find bar closes', async () => {
		const state = setup();
		let resolveRead: (text: string) => void = () => {};
		state.read.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRead = resolve; }));
		const pending = state.view.runFind('target', true);
		state.view.closeFindBar();
		resolveRead('target');
		await pending;
		expect(state.view.findMatches).toEqual([]);
	});
});
