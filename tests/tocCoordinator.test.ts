import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TocCoordinator } from '../src/components/TocCoordinator';
import type BookViewPlugin from '../src/main';

vi.mock('../src/views/BookView', () => ({ BookView: class {}, VIEW_TYPE_BOOK_VIEW: 'book-view' }));
vi.mock('../src/views/BookTocView', () => ({ BookTocView: class {}, VIEW_TYPE_BOOK_TOC: 'book-toc-view' }));

function setup(failFirst = false) {
	const foreign = { setViewState: vi.fn(), detach: vi.fn(), view: {
		containerEl: { closest: () => ({}) },
	} };
	let open = false;
	const own = {
		view: {}, getViewState: () => ({ type: open ? 'book-toc-view' : 'empty' }),
		setViewState: vi.fn(() => { open = true; return Promise.resolve(); }),
		detach: vi.fn(() => { open = false; }),
	};
	const workspace = {
		getLeavesOfType: () => open ? [own] : [],
		getRightLeaf: vi.fn((split: boolean) => failFirst && !split ? null : own),
		iterateAllLeaves: vi.fn((visit: (leaf: typeof foreign) => void) => visit(foreign)),
		revealLeaf: vi.fn(() => Promise.resolve()), setActiveLeaf: vi.fn(),
	};
	const coordinator = new TocCoordinator({ app: { workspace } } as unknown as BookViewPlugin);
	return { coordinator, workspace, foreign, own };
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('ToC sidebar ownership', () => {
	it.each([false, true])('opens and closes only its own tab (fallback=%s)', async (fallback) => {
		const state = setup(fallback);
		await state.coordinator.open();
		expect(state.own.setViewState).toHaveBeenCalledWith({ type: 'book-toc-view' });
		expect(state.workspace.revealLeaf).toHaveBeenCalledWith(state.own);
		state.coordinator.toggle();
		expect(state.own.detach).toHaveBeenCalledOnce();
		expect(state.foreign.setViewState).not.toHaveBeenCalled();
		expect(state.foreign.detach).not.toHaveBeenCalled();
		expect(state.workspace.iterateAllLeaves).not.toHaveBeenCalled();
	});

	it('reveals an existing ToC without creating another tab', async () => {
		const state = setup();
		await state.coordinator.open();
		state.workspace.getRightLeaf.mockClear();
		state.own.setViewState.mockClear();
		await state.coordinator.open(true);
		expect(state.workspace.getRightLeaf).not.toHaveBeenCalled();
		expect(state.own.setViewState).not.toHaveBeenCalled();
		expect(state.workspace.setActiveLeaf).toHaveBeenCalledWith(state.own, { focus: true });
	});
});
