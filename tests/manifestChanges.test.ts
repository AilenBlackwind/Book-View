import { describe, expect, it, vi } from 'vitest';
import { Component, TFile } from 'obsidian';
import { BookView } from '../src/views/BookView';

vi.mock('obsidian', async (original) => ({ ...await original<object>(), FileView: class {} }));
vi.mock('../src/components/AbsoluteSectionManager', () => ({ AbsoluteSectionManager: class {} }));
vi.mock('../src/components/WheelAccelerator', () => ({ WheelAccelerator: class {} }));
vi.mock('../src/editor/NativeLeafPopover', () => ({ NativeLeafPopover: class {} }));
vi.mock('../src/ui/ContextMenu', () => ({ showScriptMenu: vi.fn() }));

type Handler = (file: TFile, oldPath?: string) => void;
interface WatchedView { watchManifestChanges(component: Component): void }

function setup() {
	const handlers = new Map<string, Handler[]>();
	function events(prefix: string) {
		return { on: (event: string, callback: Handler) => {
			const name = `${prefix}:${event}`;
			handlers.set(name, [...(handlers.get(name) ?? []), callback]);
			return { name, callback };
		} };
	}
	const app = { vault: events('vault'), metadataCache: events('metadata') };
	function watch(chapters = ['Chapter.md'], emptyChapters: string[] = []) {
		const reload = vi.fn();
		const refresh = vi.fn();
		const toc = vi.fn();
		const refs: { name: string; callback: Handler }[] = [];
		const view = Object.assign(Object.create(BookView.prototype) as WatchedView, {
			app, manifestSources: new Set(['Book.md', 'Shared.md', 'Nested.md']),
			manifestPaths: new Set(chapters), scheduleReload: reload, scheduleRefresh: refresh,
			emptyChapterPaths: new Set(emptyChapters),
			haveHeadingsChanged: () => true, plugin: { tocCoordinator: { scheduleRefresh: toc } },
		});
		view.watchManifestChanges({ registerEvent: (ref: typeof refs[number]) => refs.push(ref) } as unknown as Component);
		return { reload, refresh, toc, unload: () => {
			for (const ref of refs) handlers.set(ref.name, handlers.get(ref.name)!.filter((cb) => cb !== ref.callback));
		} };
	}
	return { watch, emit: (event: string, path: string, oldPath?: string, size = 1) => {
		const file = Object.assign(new TFile(), { path, stat: { size } });
		for (const handler of handlers.get(event) ?? []) handler(file, oldPath);
	} };
}

describe('shared list changes in open books', () => {
	it('reloads every dependent book when nested lists change, including empty books', () => {
		const state = setup();
		const first = state.watch();
		const second = state.watch([]);
		state.emit('vault:modify', 'Nested.md');
		state.emit('metadata:changed', 'Shared.md');
		expect(first.reload).toHaveBeenCalledTimes(2);
		expect(second.reload).toHaveBeenCalledTimes(2);
		first.unload();
		state.emit('vault:modify', 'Shared.md');
		expect(first.reload).toHaveBeenCalledTimes(2);
		expect(second.reload).toHaveBeenCalledTimes(3);
	});

	it('refreshes chapter content and headings without reloading the entire book', () => {
		const state = setup();
		const book = state.watch();
		state.emit('vault:modify', 'Chapter.md');
		state.emit('metadata:changed', 'Chapter.md');
		state.emit('vault:modify', 'Unrelated.md');
		expect(book.refresh).toHaveBeenCalledExactlyOnceWith('Chapter.md');
		expect(book.toc).toHaveBeenCalledOnce();
		expect(book.reload).not.toHaveBeenCalled();
	});

	it('reloads after source renames/deletions and follows the renamed source', () => {
		const state = setup();
		const book = state.watch();
		state.emit('vault:rename', 'Moved.md', 'Shared.md');
		state.emit('metadata:changed', 'Moved.md');
		state.emit('vault:delete', 'Nested.md');
		expect(book.reload).toHaveBeenCalledTimes(3);
	});

	it('rebuilds the book when a chapter crosses the empty-note boundary', () => {
		const state = setup();
		const book = state.watch(['Chapter.md'], ['Draft.md']);
		state.emit('vault:modify', 'Draft.md', undefined, 0);
		expect(book.reload).not.toHaveBeenCalled();
		state.emit('vault:modify', 'Draft.md');
		state.emit('vault:modify', 'Chapter.md', undefined, 0);
		expect(book.reload).toHaveBeenCalledTimes(2);
		expect(book.refresh).not.toHaveBeenCalled();
	});
});
