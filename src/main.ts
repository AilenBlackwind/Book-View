import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { ThemeSpacings, measureThemeSpacings } from './utils/theme';
import { BookView, VIEW_TYPE_BOOK_VIEW } from './views/BookView';
import { BookTocView, VIEW_TYPE_BOOK_TOC } from './views/BookTocView';
import { TocCoordinator } from './components/TocCoordinator';
import { getManifestFiles, isBookManifest } from './components/ManifestParser';
import { WheelAccelerator } from './components/WheelAccelerator';
import { BookViewSettings, DEFAULT_SETTINGS } from './settings';
import { BookViewSettingTab } from './ui/SettingsTab';
import { BufferManager } from './BufferManager';
import { BookViewAPI } from './BookViewAPI';
import { DebugLog } from './utils/debug';
import { ensureGlobalFrameProbe } from './components/AbsoluteSectionManager';

export default class BookViewPlugin extends Plugin {
	settings: BookViewSettings = DEFAULT_SETTINGS;
	bufferManager: BufferManager = null as unknown as BufferManager;
	api: BookViewAPI | null = null;
	private skipPaths = new Set<string>();
	heightStore: Record<string, { m: number; h: number; w: number }> = {};
	themeSpacings: ThemeSpacings = { h1TopGap: 52, h2TopGap: 34, headerToHeaderGap: 0, textGap: 16 };
	tocCoordinator: TocCoordinator | null = null;
	private saveHeightsTimer = 0;

	getPersistedHeight = (path: string, mtime: number, width: number): number | undefined => {
		const rec = this.heightStore[path];
		// Legacy entries (w === -1) predate width-keying: their height was
		// measured at some width, which is closer to reality than an estimate.
		return rec && rec.m === mtime && (rec.w === -1 || Math.abs(rec.w - width) <= 2) ? rec.h : undefined;
	};

	persistHeight = (path: string, mtime: number, width: number, height: number): void => {
		const rec = this.heightStore[path];
		if (rec && rec.m === mtime && rec.w === width && Math.abs(rec.h - height) < 1) return;
		this.heightStore[path] = { m: mtime, h: height, w: width };
		const keys = Object.keys(this.heightStore);
		if (keys.length > 1000) {
			const oldest = keys[0];
			if (oldest) delete this.heightStore[oldest];
		}
		window.clearTimeout(this.saveHeightsTimer);
		this.saveHeightsTimer = window.setTimeout(() => {
			void this.saveData(Object.assign({}, this.settings, { measuredHeights: this.heightStore }));
		}, 2000);
	};

