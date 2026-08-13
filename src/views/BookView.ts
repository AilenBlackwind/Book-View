import { ItemView, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { getManifestFiles, getManifestLinks } from '../components/ManifestParser';
import { AbsoluteSectionManager } from '../components/AbsoluteSectionManager';
import { WheelAccelerator } from '../components/WheelAccelerator';
import { showScriptMenu } from '../ui/ContextMenu';
import { DebugLog } from '../utils/debug';
import type BookViewPlugin from '../main';
import type { ModifierConfig } from '../settings';

function matchesModifiers(evt: MouseEvent, mod: ModifierConfig): boolean {
	return evt.altKey === mod.alt && evt.ctrlKey === mod.ctrl && evt.shiftKey === mod.shift && evt.metaKey === mod.meta;
}

export const VIEW_TYPE_BOOK_VIEW = 'book-view';

export class BookView extends ItemView {
	// Debug: distinguish loadBook calls on the same vs. new instances.
	private static nextInstanceId = 0;
	readonly instanceId = ++BookView.nextInstanceId;
	absoluteManager: AbsoluteSectionManager | null = null;
	private contentContainer: HTMLElement | null = null;
	private wheelAccelerator: WheelAccelerator | null = null;
	private currentFiles: TFile[] = [];
	private manifestPaths: Set<string> = new Set();
	/** Path actually rendered into the view (setState pre-sets filePath, so a
	 *  separate field is needed to detect duplicate loads of the same book). */
	private loadedPath = '';
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

	getContentContainer(): HTMLElement | null {
		return this.contentContainer;
	}

	getCurrentFiles(): TFile[] {
		return this.currentFiles;
	}

	getAbsoluteManager(): AbsoluteSectionManager | null {
		return this.absoluteManager;
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
		this.plugin?.tocCoordinator?.onBookClosed(this);
		this.cleanup();
	}

	refreshToc(): void {
		// In-book ToC is disabled for the sidebar-toc spike; settings changes
		// are applied to the right-rail ToC by the coordinator instead.
		this.plugin?.tocCoordinator?.sync();
	}

	refreshAppliedAtoms(paths: string[]): void {
		for (const path of paths) {
			this.absoluteManager?.markDirty(path);
		}
	}

	private async loadBook(filePath: string): Promise<void> {
		// Debug: log every loadBook call with its instance id to catch
		// duplicate loads of the same book (tab/view churn) vs. fresh instances.
		DebugLog.log('LOAD', String(this.instanceId), filePath);
		// Obsidian may call onOpen/setState with the same filePath several times
		// during a tab switch (open → setState → state re-apply). Each loadBook
		// tears down the whole book, re-renders every section, and force-rebinds
		// the ToC. Skip the duplicate work when this exact book is rendered.
		if (this.loadedPath === filePath && this.absoluteManager && this.currentFiles.length > 0) {
			DebugLog.log('LOAD skip', String(this.instanceId), filePath);
			return;
		}
		this.cleanup();
		this.loadedPath = filePath;
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

		const links = getManifestLinks(this.app, file);
		const files = getManifestFiles(this.app, file);
		if (links.length === 0) {
			this.contentContainer.createDiv({ cls: 'book-empty', text: 'No linked notes found in manifest.' });
			return;
		}

		this.currentFiles = files;
		this.manifestPaths = new Set(files.map((f) => f.path));

		const settings = this.plugin?.settings;

		this.absoluteManager = new AbsoluteSectionManager(
			this.contentContainer,
			links,
			this.app,
			file,
			settings?.loadMargin,
			{ get: this.plugin?.getPersistedHeight, put: this.plugin?.persistHeight },
		);
		if (this.plugin?.themeSpacings) {
			this.absoluteManager.themeSpacings = this.plugin.themeSpacings;
		}
		this.absoluteManager.render();

		// In-book ToC is disabled for the sidebar-toc spike. The right-rail
		// BookTocView owns TocController + tagHeadings via the coordinator,
		// which rebinds after this book finishes loading.
		this.plugin?.tocCoordinator?.setCurrentBook(this);

		this.registerDomEvent(this.contentContainer, 'dblclick', (evt: MouseEvent) => {
			const mod = this.plugin?.settings.editorModifiers;
			if (!mod || !matchesModifiers(evt, mod)) return;
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

		this.registerDomEvent(this.contentContainer, 'contextmenu', (evt: MouseEvent) => {
			const profiles = this.plugin?.settings.menuProfiles;
			if (!profiles || profiles.length === 0) return;

			let matchedProfile: import('../settings').MenuProfile | null = null;
			for (const profile of profiles) {
				if (matchesModifiers(evt, profile.modifiers)) {
					matchedProfile = profile;
					break;
				}
			}

			if (!matchedProfile || matchedProfile.scripts.length === 0) return;

			evt.preventDefault();
			evt.stopPropagation();

			const selection = window.getSelection()?.toString() ?? '';

			const closestHeading = (evt.target as HTMLElement).closest('h1, h2, h3, h4, h5, h6');
			let entryIndex = -1;
			if (closestHeading instanceof HTMLElement) {
				const idx = closestHeading.getAttribute('data-entry-index');
				if (idx !== null) entryIndex = parseInt(idx, 10);
			}

			showScriptMenu(evt, matchedProfile.scripts, this.app, (entry) => {
				this.plugin?.api?.setContext({ selection, entryIndex });
				(this.app as unknown as { commands: { executeCommandById: (id: string) => void } })
					.commands.executeCommandById(entry.commandId);
			});
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
				if (!this.haveHeadingsChanged(file)) return;
				this.scheduleTocRefresh(file.path);
			}),
		);
	}

	private refreshTimers: Map<string, number> = new Map();
	private tocRefreshTimers: Map<string, number> = new Map();
	/** JSON hash of each file's headings (level + heading text), used to skip TOC rebuild when only body text changed */
	private tocHeadingsCache: Map<string, string> = new Map();

	private scheduleRefresh(path: string): void {
		const existing = this.refreshTimers.get(path);
		if (existing) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(path);
			this.absoluteManager?.markDirty(path);
		}, 300);
		this.refreshTimers.set(path, timer);
	}

	private initTocHeadingsCache(): void {
		for (const file of this.currentFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const headings = cache?.headings ?? [];
			this.tocHeadingsCache.set(file.path, JSON.stringify(headings.map((h) => `${h.level}:${h.heading}`)));
		}
	}

	private haveHeadingsChanged(file: TFile): boolean {
		const cache = this.app.metadataCache.getFileCache(file);
		const newHeadings = cache?.headings ?? [];
		const hash = JSON.stringify(newHeadings.map((h) => `${h.level}:${h.heading}`));
		const prev = this.tocHeadingsCache.get(file.path);
		if (prev === undefined) {
			this.tocHeadingsCache.set(file.path, hash);
			return hash.length > 2; // true if file has any headings (first time)
		}
		this.tocHeadingsCache.set(file.path, hash);
		return hash !== prev;
	}

	private scheduleTocRefresh(path: string): void {
		const existing = this.tocRefreshTimers.get(path);
		if (existing) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.tocRefreshTimers.delete(path);
			this.plugin?.tocCoordinator?.refresh();
		}, 500);
		this.tocRefreshTimers.set(path, timer);
	}

	private saveScrollPosition(): void {
		if (this.contentContainer) {
			this.savedScrollTop = this.contentContainer.scrollTop;
		}
	}

	private restoreScrollPosition(): void {
		// Debug: correlate the scroll-event storm with the restore jump
		// (hypothesis B: spy churns while the position jump settles).
		DebugLog.log('RESTORE', '', this.savedScrollTop >= 0 ? this.savedScrollTop : -2);
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
		for (const timer of this.tocRefreshTimers.values()) {
			window.clearTimeout(timer);
		}
		this.tocRefreshTimers.clear();
		this.tocHeadingsCache.clear();
		if (this.absoluteManager) {
			this.absoluteManager.destroy();
			this.absoluteManager = null;
		}
		if (this.wheelAccelerator) {
			this.wheelAccelerator.destroy();
			this.wheelAccelerator = null;
		}
		this.currentFiles = [];
		this.manifestPaths.clear();
	}
}
