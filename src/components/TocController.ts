import { App, TFile } from 'obsidian';
import { BookViewSettings } from '../settings';
import { HEIGHT_PER_LINE } from './AbsoluteSectionManager';
import type { AbsoluteSectionManager } from './AbsoluteSectionManager';
import { renderInlineMarkdown, stripMarkdown } from '../utils/renderInlineMarkdown';

export interface TocEntry {
	level: number;
	text: string;
	file: TFile;
	line: number;
	fileHeadingIndex: number;
}

const TOC_ACTIVE_POSITION = 0.25;

export class TocController {
	private containerEl: HTMLElement;
	private files: TFile[];
	private app: App;
	private scrollContainer: HTMLElement;
	private settings: BookViewSettings | null;
	private absoluteManager: AbsoluteSectionManager | null;
	private entries: TocEntry[] = [];
	private tocItems: HTMLElement[] = [];
	private activeHeading: HTMLElement | null = null;
	onEntryContextMenu: ((entryIndex: number, evt: MouseEvent) => void) | null = null;

	private headingPositions: number[] = [];
	private scrollHandler: (() => void) | null = null;
	private highlightEl: HTMLElement | null = null;
	private fadeTimer: number = 0;
	private lastScrollTop = 0;
	private lastScrollTime = 0;

	constructor(
		containerEl: HTMLElement,
		files: TFile[],
		app: App,
		scrollContainer: HTMLElement,
		settings: BookViewSettings | null,
		absoluteManager: AbsoluteSectionManager | null,
	) {
		this.containerEl = containerEl;
		this.files = files;
		this.app = app;
		this.scrollContainer = scrollContainer;
		this.settings = settings;
		this.absoluteManager = absoluteManager;
	}

	getEntries(): TocEntry[] {
		return this.entries;
	}