	async onload() {
		await this.loadSettings();

		this.themeSpacings = await measureThemeSpacings(this.app);
		this.registerEvent(
			this.app.workspace.on('css-change', async () => {
				this.themeSpacings = await measureThemeSpacings(this.app);
				this.recalculateBookLayouts();
			}),
		);

		this.bufferManager = new BufferManager(this.app);
		this.api = new BookViewAPI(
			this.app,
			() => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOK_VIEW);
				for (const leaf of leaves) {
					if (leaf.view instanceof BookView && leaf.view.filePath) {
						return leaf.view;
					}
				}
				return null;
			},
		);
		window.BookView = this.api;
		this.tocCoordinator = new TocCoordinator(this);
		this.addSettingTab(new BookViewSettingTab(this.app, this));

		// Register the wheel interceptor as early as possible: among capture-phase
		// listeners, registration order decides who may stopImmediatePropagation whom.
		this.registerDomEvent(window, 'wheel', (evt) => WheelAccelerator.dispatchWheel(evt), {
			capture: true,
			passive: false,
		});

		this.registerView(VIEW_TYPE_BOOK_VIEW, (leaf) => {
			const view = new BookView(leaf);
			view.plugin = this;
			return view;
		});

		this.registerView(VIEW_TYPE_BOOK_TOC, (leaf) => {
			return new BookTocView(leaf);
		});

		this.addCommand({
			id: 'toggle-sidebar-toc',
			name: 'Toggle book toc in right sidebar',
			callback: () => {
				this.tocCoordinator?.toggle();
			},
		});

		this.addCommand({
			id: 'toggle-view',
			name: 'Toggle view',
			callback: () => {
				const activeLeaf = this.getActiveBookLeaf();
				if (activeLeaf) {
					const bv = activeLeaf.view as BookView;
					void this.disableBookView(bv.filePath, activeLeaf);
					return;
				}

				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView?.file) {
					void this.enableBookView(activeView.file, activeView.leaf);
				}
			},
		});

		this.addCommand({
			id: 'apply-buffer',
			name: 'Apply buffer changes',
			callback: () => {
				const activeView = this.app.workspace.getActiveViewOfType(BookView);
				if (activeView) {
					void this.bufferManager.applyAnyBuffer((paths) => {
						activeView.refreshAppliedAtoms(paths);
					});
				} else {
					void this.bufferManager.applyAnyBuffer();
				}
			},
		});

		this.addCommand({
			id: 'collect-manuscript',
			name: 'Collect manuscript from linked notes',
			callback: () => {
				void this.collectManuscript();
			},
		});

		this.addCommand({
			id: 'search-book',
			name: 'Find in book',
			callback: () => {
				this.app.workspace.getActiveViewOfType(BookView)?.showFindBar();
			},
		});

		// Ctrl/Cmd+F for the book view. The primary binding is the view's
		// `scope` (registered in BookView), which runs through Obsidian's own
		// hotkey pipeline even when a bound hotkey normally swallows DOM
		// keydown events. This capture-phase listener is a layout-independent
		// fallback (physical `KeyF`) for scopes that do not match on
		// non-Latin keyboard layouts.
		this.registerDomEvent(window, 'keydown', (evt) => {
			if (!(evt.ctrlKey || evt.metaKey) || evt.code !== 'KeyF' || evt.shiftKey || evt.altKey) return;
			const target = evt.target as HTMLElement | null;
			if (!target) return;
			const bv = this.app.workspace.getActiveViewOfType(BookView);
			if (!bv) return;
			if (target.closest('.book-find-bar')) {
				evt.preventDefault();
				evt.stopImmediatePropagation();
				bv.showFindBar();
				return;
			}
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
			if (!target.closest('.book-view-root')) return;
			evt.preventDefault();
			evt.stopImmediatePropagation();
			bv.showFindBar();
		}, { capture: true });

		this.addCommand({
			id: 'toggle-debug-logging',
			name: 'Toggle debug logging',
			callback: () => {
				const on = DebugLog.toggle();
				if (on) ensureGlobalFrameProbe();
				new Notice(on ? 'Book View: debug logging on' : 'Book View: debug logging off');
			},
		});

		this.addCommand({
			id: 'copy-debug-log',
			name: 'Copy debug log to clipboard',
			callback: async () => {
				const w = window as unknown as { __bvLog?: string[] };
				const text = (w.__bvLog ?? []).join('\n');
				await navigator.clipboard.writeText(text);
				new Notice(`Book View: ${text.split('\n').length} log lines copied`);
			},
		});
		DebugLog.onChange((enabled) => {
			if (enabled) ensureGlobalFrameProbe();
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				this.tocCoordinator?.sync();
				if (!leaf) return;
				this.autoActivate(leaf);
			}),
		);

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (this.skipPaths.has(file.path)) return;
				if (isBookManifest(this.app, file)) {
					const leaf = this.findLeafWithFile(file);
					if (leaf && leaf.getViewState().type !== VIEW_TYPE_BOOK_VIEW) {
						void this.activateBookView(file.path, leaf);
					}
				}
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.closeOrphanBookViews();

			// Follow the active leaf from the start: open the ToC if a book is
			// already active, close it otherwise.
			this.tocCoordinator?.sync();

			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView?.file) {
				this.autoActivate(activeView.leaf);
			}
		});
	}

	onunload() {
		delete window.BookView;
		this.api = null;
	}

	async loadSettings() {
		const data = await this.loadData() as (Partial<BookViewSettings> & { measuredHeights?: Record<string, { m: number; h: number; w?: number }>; tocAutoCollapse?: boolean }) | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.heightStore = {};
		for (const [path, rec] of Object.entries(data?.measuredHeights ?? {})) {
			if (rec && typeof rec.m === 'number' && typeof rec.h === 'number') {
				// Records saved before width-keying carry no width; tag them -1
				// (match any width) so they keep working until re-measured.
				this.heightStore[path] = typeof rec.w === 'number'
					? rec as { m: number; h: number; w: number }
					: { m: rec.m, h: rec.h, w: -1 };
			}
		}

		if (data?.tocAutoCollapse !== undefined && data.autoExpandMode === undefined) {
			this.settings.autoExpandMode = data.tocAutoCollapse ? 'expand-collapse-level' : 'disabled';
			delete (this.settings as unknown as Record<string, unknown>).tocAutoCollapse;
			void this.saveData(Object.assign({}, this.settings, { measuredHeights: this.heightStore }));
		}
	}

	async saveSettings() {
		await this.saveData(Object.assign({}, this.settings, { measuredHeights: this.heightStore }));
		this.refreshAllTocs();
	}

	refreshAllTocs() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOK_VIEW);
		for (const leaf of leaves) {
			if (leaf.view instanceof BookView) {
				leaf.view.refreshToc();
			}
		}
		this.tocCoordinator?.refresh();
	}

	recalculateBookLayouts() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOK_VIEW);
		for (const leaf of leaves) {
			if (leaf.view instanceof BookView && leaf.view.absoluteManager) {
				leaf.view.absoluteManager.applyThemeSpacings(this.themeSpacings);
			}
		}
	}

	private getActiveBookLeaf(): WorkspaceLeaf | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOK_VIEW);
		for (const leaf of leaves) {
			if (leaf.view instanceof BookView && leaf.view.filePath) {
				return leaf;
			}
		}
		return null;
	}

	private closeOrphanBookViews() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOK_VIEW);
		for (const leaf of leaves) {
			if (leaf.view instanceof BookView && !leaf.view.filePath) {
				leaf.detach();
			}
		}
	}

	private autoActivate(leaf: WorkspaceLeaf) {
		const state = leaf.getViewState();
		if (state.type !== 'markdown') return;

		const viewFile = (leaf.view as { file?: TFile }).file;
		if (!viewFile) return;
		if (this.skipPaths.has(viewFile.path)) return;

		if (isBookManifest(this.app, viewFile)) {
			const existing = this.getActiveBookLeaf();
			if (existing) {
				const bv = existing.view as BookView;
				if (bv.filePath !== viewFile.path) {
					void this.activateBookView(viewFile.path, existing);
				}
				leaf.detach();
			} else {
				void this.activateBookView(viewFile.path, leaf);
			}
		}
	}

	private findLeafWithFile(file: TFile): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (result) return;
			const state = leaf.getViewState();
			if (state.type === 'markdown') {
				const viewFile = (leaf.view as { file?: TFile }).file;
				if (viewFile?.path === file.path) {
					result = leaf;
				}
			}
		});
		return result;
	}

	private async activateBookView(filePath: string, targetLeaf: WorkspaceLeaf) {
		await targetLeaf.setViewState({
			type: VIEW_TYPE_BOOK_VIEW,
			state: { filePath },
		});
	}

	private async collectManuscript(): Promise<void> {
		const bv = this.app.workspace.getActiveViewOfType(BookView);
		if (!bv || !bv.filePath) {
			new Notice('Open a book view first.');
			return;
		}

		const manifestFile = this.app.vault.getFileByPath(bv.filePath);
		if (!(manifestFile instanceof TFile)) return;

		const files = getManifestFiles(this.app, manifestFile);
		if (files.length === 0) {
			new Notice('No linked notes found in this book.');
			return;
		}

		const parts: string[] = [];
		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n?/, '');
			parts.push(stripped.trimEnd());
		}

		const manuscript = parts.join('\n\n');
		const name = `${manifestFile.basename} — Manuscript`;
		const existing = this.app.vault.getAbstractFileByPath(`${name}.md`);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, manuscript);
		} else {
			await this.app.vault.create(`${name}.md`, manuscript);
		}
		new Notice(`Manuscript saved: ${name}.md`);
	}

	private async disableBookView(filePath: string, leaf: WorkspaceLeaf) {
		const file = this.app.vault.getFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		this.skipPaths.add(filePath);

		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm['book-view'] = false;
		});

		await leaf.setViewState({
			type: 'markdown',
			state: { file: filePath, mode: 'source', source: false },
		});

		window.setTimeout(() => this.skipPaths.delete(filePath), 1000);
	}

	private async enableBookView(file: TFile, leaf: WorkspaceLeaf) {
		this.skipPaths.add(file.path);

		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm['book-view'] = true;
		});

		await leaf.setViewState({
			type: VIEW_TYPE_BOOK_VIEW,
			state: { filePath: file.path },
		});

		window.setTimeout(() => this.skipPaths.delete(file.path), 1000);
	}
}
