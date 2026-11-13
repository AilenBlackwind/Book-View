import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component, MarkdownRenderer, TFile } from 'obsidian';
import { SectionPool, type SectionData, type SectionPoolHost } from '../src/components/SectionPool';

vi.mock('obsidian', async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	class LifecycleComponent {
		loaded = false;
		children: LifecycleComponent[] = [];
		onload(): void {}
		onunload(): void {}
		load(): void {
			this.loaded = true;
			this.onload();
			for (const child of this.children) child.load();
		}
		unload(): void {
			for (const child of this.children) child.unload();
			this.onunload();
			this.loaded = false;
		}
		addChild<T extends LifecycleComponent>(child: T): T {
			this.children.push(child);
			if (this.loaded) child.load();
			return child;
		}
	}
	return { ...original, Component: LifecycleComponent, MarkdownRenderer: { render: vi.fn() } };
});

const renderMock = vi.spyOn(MarkdownRenderer, 'render');

class RenderedDom {
	controls = false;
	children: RenderedDom[] = [];
	empty(): void { this.children = []; }
	appendChild(child: RenderedDom): void { this.children.push(child); }
	querySelector(selector: string): RenderedDom | null {
		if (selector === '.markdown-rendered') return this.children[0] ?? null;
		return this.children.some(child => child.controls) ? this.children[0]! : null;
	}
	querySelectorAll(): never[] { return []; }
}

interface PoolHarness {
	loadSection(path: string): Promise<void>;
	unloadSection(path: string): void;
}

function harness(source: string) {
	const path = 'rating.md';
	const root = new RenderedDom();
	const data = {
		el: root, component: null, renderGen: 0, renderFailures: 0,
		firstType: 'text', lastType: 'text',
	} as unknown as SectionData;
	const cache = new Map<string, HTMLElement>();
	const host = {
		sections: new Map([[path, data]]),
		renderedDomCache: cache,
		rawContent: new Map([[path, source]]),
		app: { vault: { getFileByPath: () => new TFile() } },
		isDestroyed: () => false,
		dbg: vi.fn(),
		foldTagSection: vi.fn(),
		foldSectionNeedsFoldStub: () => false,
		getFoldMode: () => 'none',
		getOnSectionRendered: () => undefined,
	} as unknown as SectionPoolHost;
	// Skip observer construction; exercise the production mount/unmount paths.
	const pool = Object.assign(Object.create(SectionPool.prototype) as object, {
		host,
		sectionResizeObserver: { observe: vi.fn(), unobserve: vi.fn() },
		patchIconsWhenAttached: vi.fn(), applyTransform: vi.fn(),
		getFirstType: () => 'text', getLastType: () => 'text',
		flushMountStyle: vi.fn(), dbgRenderMs: 0,
		loadPingAt: new Map(),
	}) as unknown as PoolHarness;
	vi.stubGlobal('createDiv', () => new RenderedDom());
	return { pool, cache, path, data };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('book widget lifecycle', () => {
	it('loads a child widget and creates a working new instance after scrolling away and back', async () => {
		const { pool, path, cache } = harness('```rate-me\n{"Story": 8}\n```');
		const loaded = vi.fn();
		const unloaded = vi.fn();
		renderMock.mockImplementation((_app, _source, el, _path, owner) => {
			class Widget extends Component {
				onload(): void { loaded(); (el as unknown as RenderedDom).controls = true; }
				onunload(): void { unloaded(); }
			}
			owner.addChild(new Widget());
			return Promise.resolve();
		});
		await pool.loadSection(path);
		expect(loaded).toHaveBeenCalledTimes(1);
		pool.unloadSection(path);
		expect(unloaded).toHaveBeenCalledTimes(1);
		expect(cache.size).toBe(0);
		await pool.loadSection(path);
		expect(loaded).toHaveBeenCalledTimes(2);
		expect(renderMock).toHaveBeenCalledTimes(2);
	});

	it('keeps DOM caching for static text notes', async () => {
		const { pool, path, cache } = harness('Plain text');
		renderMock.mockResolvedValue(undefined);
		await pool.loadSection(path);
		pool.unloadSection(path);
		expect(cache.has(path)).toBe(true);
		await pool.loadSection(path);
		expect(renderMock).toHaveBeenCalledTimes(1);
	});

	it('does not cache a fenced widget whose renderer currently produces no controls', async () => {
		const { pool, path, cache } = harness('~~~custom-widget\nsettings\n~~~');
		renderMock.mockResolvedValue(undefined);
		await pool.loadSection(path);
		pool.unloadSection(path);
		expect(cache.size).toBe(0);
	});

	it('does not cache interactive widgets created outside code blocks', async () => {
		const { pool, path, cache } = harness('Text with a postprocessed widget');
		renderMock.mockImplementation((_app, _source, el) => {
			(el as unknown as RenderedDom).controls = true;
			return Promise.resolve();
		});
		await pool.loadSection(path);
		pool.unloadSection(path);
		expect(cache.size).toBe(0);
	});
});