	private createHeadingItem(parent: HTMLElement, entry: TocEntry, heading: { heading: string; position: { start: { line: number } }; level: number }, file: TFile): void {
		const li = parent.createEl('li', { cls: 'book-toc-heading' });
		const indent = (heading.level - 1) * 12;
		li.style.paddingLeft = `${indent}px`;
		li.dataset.level = String(heading.level);

		const a = li.createEl('a', {
			cls: 'book-toc-item',
			attr: { 'data-path': file.path, 'data-line': String(heading.position.start.line), 'data-level': String(heading.level) },
		});
		if (this.settings?.tocRenderMarkdown) {
			const span = a.createSpan();
			const html = renderInlineMarkdown(heading.heading);
			const doc = new DOMParser().parseFromString(html, 'text/html');
			while (doc.body.firstChild) {
				span.appendChild(doc.body.firstChild);
			}
		} else {
			a.createSpan({ text: stripMarkdown(heading.heading) });
		}

		const entryIdx = this.entries.length - 1;
		this.tocItems.push(a);
		a.addEventListener('click', (evt) => {
			evt.preventDefault();
			void this.scrollToHeading(entryIdx);
		});
		a.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.onEntryContextMenu?.(entryIdx, evt);
		});
	}

	build(): void {
		this.destroy();
		this.containerEl.empty();
		this.entries = [];
		this.tocItems = [];

		const tocEl = this.containerEl.createDiv({ cls: 'book-toc' });
		if (this.settings?.tocGuides) {
			tocEl.addClass('book-toc-guides');
		}
		const listEl = tocEl.createEl('ul', { cls: 'book-toc-list' });

		for (const file of this.files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.headings) continue;

			if (this.settings?.tocShowFileNames) {
				const fileHeading = listEl.createEl('li', { cls: 'book-toc-file' });
				fileHeading.createDiv({
					cls: 'book-toc-file-title',
					text: file.basename,
				});

				const subList = fileHeading.createEl('ul', { cls: 'book-toc-file-headings' });

				for (let i = 0; i < cache.headings.length; i++) {
					const heading = cache.headings[i];
					if (!heading) continue;
					const entry: TocEntry = {
						level: heading.level,
						text: heading.heading,
						file,
						line: heading.position.start.line,
						fileHeadingIndex: i,
					};
					this.entries.push(entry);
					this.createHeadingItem(subList, entry, heading, file);
				}
			} else {
				for (let i = 0; i < cache.headings.length; i++) {
					const heading = cache.headings[i];
					if (!heading) continue;
					const entry: TocEntry = {
						level: heading.level,
						text: heading.heading,
						file,
						line: heading.position.start.line,
						fileHeadingIndex: i,
					};
					this.entries.push(entry);
					this.createHeadingItem(listEl, entry, heading, file);
				}
			}
		}

		this.containerEl.addClass('book-toc-relative');
		this.highlightEl = this.containerEl.createDiv({ cls: 'book-toc-highlight' });

		this.calculatePositions();
		this.setupScrollSpy();
	}

	calculatePositions(): void {
		if (!this.absoluteManager) return;

		const offsets = this.absoluteManager.getAllOffsets();
		this.headingPositions = this.entries.map((entry) => {
			const fileOffset = offsets.get(entry.file.path) ?? 0;
			return fileOffset + entry.line * HEIGHT_PER_LINE;
		});
	}

	tagHeadings(path: string, container: HTMLElement): void {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.headings) return;

		const headingEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');

		for (let i = 0; i < cache.headings.length; i++) {
			const heading = cache.headings[i];
			if (!heading) continue;
			const el = headingEls[i];
			if (!(el instanceof HTMLElement)) continue;

			const tocIndex = this.entries.findIndex(
				(e) => e.file.path === path && e.line === heading.position.start.line,
			);
			if (tocIndex >= 0) {
				el.setAttribute('data-entry-index', String(tocIndex));
			}
		}
	}

	private setupScrollSpy(): void {
		if (this.tocItems.length === 0) return;

		this.scrollHandler = () => {
			const now = performance.now();
			const scrollTop = this.scrollContainer.scrollTop;
			const dt = now - this.lastScrollTime;
			const ds = Math.abs(scrollTop - this.lastScrollTop);
			const speed = dt > 0 ? (ds / dt) * 1000 : 0;
			this.lastScrollTop = scrollTop;
			this.lastScrollTime = now;

			this.calculatePositions();
			this.highlightByPosition(speed > 1500);

			if (this.highlightEl) {
				this.highlightEl.classList.remove('fading');
			}
			window.clearTimeout(this.fadeTimer);
			this.fadeTimer = window.setTimeout(() => {
				this.highlightEl?.classList.add('fading');
			}, 400);
		};

		this.scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true });
	}

	private highlightByPosition(fast: boolean): void {
		if (this.headingPositions.length === 0) return;

		const scrollTop = this.scrollContainer.scrollTop;
		const viewportHeight = this.scrollContainer.clientHeight;
		const triggerY = scrollTop + viewportHeight * 0.3;

		let bestIndex = -1;
		for (let i = this.headingPositions.length - 1; i >= 0; i--) {
			if ((this.headingPositions[i] ?? 0) <= triggerY) {
				bestIndex = i;
				break;
			}
		}

		if (bestIndex >= 0) {
			this.setActiveByIndex(bestIndex, fast);
		}
	}

	private setActiveByIndex(index: number, instant = false): boolean {
		const el = this.tocItems[index];
		if (!el) return false;

		const changed = el !== this.activeHeading;

		if (this.activeHeading) {
			this.activeHeading.removeClass('is-active');
		}
		el.addClass('is-active');
		this.activeHeading = el;

		if (this.highlightEl) {
			this.highlightEl.classList.remove('fading');
			this.highlightEl.style.top = `${el.offsetTop}px`;
			this.highlightEl.style.height = `${el.offsetHeight}px`;
		}

		const tocContainer = this.containerEl;
		const containerHeight = tocContainer.clientHeight;
		const containerScrollTop = tocContainer.scrollTop;
		const elTop = el.offsetTop;
		const elHeight = el.offsetHeight;
		const targetScrollTop = elTop - containerHeight * TOC_ACTIVE_POSITION + elHeight / 2;

		if (Math.abs(targetScrollTop - containerScrollTop) > 2) {
			tocContainer.scrollTo({ top: targetScrollTop, behavior: instant ? 'auto' : 'smooth' });
		}

		return changed;
	}

	async scrollToHeading(entryIndex: number): Promise<void> {
		const entry = this.entries[entryIndex];
		if (!entry || !this.absoluteManager) return;

		const sectionOffset = this.absoluteManager.getOffset(entry.file.path);
		const estimatedY = sectionOffset + entry.line * HEIGHT_PER_LINE;

		this.scrollContainer.scrollTo({ top: Math.max(0, estimatedY - 20), behavior: 'auto' });

		const placeholder = this.scrollContainer.querySelector(
			`.book-section-placeholder[data-path="${entry.file.path}"]`,
		);
		if (!(placeholder instanceof HTMLElement)) return;

		await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

		const headings = placeholder.querySelectorAll('h1, h2, h3, h4, h5, h6');
		const targetHeading = headings[entry.fileHeadingIndex] ?? headings[0] ?? placeholder;

		const headingRect = targetHeading.getBoundingClientRect();
		const containerRect = this.scrollContainer.getBoundingClientRect();
		const currentScroll = this.scrollContainer.scrollTop;
		const correctedScroll = currentScroll + (headingRect.top - containerRect.top) - 20;

		this.scrollContainer.scrollTo({ top: correctedScroll, behavior: 'auto' });

		this.highlightHeading(targetHeading as HTMLElement);
		this.setActiveByIndex(entryIndex, true);
	}

	private highlightHeading(el: HTMLElement): void {
		el.addClass('book-heading-highlight');
		const handler = () => {
			el.removeClass('book-heading-highlight');
			el.removeEventListener('animationend', handler);
		};
		el.addEventListener('animationend', handler);
	}

	destroy(): void {
		if (this.scrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		window.clearTimeout(this.fadeTimer);
		this.highlightEl = null;
		this.activeHeading = null;
		this.entries = [];
		this.tocItems = [];
		this.headingPositions = [];
	}
}
