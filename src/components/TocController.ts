import { App, TFile } from 'obsidian';
import { BookViewSettings } from '../settings';
import { HEIGHT_PER_LINE } from './SectionManager';
import type { SectionManager } from './SectionManager';
import { renderInlineMarkdown, stripMarkdown } from '../utils/renderInlineMarkdown';

export interface TocEntry {
	level: number;
	text: string;
	file: TFile;
	line: number;
	fileHeadingIndex: number;
}

const SCROLL_SETTLE_DELAY = 16;
const TOC_ACTIVE_POSITION = 0.25;

export class TocController {
	private containerEl: HTMLElement;
	private files: TFile[];
	private app: App;
	private scrollContainer: HTMLElement;
	private settings: BookViewSettings;
	private sectionManager: SectionManager | null = null;
	private entries: TocEntry[] = [];
	private tocItems: HTMLElement[] = [];
	private activeHeading: HTMLElement | null = null;
	onEntryContextMenu: ((entryIndex: number, evt: MouseEvent) => void) | null = null;

	private fileOffsets: Map<string, number> = new Map();
	private headingPositions: number[] = [];
	private scrollHandler: (() => void) | null = null;
	private settleTimer: number = 0;
	private pendingCorrection: number | null = null;

	constructor(
		containerEl: HTMLElement,
		files: TFile[],
		app: App,
		scrollContainer: HTMLElement,
		settings: BookViewSettings,
	) {
		this.containerEl = containerEl;
		this.files = files;
		this.app = app;
		this.scrollContainer = scrollContainer;
		this.settings = settings;
	}

