import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';

export const HEIGHT_PER_LINE = 25;
const MIN_HEIGHT = 80;
const HEADING_GAP = 6;
const TEXT_GAP = 16;

interface SectionData {
	el: HTMLElement;
	component: Component | null;
	offset: number;
	height: number;
	startsWithHeading: boolean;
	endsWithHeading: boolean;
}

export class AbsoluteSectionManager {
	private scrollContainer: HTMLElement;
	private spacerEl: HTMLElement;
	private links: ManifestLink[];
	private app: App;
	private masterFile: TFile;
	private loadMargin: number;

	private sections: Map<string, SectionData> = new Map();
	private fileOrder: string[] = [];
	private rawContent: Map<string, string> = new Map();
	private heightCache: Map<string, number> = new Map();
	private renderedDomCache: Map<string, HTMLElement> = new Map();
	private observer: IntersectionObserver;
	private containerResizeObserver: ResizeObserver;
	private resizeTimer: number = 0;
	private prevScrollTop = 0;
	private boundScrollHandler: (() => void) | null = null;
	private renderQueue: string[] = [];
	private activeRenderCount = 0;
	private maxConcurrent = 1;
	private coldStartTimer: number = 0;
	private lastScrollTop = 0;
	private lastContainerWidth = 0;
	private destroyed = false;

	onHeightMeasured: ((path: string, estimated: number, actual: number) => void) | null = null;

