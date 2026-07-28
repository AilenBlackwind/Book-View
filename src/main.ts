import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { BookView, VIEW_TYPE_BOOK_VIEW } from './views/BookView';
import { getManifestFiles, isBookManifest } from './components/ManifestParser';
import { WheelAccelerator } from './components/WheelAccelerator';
import { BookViewSettings, DEFAULT_SETTINGS } from './settings';
import { BookViewSettingTab } from './ui/SettingsTab';
import { BufferManager } from './BufferManager';
import { BookViewAPI } from './BookViewAPI';

export default class BookViewPlugin extends Plugin {
	settings: BookViewSettings = DEFAULT_SETTINGS;
	bufferManager: BufferManager = null as unknown as BufferManager;
	api: BookViewAPI | null = null;
	private skipPaths = new Set<string>();
	heightStore: Record<string, { m: number; h: number }> = {};
	private saveHeightsTimer = 0;

	getPersistedHeight = (path: string, mtime: number): number | undefined => {
		const rec = this.heightStore[path];
		return rec && rec.m === mtime ? rec.h : undefined;
	};

	persistHeight = (path: string, mtime: number, height: number): void => {
		const rec = this.heightStore[path];
		if (rec && rec.m === mtime && Math.abs(rec.h - height) < 1) return;
		this.heightStore[path] = { m: mtime, h: height };
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

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
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
		const data = await this.loadData() as (Partial<BookViewSettings> & { measuredHeights?: Record<string, { m: number; h: number }> }) | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.heightStore = data?.measuredHeights ?? {};
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