	setSectionManager(sm: SectionManager): void {
		this.sectionManager = sm;
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
		if (this.settings.tocRenderMarkdown) {
			const span = a.createSpan();
			// sanitized by renderInlineMarkdown which escapes HTML entities
			// eslint-disable-next-line no-unsanitized/property -- input is escaped by renderInlineMarkdown
			span.innerHTML = renderInlineMarkdown(heading.heading);
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
		if (this.settings.tocGuides) {
			tocEl.addClass('book-toc-guides');
		}
		const listEl = tocEl.createEl('ul', { cls: 'book-toc-list' });

		for (const file of this.files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.headings) continue;

			if (this.settings.tocShowFileNames) {
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

		this.calculatePositions();
		this.setupScrollSpy();
	}

	calculatePositions(): void {
		this.fileOffsets.clear();
		let cumulativeY = 0;

		for (const file of this.files) {
			this.fileOffsets.set(file.path, cumulativeY);
			const cached = this.sectionManager?.getHeightCache(file.path);
			if (cached !== undefined) {
				cumulativeY += cached + 16;
			} else {
				const raw = this.sectionManager?.getRawContent(file.path);
				const est = raw ? Math.max(80, raw.split('\n').length * HEIGHT_PER_LINE) : 300;
				cumulativeY += est + 16;
			}
		}

		this.headingPositions = this.entries.map((entry) => {
			const fileOffset = this.fileOffsets.get(entry.file.path) ?? 0;
			return fileOffset + entry.line * HEIGHT_PER_LINE;
		});
	}

	updateFileHeight(path: string, estimatedHeight: number, actualHeight: number): void {
		const delta = actualHeight - estimatedHeight;
		if (delta === 0) return;

		const fileIndex = this.files.findIndex((f) => f.path === path);
		if (fileIndex < 0) return;

		for (let i = fileIndex; i < this.files.length; i++) {
			const filePath = this.files[i]?.path;
			if (!filePath) break;
			const current = this.fileOffsets.get(filePath) ?? 0;
			this.fileOffsets.set(filePath, current + delta);
		}

		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;
			const fileOffset = this.fileOffsets.get(entry.file.path) ?? 0;
			this.headingPositions[i] = fileOffset + entry.line * HEIGHT_PER_LINE;
		}
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
			window.clearTimeout(this.settleTimer);
			this.settleTimer = window.setTimeout(() => {
				this.highlightByDOM();
			}, SCROLL_SETTLE_DELAY);
		};

		this.scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true });
	}

	private highlightByDOM(): void {
		const containerRect = this.scrollContainer.getBoundingClientRect();
		const triggerY = containerRect.top + containerRect.height * 0.3;

		let bestIndex = -1;
		let bestDist = Infinity;

		const tagged = Array.from(this.scrollContainer.querySelectorAll<HTMLElement>('[data-entry-index]'));
		for (const el of tagged) {
			const rect = el.getBoundingClientRect();
			if (rect.top <= triggerY) {
				const dist = triggerY - rect.top;
				if (dist < bestDist) {
					bestDist = dist;
					bestIndex = parseInt(el.getAttribute('data-entry-index') ?? '-1', 10);
				}
			}
		}

		if (bestIndex >= 0) {
			this.setActiveByIndex(bestIndex);
		}
	}

	private setActiveByIndex(index: number): boolean {
		const el = this.tocItems[index];
		if (!el) return false;

		const changed = el !== this.activeHeading;

		if (this.activeHeading) {
			this.activeHeading.removeClass('is-active');
		}
		el.addClass('is-active');
		this.activeHeading = el;

		const tocContainer = this.containerEl;
		const containerHeight = tocContainer.clientHeight;
		const containerScrollTop = tocContainer.scrollTop;
		const elTop = el.offsetTop;
		const elHeight = el.offsetHeight;
		const targetScrollTop = elTop - containerHeight * TOC_ACTIVE_POSITION + elHeight / 2;

		if (Math.abs(targetScrollTop - containerScrollTop) > 2) {
			tocContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
		}

		return changed;
	}

	async scrollToHeading(entryIndex: number): Promise<void> {
		const entry = this.entries[entryIndex];
		if (!entry) return;

		const fileOffset = this.fileOffsets.get(entry.file.path) ?? 0;
		const estimatedY = fileOffset + entry.line * HEIGHT_PER_LINE;

		this.scrollContainer.scrollTo({ top: Math.max(0, estimatedY - 20), behavior: 'auto' });

		const placeholder = this.scrollContainer.querySelector(
			`.book-section-placeholder[data-path="${entry.file.path}"]`,
		);
		if (!(placeholder instanceof HTMLElement)) return;

		if (!placeholder.querySelector('.markdown-rendered') && this.sectionManager) {
			await this.sectionManager.loadSectionNow(entry.file.path);

			const actualOffset = this.fileOffsets.get(entry.file.path) ?? 0;
			const correctedY = actualOffset + entry.line * HEIGHT_PER_LINE;
			if (Math.abs(correctedY - estimatedY) > 2) {
				this.scrollContainer.scrollTo({ top: Math.max(0, correctedY - 20), behavior: 'auto' });
			}
		}

		await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

		const headings = placeholder.querySelectorAll('h1, h2, h3, h4, h5, h6');
		const targetHeading = headings[entry.fileHeadingIndex] ?? headings[0] ?? placeholder;

		const headingRect = targetHeading.getBoundingClientRect();
		const containerRect = this.scrollContainer.getBoundingClientRect();
		const currentScroll = this.scrollContainer.scrollTop;
		const correctedScroll = currentScroll + (headingRect.top - containerRect.top) - 20;

		this.scrollContainer.scrollTo({ top: correctedScroll, behavior: 'auto' });

		this.highlightHeading(targetHeading as HTMLElement);
		this.setActiveByIndex(entryIndex);
	}

	applyPendingCorrection(): void {
		if (this.pendingCorrection === null) return;
		this.scrollContainer.scrollTop += this.pendingCorrection;
		this.pendingCorrection = null;
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
		window.clearTimeout(this.settleTimer);
		this.activeHeading = null;
		this.entries = [];
		this.tocItems = [];
		this.headingPositions = [];
		this.fileOffsets.clear();
		this.pendingCorrection = null;
	}
}
