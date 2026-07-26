import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';

export const HEIGHT_PER_LINE = 25;
const MIN_HEIGHT = 80;

export class SectionManager {
	private containerEl: HTMLElement;
	private links: ManifestLink[];
	private app: App;
	private observer: IntersectionObserver;
	private resizeObserver: ResizeObserver;
	private sectionResizeObserver: ResizeObserver;
	private resizeTimer: number = 0;
	private loadMargin: number;
	private placeholders: Map<string, HTMLElement> = new Map();
	private components: Map<string, Component> = new Map();
	private heightCache: Map<string, number> = new Map();
	private estimatedHeights: Map<string, number> = new Map();
	private rawContent: Map<string, string> = new Map();
	private renderedDomCache: Map<string, HTMLElement> = new Map();
	private renderQueue: Array<{ placeholder: HTMLElement; path: string }> = [];
	private isProcessingQueue: boolean = false;
	onHeightMeasured: ((path: string, estimated: number, actual: number) => void) | null = null;
	onSectionRendered: ((path: string, container: HTMLElement) => void) | null = null;

	constructor(containerEl: HTMLElement, links: ManifestLink[], app: App, _masterFile: TFile, loadMargin: number = 800) {
		this.containerEl = containerEl;
		this.links = links;
		this.app = app;
		this.loadMargin = loadMargin;

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const path = el.dataset.path;
					if (!path) continue;

					if (entry.isIntersecting) {
						this.enqueueSection(el, path);
					} else if (entry.boundingClientRect.top < 0) {
						this.unloadSection(el, path);
					}
				}
			},
			{
				root: this.containerEl,
				rootMargin: '2000px 0px 800px 0px',
				threshold: 0,
			},
		);

		this.resizeObserver = new ResizeObserver(() => {
		window.clearTimeout(this.resizeTimer);
			this.resizeTimer = window.setTimeout(() => {
				this.remeasureLoadedSections();
			}, 200);
		});
		this.resizeObserver.observe(this.containerEl);

		this.sectionResizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const el = entry.target as HTMLElement;
				const path = el.dataset.path;
				if (!path || el.dataset.loaded !== 'true') continue;

				const realHeight = entry.contentRect.height;
				if (realHeight <= 0) continue;

				const estimated = this.estimatedHeights.get(path) ?? realHeight;

				this.heightCache.set(path, realHeight);
				this.estimatedHeights.set(path, realHeight);
				this.onHeightMeasured?.(path, estimated, realHeight);
				this.sectionResizeObserver.unobserve(el);
			}
		});
	}

	private estimateHeight(text: string): number {
		const lines = text.split('\n').length;
		let estimated = lines * HEIGHT_PER_LINE;

		const images = (text.match(/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/g) || []).length;
		const codeBlocks = (text.match(/```/g) || []).length / 2;
		const callouts = (text.match(/>\s*\[!/g) || []).length;

		estimated += images * 250;
		estimated += codeBlocks * 120;
		estimated += callouts * 80;

		return Math.max(MIN_HEIGHT, estimated);
	}

	render(): void {
		for (const link of this.links) {
			if (link.type === 'broken') {
				const el = this.containerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '❌ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Note not found: ${link.display}` });
				continue;
			}

			if (link.type === 'empty') {
				const el = this.containerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '⚠️ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Empty note: ${link.file.path}` });
				continue;
			}

			const file = link.file;
			const placeholder = this.containerEl.createDiv({
				cls: 'book-section-placeholder',
				attr: { 'data-path': file.path },
			});

			void this.app.vault.cachedRead(file).then((content) => {
				this.rawContent.set(file.path, content);
				const cached = this.heightCache.get(file.path);
				if (cached) {
					placeholder.setCssStyles({ minHeight: `${cached}px` });
					this.estimatedHeights.set(file.path, cached);
				} else {
					const est = this.estimateHeight(content);
					placeholder.setCssStyles({ minHeight: `${est}px` });
					this.estimatedHeights.set(file.path, est);
				}
			});

			this.placeholders.set(file.path, placeholder);
			this.observer.observe(placeholder);
		}
	}

	private enqueueSection(placeholder: HTMLElement, path: string): void {
		if (placeholder.dataset.loaded === 'true') return;
		if (this.renderQueue.some((q) => q.path === path)) return;

		this.renderQueue.push({ placeholder, path });
		this.processQueue();
	}

	private processQueue(): void {
		if (this.isProcessingQueue || this.renderQueue.length === 0) return;
		this.isProcessingQueue = true;

		const item = this.renderQueue.shift();
		if (item) {
			void this.loadSection(item.placeholder, item.path).then(() => {
				window.requestAnimationFrame(() => {
					this.isProcessingQueue = false;
					this.processQueue();
				});
			});
		} else {
			this.isProcessingQueue = false;
		}
	}

	expandLoadMargin(): void {
		this.observer.disconnect();
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const path = el.dataset.path;
					if (!path) continue;

					if (entry.isIntersecting) {
						this.enqueueSection(el, path);
					} else if (entry.boundingClientRect.top < 0) {
						this.unloadSection(el, path);
					}
				}
			},
			{
				root: this.containerEl,
				rootMargin: `2000px 0px ${this.loadMargin}px 0px`,
				threshold: 0,
			},
		);
		for (const [, ph] of this.placeholders) {
			this.observer.observe(ph);
		}
	}

	private async loadSection(placeholder: HTMLElement, path: string): Promise<void> {
		if (placeholder.dataset.loaded === 'true') return;

		const existing = placeholder.querySelector('.markdown-rendered');
		if (existing) {
			placeholder.dataset.loaded = 'true';
			return;
		}

		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;

		const cached = this.renderedDomCache.get(path);
		if (cached) {
			const clone = cached.cloneNode(true) as HTMLElement;
			placeholder.empty();
			placeholder.appendChild(clone);
			placeholder.dataset.loaded = 'true';
			placeholder.setCssStyles({ minHeight: '0' });
			this.sectionResizeObserver.observe(placeholder);
			this.onSectionRendered?.(path, clone);
			return;
		}

		const content = this.rawContent.get(path) ?? await this.app.vault.cachedRead(file);

		const renderContainer = placeholder.createDiv({
			cls: 'markdown-rendered markdown-preview-view',
		});

		const component = new Component();
		this.components.set(path, component);
		await MarkdownRenderer.render(this.app, content, renderContainer, path, component);

		this.renderedDomCache.set(path, renderContainer);

		placeholder.empty();
		placeholder.appendChild(renderContainer);
		placeholder.dataset.loaded = 'true';

		placeholder.setCssStyles({ minHeight: '0' });

		this.sectionResizeObserver.observe(placeholder);

		this.onSectionRendered?.(path, renderContainer);
	}

	async loadSectionNow(path: string): Promise<void> {
		const placeholder = this.placeholders.get(path);
		if (!placeholder) return;
		await this.loadSection(placeholder, path);
	}

	private unloadSection(placeholder: HTMLElement, path: string): void {
		if (placeholder.dataset.loaded !== 'true') return;

		const component = this.components.get(path);
		if (component) {
			component.unload();
			this.components.delete(path);
		}

		placeholder.dataset.loaded = 'false';
	}

	refreshSection(path: string): void {
		this.renderQueue = this.renderQueue.filter((q) => q.path !== path);

		const placeholder = this.placeholders.get(path);
		if (!placeholder) return;

		const oldComponent = this.components.get(path);
		if (oldComponent) {
			oldComponent.unload();
			this.components.delete(path);
		}

		placeholder.dataset.loaded = 'false';
		placeholder.empty();
		void this.loadSection(placeholder, path);
	}

	markDirty(path: string): void {
		this.rawContent.delete(path);
		this.heightCache.delete(path);
		this.renderedDomCache.delete(path);

		const placeholder = this.placeholders.get(path);
		if (!placeholder) return;

		if (placeholder.dataset.loaded === 'true') {
			this.refreshSection(path);
		}
	}

	getHeightCache(path: string): number | undefined {
		return this.heightCache.get(path);
	}

	getRawContent(path: string): string | undefined {
		return this.rawContent.get(path);
	}

	private remeasureLoadedSections(): void {
		for (const [path, placeholder] of this.placeholders) {
			if (placeholder.dataset.loaded !== 'true') continue;
			const rendered = placeholder.querySelector('.markdown-rendered');
			if (!(rendered instanceof HTMLElement)) continue;
			const newHeight = rendered.getBoundingClientRect().height;
			if (newHeight <= 0) continue;
			const oldHeight = this.heightCache.get(path);
			if (oldHeight !== undefined && Math.abs(newHeight - oldHeight) < 1) continue;
			this.heightCache.set(path, newHeight);
			this.onHeightMeasured?.(path, oldHeight ?? newHeight, newHeight);
		}
	}

	destroy(): void {
		this.observer.disconnect();
		this.resizeObserver.disconnect();
		this.sectionResizeObserver.disconnect();
		window.clearTimeout(this.resizeTimer);
		this.renderQueue = [];
		this.isProcessingQueue = false;
		for (const [, component] of this.components) {
			component.unload();
		}
		this.placeholders.clear();
		this.heightCache.clear();
		this.estimatedHeights.clear();
		this.rawContent.clear();
		this.renderedDomCache.clear();
		this.components.clear();
	}
}
