import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';

export const HEIGHT_PER_LINE = 25;
const MIN_HEIGHT = 80;

interface SectionData {
	el: HTMLElement;
	component: Component | null;
	offset: number;
	height: number;
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
	private observer: IntersectionObserver;

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
						void this.loadSection(path);
					}
				}
			},
			{
				root: this.scrollContainer,
				rootMargin: `2000px 0px ${this.loadMargin}px 0px`,
				threshold: 0,
			},
		);
	}

	render(): void {
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
			};
			this.sections.set(path, data);
			this.fileOrder.push(path);

			void this.app.vault.cachedRead(file).then((content) => {
				this.rawContent.set(path, content);
				const est = cached ?? this.estimateHeight(content);
				data.height = est;
				if (!cached) {
					this.heightCache.set(path, est);
				}
				this.recalcOffsets(this.fileOrder.indexOf(path));
			});

			this.observer.observe(el);
		}

		this.recalcOffsets(0);
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

	private async loadSection(path: string): Promise<void> {
		const data = this.sections.get(path);
		if (!data || data.component) return;

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

	private recalcOffsets(fromIndex: number): void {
		const scrollRect = this.scrollContainer.getBoundingClientRect();
		let anchorEl: HTMLElement | null = null;
		let bestTop = -Infinity;
		for (let i = fromIndex; i < this.fileOrder.length; i++) {
			const data = this.sections.get(this.fileOrder[i] ?? '');
			if (!data) continue;
			const top = data.el.getBoundingClientRect().top;
			if (top <= scrollRect.top && top > bestTop) {
				bestTop = top;
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

		for (let i = fromIndex; i < this.fileOrder.length; i++) {
			const path = this.fileOrder[i] ?? '';
			const data = this.sections.get(path);
			if (!data) break;

			data.offset = offset;
			data.el.style.top = `${offset}px`;
			offset += data.height;
		}

		this.spacerEl.style.height = `${offset}px`;

		if (anchorEl && anchorTop != null) {
			const newTop = anchorEl.getBoundingClientRect().top;
			const shift = newTop - anchorTop;
			if (shift !== 0) {
				this.scrollContainer.scrollTop += shift;
			}
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
		this.recalcOffsets(this.fileOrder.indexOf(path));
		void this.loadSection(path);
	}

	markDirty(path: string): void {
		this.refreshSection(path);
	}

	destroy(): void {
		this.observer.disconnect();
		for (const [, data] of this.sections) {
			data.component?.unload();
		}
		this.sections.clear();
		this.fileOrder = [];
		this.heightCache.clear();
		this.rawContent.clear();
	}
}
