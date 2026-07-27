import { ItemView, Menu, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { getManifestFiles, getManifestLinks } from '../components/ManifestParser';
import { AbsoluteSectionManager } from '../components/AbsoluteSectionManager';
import { TocController } from '../components/TocController';
import { WheelAccelerator } from '../components/WheelAccelerator';
import type BookViewPlugin from '../main';

export const VIEW_TYPE_BOOK_VIEW = 'book-view';

export class BookView extends ItemView {
	private absoluteManager: AbsoluteSectionManager | null = null;
	private tocController: TocController | null = null;
	private contentContainer: HTMLElement | null = null;
	private wheelAccelerator: WheelAccelerator | null = null;
	private tocContainer: HTMLElement | null = null;
	private currentFiles: TFile[] = [];
	private manifestPaths: Set<string> = new Set();
	private popoutLeaf: WorkspaceLeaf | null = null;
	private savedScrollTop: number = -1;
	filePath: string = '';
	plugin: BookViewPlugin | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BOOK_VIEW;
	}

	getDisplayText(): string {
		if (this.filePath) {
			const file = this.app.vault.getFileByPath(this.filePath);
			if (file instanceof TFile) {
				return file.basename;
			}
		}
		return 'Book view';
	}

	getIcon(): string {
		return 'book-open';
	}

	getState(): Record<string, unknown> {
		return { filePath: this.filePath };
	}

	protected async onOpen(): Promise<void> {
		const state = this.getState();
		if (typeof state.filePath === 'string' && state.filePath) {
			await this.loadBook(state.filePath);
		}
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = state as Record<string, unknown>;
		if (typeof s?.filePath === 'string') {
			this.filePath = s.filePath;
			await this.loadBook(s.filePath);
		}
	}

	protected async onClose(): Promise<void> {
		this.cleanup();
	}

	refreshToc(): void {
		if (!this.tocContainer || !this.contentContainer || this.currentFiles.length === 0) return;

		const settings = this.plugin?.settings;
		if (settings) {
			this.tocContainer.setCssStyles({ width: `${settings.tocWidth}px` });
		}

		if (this.tocController) {
			this.tocController.destroy();
		}

		this.tocController = new TocController(
			this.tocContainer,
			this.currentFiles,
			this.app,
			this.contentContainer,
			settings ?? null,
			this.absoluteManager,
		);
		this.tocController.build();
	}

	refreshAppliedAtoms(paths: string[]): void {
		for (const path of paths) {
			this.absoluteManager?.markDirty(path);
		}
	}

	private async loadBook(filePath: string): Promise<void> {
		this.cleanup();
		this.filePath = filePath;

		const file = this.app.vault.getFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		this.contentEl.empty();
		this.contentEl.addClass('book-view-root');

		this.contentContainer = this.contentEl.createDiv({ cls: 'book-content-container' });

		this.wheelAccelerator = new WheelAccelerator(this.contentContainer, () => {
			const s = this.plugin?.settings;
			return {
				enabled: s?.wheelFlickEnabled ?? true,
				strength: s?.wheelFlickStrength ?? 2,
				friction: s?.wheelFlickFriction ?? 0.92,
			};
		});

		this.tocContainer = this.contentEl.createDiv({ cls: 'book-toc-container' });

		const settings = this.plugin?.settings;
		if (settings) {
			this.tocContainer.setCssStyles({ width: `${settings.tocWidth}px` });
		}

		const links = getManifestLinks(this.app, file);
		const files = getManifestFiles(this.app, file);
		if (links.length === 0) {
			this.contentContainer.createDiv({ cls: 'book-empty', text: 'No linked notes found in manifest.' });
			return;
		}

		this.currentFiles = files;
		this.manifestPaths = new Set(files.map((f) => f.path));

		this.absoluteManager = new AbsoluteSectionManager(
			this.contentContainer,
			links,
			this.app,
			file,
			settings?.loadMargin,
			{ get: this.plugin?.getPersistedHeight, put: this.plugin?.persistHeight },
		);
		this.absoluteManager.render();

		this.tocController = new TocController(
			this.tocContainer,
			files,
			this.app,
			this.contentContainer,
			settings ?? null,
			this.absoluteManager,
		);
		this.tocController.build();

		this.tocController.onEntryContextMenu = (entryIndex, evt) => {
			const masterFile = this.app.vault.getFileByPath(this.filePath);
			if (!(masterFile instanceof TFile)) return;

			const menu = new Menu();
			menu.addItem((item) => {
				item.setTitle('Create buffer note').onClick(() => {
					void this.plugin?.bufferManager.createBuffer(
						masterFile,
						this.tocController!.getEntries(),
						entryIndex,
					);
				});
			});
			menu.showAtMouseEvent(evt);
		};

		this.registerDomEvent(this.contentContainer, 'dblclick', (evt: MouseEvent) => {
			if (!evt.altKey && !evt.ctrlKey) return;
			evt.preventDefault();

			const placeholder = (evt.target as HTMLElement).closest('.book-section-placeholder');
			if (!(placeholder instanceof HTMLElement)) return;

			const path = placeholder.dataset.path;
			if (!path) return;

			const targetFile = this.app.vault.getFileByPath(path);
			if (!(targetFile instanceof TFile)) return;

			const leaf = this.app.workspace.openPopoutLeaf();
			this.popoutLeaf = leaf;
			void leaf.openFile(targetFile, { state: { mode: 'source' } });
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf === this.leaf) {
					this.restoreScrollPosition();
					if (this.popoutLeaf) {
						this.popoutLeaf.detach();
						this.popoutLeaf = null;
					}
				} else if (leaf && leaf !== this.leaf) {
					this.saveScrollPosition();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				if (!this.manifestPaths.has(file.path)) return;
				this.scheduleRefresh(file.path);
			}),
		);

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (!(file instanceof TFile)) return;
				if (!this.manifestPaths.has(file.path)) return;
				this.tocController?.build();
			}),
		);
	}

	private refreshTimers: Map<string, number> = new Map();

	private scheduleRefresh(path: string): void {
		const existing = this.refreshTimers.get(path);
		if (existing) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(path);
			this.absoluteManager?.markDirty(path);
		}, 300);
		this.refreshTimers.set(path, timer);
	}

	private saveScrollPosition(): void {
		if (this.contentContainer) {
			this.savedScrollTop = this.contentContainer.scrollTop;
		}
	}

	private restoreScrollPosition(): void {
		if (this.contentContainer && this.savedScrollTop >= 0) {
			const target = this.savedScrollTop;
			this.savedScrollTop = -1;
			window.requestAnimationFrame(() => {
				if (!this.contentContainer) return;
				const maxScroll = this.contentContainer.scrollHeight - this.contentContainer.clientHeight;
				this.contentContainer.scrollTop = Math.min(target, Math.max(0, maxScroll));
			});
		}
	}

	private cleanup(): void {
		for (const timer of this.refreshTimers.values()) {
			window.clearTimeout(timer);
		}
		this.refreshTimers.clear();
		if (this.absoluteManager) {
			this.absoluteManager.destroy();
			this.absoluteManager = null;
		}
		if (this.tocController) {
			this.tocController.destroy();
			this.tocController = null;
		}
		if (this.wheelAccelerator) {
			this.wheelAccelerator.destroy();
			this.wheelAccelerator = null;
		}
		this.currentFiles = [];
		this.manifestPaths.clear();
	}
}