	constructor(
		scrollContainer: HTMLElement,
		links: ManifestLink[],
		app: App,
		masterFile: TFile,
		loadMargin: number = 800,
	) {
		this.scrollContainer = scrollContainer;
		this.links = links;
		this.app = app;
		this.masterFile = masterFile;
		this.loadMargin = loadMargin;

		this.scrollContainer.addClass('book-absolute-container');
		this.spacerEl = this.scrollContainer.createDiv({ cls: 'book-spacer' });

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const path = el.dataset.path;
					if (!path) continue;

					if (entry.isIntersecting) {
						this.enqueueRender(path);
					} else {
						this.unloadSection(path);
					}
				}
			},
			{
				root: this.scrollContainer,
				rootMargin: `2000px 0px ${this.loadMargin}px 0px`,
				threshold: 0,
			},
		);

		this.containerResizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const newWidth = entry.contentRect.width;
				if (this.lastContainerWidth !== 0 && Math.abs(newWidth - this.lastContainerWidth) > 2) {
					for (const [path, data] of this.sections) {
						if (!data.el.querySelector('.markdown-rendered')) {
							this.heightCache.delete(path);
						}
					}
				}
				this.lastContainerWidth = newWidth;
			}
			window.clearTimeout(this.resizeTimer);
			this.resizeTimer = window.setTimeout(() => {
				this.remeasureAll();
			}, 200);
		});
		this.containerResizeObserver.observe(this.scrollContainer);

		this.boundScrollHandler = () => {
			const newTop = this.scrollContainer.scrollTop;
			const delta = Math.abs(newTop - this.lastScrollTop);
			if (delta > 2000) {
				this.renderQueue = this.renderQueue.filter((p) => {
					const d = this.sections.get(p);
					if (!d || d.component) return false;
					const rect = d.el.getBoundingClientRect();
					return Math.abs(rect.top) < 4000;
				});
			}
			this.lastScrollTop = newTop;
			this.prevScrollTop = newTop;
		};
		this.scrollContainer.addEventListener('scroll', this.boundScrollHandler, { passive: true });

		this.coldStartTimer = window.setTimeout(() => {
			this.maxConcurrent = 2;
			this.drainQueue();
		}, 200);
	}

	render(): void {
		const readPromises: Promise<void>[] = [];
		for (const link of this.links) {
			if (link.type === 'broken') {
				const el = this.spacerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '❌ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Note not found: ${link.display}` });
				continue;
			}

			if (link.type === 'empty') {
				const el = this.spacerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '⚠️ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Empty note: ${link.file.path}` });
				continue;
			}

			const file = link.file;
			const path = file.path;

			const el = this.spacerEl.createDiv({
				cls: 'book-section-placeholder book-section-absolute',
				attr: { 'data-path': path },
			});

			const cached = this.heightCache.get(path);
			const estimated = cached ?? MIN_HEIGHT;

		const data: SectionData = {
			el,
			component: null,
			offset: 0,
			height: estimated,
			startsWithHeading: false,
			endsWithHeading: false,
		};
			this.sections.set(path, data);
			this.fileOrder.push(path);

			const p = this.app.vault.cachedRead(file).then((content) => {
				this.rawContent.set(path, content);
				const est = cached ?? this.estimateHeight(content);
				data.height = est;
				if (!cached) {
					this.heightCache.set(path, est);
				}
				data.startsWithHeading = AbsoluteSectionManager.startsWithHeading(content);
				data.endsWithHeading = AbsoluteSectionManager.endsWithHeading(content);
			});
			readPromises.push(p);

			this.observer.observe(el);
		}

		this.recalcOffsets(0);
		void Promise.allSettled(readPromises).then(() => {
			this.recalcOffsets(0);
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

	private static startsWithHeading(text: string): boolean {
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			return /^#{1,6}\s/.test(trimmed);
		}
		return false;
	}

	private static endsWithHeading(text: string): boolean {
		const lines = text.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i]?.trim() ?? '';
			if (trimmed.length === 0) continue;
			return /^#{1,6}\s/.test(trimmed);
		}
		return false;
	}

	private async loadSection(path: string): Promise<void> {
		const data = this.sections.get(path);
		if (!data || data.component) return;

		const cachedDom = this.renderedDomCache.get(path);
		if (cachedDom) {
			this.renderedDomCache.delete(path);
			data.el.appendChild(cachedDom);
			const component = new Component();
			data.component = component;
			return;
		}

		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;

		const content = this.rawContent.get(path) ?? await this.app.vault.cachedRead(file);

		const renderContainer = data.el.createDiv({
			cls: 'markdown-rendered markdown-preview-view',
		});

		const component = new Component();
		data.component = component;
		await MarkdownRenderer.render(this.app, content, renderContainer, path, component);

		data.el.empty();
		data.el.appendChild(renderContainer);

		await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		const realHeight = renderContainer.getBoundingClientRect().height;
		if (realHeight > 0) {
			const oldHeight = data.height;
			data.height = realHeight;
			this.heightCache.set(path, realHeight);
			this.onHeightMeasured?.(path, oldHeight, realHeight);

			const idx = this.fileOrder.indexOf(path);
			this.recalcOffsets(idx);
		}
	}

	private unloadSection(path: string): void {
		const data = this.sections.get(path);
		if (!data || !data.component) return;

		const rendered = data.el.querySelector('.markdown-rendered');
		if (rendered) {
			this.renderedDomCache.set(path, rendered as HTMLElement);
		}

		data.component.unload();
		data.component = null;
		data.el.empty();
	}

	private enqueueRender(path: string): void {
		if (this.destroyed) return;
		const data = this.sections.get(path);
		if (!data || data.component) return;
		if (this.renderQueue.includes(path)) return;
		this.renderQueue.push(path);
		this.drainQueue();
	}

	private drainQueue(): void {
		if (this.destroyed) return;
		while (this.activeRenderCount < this.maxConcurrent && this.renderQueue.length > 0) {
			const path = this.renderQueue.shift()!;
			this.activeRenderCount++;
			void this.loadSection(path).finally(() => {
				this.activeRenderCount--;
				this.drainQueue();
			});
		}
	}

	private recalcOffsets(fromIndex: number): void {
		const scrollRect = this.scrollContainer.getBoundingClientRect();
		let anchorEl: HTMLElement | null = null;
		let bestTop = -Infinity;
		for (let i = fromIndex; i < this.fileOrder.length; i++) {
			const data = this.sections.get(this.fileOrder[i] ?? '');
			if (!data) continue;
			const rect = data.el.getBoundingClientRect();
			if (rect.bottom <= scrollRect.top && rect.top > bestTop) {
				bestTop = rect.top;
				anchorEl = data.el;
			}
		}
		if (!anchorEl && fromIndex < this.fileOrder.length) {
			anchorEl = this.sections.get(this.fileOrder[fromIndex] ?? '')?.el ?? null;
		}
		const anchorTop = anchorEl?.getBoundingClientRect().top;

		let offset = fromIndex > 0
			? (this.sections.get(this.fileOrder[fromIndex - 1] ?? '')?.offset ?? 0)
				+ (this.sections.get(this.fileOrder[fromIndex - 1] ?? '')?.height ?? 0)
			: 0;

		if (fromIndex > 0) {
			const prevData = this.sections.get(this.fileOrder[fromIndex - 1] ?? '');
			const currData = this.sections.get(this.fileOrder[fromIndex] ?? '');
			if (prevData && currData) {
				offset += (prevData.endsWithHeading && currData.startsWithHeading)
					? HEADING_GAP : TEXT_GAP;
			}
		}

		for (let i = fromIndex; i < this.fileOrder.length; i++) {
			const path = this.fileOrder[i] ?? '';
			const data = this.sections.get(path);
			if (!data) break;

			data.offset = offset;
			data.el.style.top = `${offset}px`;
			offset += data.height;

			if (i + 1 < this.fileOrder.length) {
				const nextData = this.sections.get(this.fileOrder[i + 1] ?? '');
				if (nextData) {
					offset += (data.endsWithHeading && nextData.startsWithHeading)
						? HEADING_GAP : TEXT_GAP;
				}
			}
		}

		this.spacerEl.style.height = `${offset}px`;

		if (anchorEl && anchorTop != null) {
			const newTop = anchorEl.getBoundingClientRect().top;
			const shift = newTop - anchorTop;
			if (shift !== 0) {
				const scrollingUp = this.scrollContainer.scrollTop < this.prevScrollTop;
				const scrollingDown = this.scrollContainer.scrollTop > this.prevScrollTop;
				if (!((scrollingUp && shift > 0) || (scrollingDown && shift < 0))) {
					this.scrollContainer.scrollTop += shift;
				}
			}
		}
	}

	private remeasureAll(): void {
		let changed = false;
		for (const [path, data] of this.sections) {
			const rendered = data.el.querySelector('.markdown-rendered');
			if (!rendered) continue;
			const newHeight = rendered.getBoundingClientRect().height;
			if (newHeight > 0 && newHeight !== data.height) {
				data.height = newHeight;
				this.heightCache.set(path, newHeight);
				changed = true;
			}
		}
		if (changed) {
			this.recalcOffsets(0);
		}
	}

	getOffset(path: string): number {
		return this.sections.get(path)?.offset ?? 0;
	}

	getAllOffsets(): Map<string, number> {
		const result = new Map<string, number>();
		for (const [path, data] of this.sections) {
			result.set(path, data.offset);
		}
		return result;
	}

	refreshSection(path: string): void {
		const data = this.sections.get(path);
		if (!data) return;

		if (data.component) {
			data.component.unload();
			data.component = null;
		}

		this.rawContent.delete(path);
		this.heightCache.delete(path);
		data.el.empty();
		data.height = MIN_HEIGHT;
		data.startsWithHeading = false;
		data.endsWithHeading = false;
		this.recalcOffsets(this.fileOrder.indexOf(path));
		void this.loadSection(path);
	}

	markDirty(path: string): void {
		this.refreshSection(path);
	}

	destroy(): void {
		this.destroyed = true;
		this.renderQueue.length = 0;
		this.observer.disconnect();
		this.containerResizeObserver.disconnect();
		if (this.boundScrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.boundScrollHandler);
		}
		window.clearTimeout(this.resizeTimer);
		window.clearTimeout(this.coldStartTimer);
		for (const [, data] of this.sections) {
			data.component?.unload();
		}
		this.sections.clear();
		this.fileOrder = [];
		this.heightCache.clear();
		this.renderedDomCache.clear();
		this.rawContent.clear();
	}
}
