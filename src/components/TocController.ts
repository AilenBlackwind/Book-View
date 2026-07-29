import { App, TFile, setIcon } from 'obsidian';
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

export class TocController {
	private containerEl: HTMLElement;
	private files: TFile[];
	private app: App;
	private scrollContainer: HTMLElement;
	private settings: BookViewSettings | null;
	private absoluteManager: AbsoluteSectionManager | null;
	private entries: TocEntry[] = [];
	private tocItems: HTMLElement[] = [];
	private headingLis: HTMLElement[] = [];
	private chevronEls: HTMLElement[] = [];
	private activeHeading: HTMLElement | null = null;
	onEntryContextMenu: ((entryIndex: number, evt: MouseEvent) => void) | null = null;

	// --- Expand/collapse state ---
	private userCollapsedSet: Set<number> = new Set();
	private userExpandedSet: Set<number> = new Set();
	/** Force-expanded by scroll tracking (recomputed every tick) */
	private activePathSet: Set<number> = new Set();
	private activeEntryIndex = -1;
	private pendingPathIndex = -1;
	private activePathTimer = 0;
	private animCleanupTimer = 0;
	private defaultLevel = 0;

	// --- Scroll ---
	private headingPositions: number[] = [];
	private scrollHandler: (() => void) | null = null;
	private scrollRafId = 0;
	private highlightEl: HTMLElement | null = null;
	private fadeTimer = 0;
	private settleTimer = 0;
	private lastScrollTop = 0;

	// --- Navigation guard ---
	private navigating = false;
	private navigationTimer = 0;
	/** true while programmatic scroll is in progress */
	private isJumping = false;

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
		li.style.paddingLeft = `${(heading.level - 1) * 12}px`;
		li.dataset.level = String(heading.level);

		// Inner wrapper for grid row animation
		const inner = li.createDiv({ cls: 'book-toc-heading-inner' });

		const chevron = inner.createSpan({ cls: 'book-toc-chevron' });
		setIcon(chevron, 'chevron-right');
		const entryIdx = this.entries.length - 1;
		this.chevronEls.push(chevron);
		chevron.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleCollapse(entryIdx);
		});

		const a = inner.createEl('a', {
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

		this.headingLis.push(li);
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
		this.headingLis = [];
		this.chevronEls = [];
		this.userCollapsedSet.clear();
		this.userExpandedSet.clear();
		this.activePathSet.clear();
		this.activeEntryIndex = -1;
		this.isJumping = false;

		this.defaultLevel = this.settings?.tocCollapsedLevel ?? 0;

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

		if (this.settings?.tocActiveColor) {
			this.containerEl.style.setProperty('--bv-toc-active-color', this.settings.tocActiveColor);
		}

		this.markLeafChevrons();
		this.applyNestingGuides();
		this.applyVisibility();
		this.calculatePositions();
		this.setupScrollSpy();

		// Bootstrap: highlight first heading after build
		if (this.entries.length > 0) {
			window.requestAnimationFrame(() => {
				this.onScrollTick();
			});
		}
	}

	private markLeafChevrons(): void {
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;
			const nextEntry = this.entries[i + 1];
			const hasChildren = nextEntry != null && nextEntry.level > entry.level;
			if (!hasChildren) {
				this.chevronEls[i]?.addClass('book-toc-leaf');
			}
		}
	}

	private static GUIDE_POSITIONS = [8, 20, 32, 44, 56, 68];

	private applyNestingGuides(): void {
		if (!this.settings?.tocGuides) return;

		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;

			const ancestorLevels: number[] = [];
			let targetLevel = entry.level - 1;
			for (let j = i - 1; j >= 0 && targetLevel >= 1; j--) {
				const ancestor = this.entries[j];
				if (!ancestor) break;
				if (ancestor.level <= targetLevel) {
					ancestorLevels.push(ancestor.level);
					targetLevel = ancestor.level - 1;
				}
			}

			if (ancestorLevels.length === 0) continue;

			const li = this.headingLis[i];
			if (!li) continue;

			const gradients: string[] = [];
			const positions: string[] = [];
			const sizes: string[] = [];

			for (const level of ancestorLevels) {
				const pos = TocController.GUIDE_POSITIONS[level - 1] ?? 0;
				gradients.push(
					`linear-gradient(to right, color-mix(in srgb, var(--h${level}-color) 70%, transparent) 0.5px, transparent 0.5px)`,
				);
				positions.push(`${pos}px 0`);
				sizes.push('1px 100%');
			}

			li.style.backgroundImage = gradients.join(', ');
			li.style.backgroundPosition = positions.join(', ');
			li.style.backgroundSize = sizes.join(', ');
		}
	}

	// --- Expand / Collapse logic ---

	/** Is entry `i` expanded (showing its children)? */
	private isEntryExpanded(i: number): boolean {
		if (this.activePathSet.has(i)) return true;
		if (this.userExpandedSet.has(i)) return true;
		if (this.userCollapsedSet.has(i)) return false;
		if (this.defaultLevel === 0) return true;
		return (this.entries[i]?.level ?? 0) < this.defaultLevel;
	}

	/** Compute the active path: entry `index` (if it has children) + all ancestors */
	private computeActivePath(index: number): Set<number> {
		const path = new Set<number>();
		const entry = this.entries[index];
		if (!entry) return path;

		// Add current heading if it has children (so its section expands as soon as we arrive)
		const next = this.entries[index + 1];
		if (next && next.level > entry.level) {
			path.add(index);
		}

		let targetLevel = entry.level;
		for (let i = index - 1; i >= 0; i--) {
			const a = this.entries[i];
			if (!a) break;
			if (a.level < targetLevel) {
				path.add(i);
				targetLevel = a.level;
			}
		}
		return path;
	}

	private toggleCollapse(index: number): void {
		const currentlyExpanded = this.isEntryExpanded(index);

		if (currentlyExpanded) {
			this.userCollapsedSet.add(index);
			this.userExpandedSet.delete(index);
		} else {
			this.userCollapsedSet.delete(index);
			this.userExpandedSet.add(index);
		}

		this.applyVisibility();
	}

	private applyVisibility(): void {
		// Phase 1: compute new state
		const willHide: boolean[] = new Array(this.entries.length).fill(false);
		for (let i = 0; i < this.entries.length; i++) {
			let isHidden = false;
			let targetLevel = this.entries[i]?.level ?? 0;
			for (let j = i - 1; j >= 0 && targetLevel >= 1; j--) {
				const ancestor = this.entries[j];
				if (!ancestor) break;
				if (ancestor.level < targetLevel) {
					if (!this.isEntryExpanded(j)) {
						isHidden = true;
						break;
					}
					targetLevel = ancestor.level;
				}
			}
			willHide[i] = isHidden;
		}

		// Phase 2: lock heights for changing items
		const changed: HTMLElement[] = [];
		for (let i = 0; i < this.entries.length; i++) {
			const li = this.headingLis[i];
			if (!li) continue;
			const currentlyHidden = li.hasClass('book-toc-collapsed-hidden');
			if (willHide[i] === currentlyHidden) continue;
			changed.push(li);
			li.style.maxHeight = li.scrollHeight + 'px';
		}

		if (changed.length > 0) void document.body.offsetHeight;

		// Phase 3: toggle class and set target height
		for (let i = 0; i < this.entries.length; i++) {
			const li = this.headingLis[i];
			if (!li) continue;
			if (willHide[i]) {
				li.addClass('book-toc-collapsed-hidden');
			} else {
				li.removeClass('book-toc-collapsed-hidden');
			}
		}

		for (let i = 0; i < this.entries.length; i++) {
			const li = this.headingLis[i];
			if (!li || !changed.includes(li)) continue;
			li.style.maxHeight = willHide[i] ? '0' : li.scrollHeight + 'px';
		}

		// Phase 4: after transition, clear inline max-height for expanded items
		window.clearTimeout(this.animCleanupTimer);
		this.animCleanupTimer = window.setTimeout(() => {
			for (let i = 0; i < this.entries.length; i++) {
				const li = this.headingLis[i];
				if (!li || willHide[i]) continue;
				li.style.maxHeight = '';
			}
		}, 160);

		for (let i = 0; i < this.chevronEls.length; i++) {
			const chevron = this.chevronEls[i];
			if (!chevron) continue;
			if (this.isEntryExpanded(i)) {
				chevron.removeClass('book-toc-chevron-closed');
			} else {
				chevron.addClass('book-toc-chevron-closed');
			}
		}
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

	// --- Scroll spy ---

	private setupScrollSpy(): void {
		if (this.tocItems.length === 0) return;

		this.scrollHandler = () => {
			if (this.scrollRafId) return;
			this.scrollRafId = window.requestAnimationFrame(() => {
				this.scrollRafId = 0;
				this.onScrollTick();
			});
		};

		this.scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true });
	}

	/** Called once per rAF frame on scroll */
	private onScrollTick(): void {
		if (this.isJumping) return;

		this.calculatePositions();

		const scrollTop = this.scrollContainer.scrollTop;
		this.lastScrollTop = scrollTop;

		// find active heading by position
		const viewportHeight = this.scrollContainer.clientHeight;
		const triggerY = scrollTop + viewportHeight * 0.3;
		let bestIndex = -1;
		for (let i = this.headingPositions.length - 1; i >= 0; i--) {
			if ((this.headingPositions[i] ?? 0) <= triggerY) {
				bestIndex = i;
				break;
			}
		}

		if (bestIndex < 0) {
			window.clearTimeout(this.activePathTimer);
			this.pendingPathIndex = -1;
			if (this.activePathSet.size > 0) {
				this.activePathSet.clear();
				this.applyVisibility();
			}
			return;
		}

		this.activeEntryIndex = bestIndex;

		const mode = this.settings?.autoExpandMode ?? 'disabled';

		// Update highlight immediately (tracks scroll in real-time)
		let highlightIndex = bestIndex;
		if (mode === 'disabled') {
			const li = this.headingLis[bestIndex];
			if (li?.hasClass('book-toc-collapsed-hidden')) {
				let targetLevel = this.entries[bestIndex]?.level ?? 0;
				for (let j = bestIndex - 1; j >= 0; j--) {
					const a = this.entries[j];
					if (!a) break;
					if (a.level < targetLevel) {
						const ancLi = this.headingLis[j];
						if (ancLi && !ancLi.hasClass('book-toc-collapsed-hidden')) {
							highlightIndex = j;
							break;
						}
						targetLevel = a.level;
					}
				}
			}
		}
		this.updateHighlight(highlightIndex);

		// Debounce expand/collapse: wait for scroll to settle (30ms)
		if (bestIndex !== this.pendingPathIndex) {
			this.pendingPathIndex = bestIndex;
			window.clearTimeout(this.activePathTimer);
			this.activePathTimer = window.setTimeout(() => {
				this.pendingPathIndex = -1;
				const newPath = mode !== 'disabled'
					? this.computeActivePath(this.activeEntryIndex)
					: new Set<number>();

				if (!this.setsEqual(this.activePathSet, newPath)) {
					this.activePathSet = newPath;
					this.applyVisibility();
				}
			}, 30);
		}

		// Fade highlight indicator after idle
		if (this.highlightEl) {
			this.highlightEl.classList.remove('fading');
		}
		window.clearTimeout(this.fadeTimer);
		window.clearTimeout(this.settleTimer);
		this.fadeTimer = window.setTimeout(() => {
			this.highlightEl?.classList.add('fading');
		}, 400);
		this.settleTimer = window.setTimeout(() => {
			this.correctByDomPositions();
		}, 150);
	}

	private updateHighlight(index: number): void {
		const el = this.tocItems[index];
		if (!el) return;

		if (el !== this.activeHeading) {
			this.activeHeading?.removeClass('is-active');
			el.addClass('is-active');
			this.activeHeading = el;
		}

		if (this.highlightEl) {
			this.highlightEl.style.top = `${el.offsetTop}px`;
			this.highlightEl.style.height = `${el.offsetHeight}px`;
		}
	}

	private correctByDomPositions(): void {
		const mode = this.settings?.autoExpandMode ?? 'disabled';
		if (mode !== 'disabled') return;

		const containerRect = this.scrollContainer.getBoundingClientRect();
		const triggerY = containerRect.top + containerRect.height * 0.3;

		let bestIndex = -1;
		let bestDistance = Infinity;

		const headings = Array.from(this.scrollContainer.querySelectorAll('[data-entry-index]'));
		for (const el of headings) {
			const idx = parseInt(el.getAttribute('data-entry-index') ?? '', 10);
			if (isNaN(idx)) continue;
			const rect = el.getBoundingClientRect();
			const midY = rect.top + rect.height / 2;
			const dist = Math.abs(midY - triggerY);
			if (midY <= triggerY && dist < bestDistance) {
				bestDistance = dist;
				bestIndex = idx;
			}
		}

		if (bestIndex >= 0) {
			// Resolve to visible ancestor if heading is hidden
			const li = this.headingLis[bestIndex];
			if (li?.hasClass('book-toc-collapsed-hidden')) {
				let targetLevel = this.entries[bestIndex]?.level ?? 0;
				for (let j = bestIndex - 1; j >= 0; j--) {
					const a = this.entries[j];
					if (!a) break;
					if (a.level < targetLevel) {
						const ancLi = this.headingLis[j];
						if (ancLi && !ancLi.hasClass('book-toc-collapsed-hidden')) {
							bestIndex = j;
							break;
						}
						targetLevel = a.level;
					}
				}
			}
			this.updateHighlight(bestIndex);
		}
	}

	async scrollToHeading(entryIndex: number): Promise<void> {
		const entry = this.entries[entryIndex];
		if (!entry || !this.absoluteManager) return;

		this.navigating = true;
		this.isJumping = true;
		try {
			const sectionOffset = this.absoluteManager.getOffset(entry.file.path);
			const estimatedY = sectionOffset + entry.line * HEIGHT_PER_LINE;

			this.scrollContainer.scrollTo({ top: Math.max(0, estimatedY - 20), behavior: 'auto' });

			const placeholder = this.scrollContainer.querySelector(
				`.book-section-placeholder[data-path="${entry.file.path}"]`,
			);
			if (!(placeholder instanceof HTMLElement)) return;

			let targetHeading: Element | null = null;
			for (let attempt = 0; attempt < 30; attempt++) {
				const headings = placeholder.querySelectorAll('h1, h2, h3, h4, h5, h6');
				targetHeading = headings[entry.fileHeadingIndex] ?? null;
				if (targetHeading) break;
				await new Promise<void>((resolve) =>
					window.requestAnimationFrame(() => resolve()),
				);
			}

			if (targetHeading) {
				const headingRect = targetHeading.getBoundingClientRect();
				const containerRect = this.scrollContainer.getBoundingClientRect();
				const correctedScroll =
					this.scrollContainer.scrollTop +
					(headingRect.top - containerRect.top) -
					20;
				this.scrollContainer.scrollTo({
					top: correctedScroll,
					behavior: 'auto',
				});
				this.highlightHeading(targetHeading as HTMLElement);
			}

			this.calculatePositions();
			this.updateHighlight(entryIndex);

			// Apply auto-expand for the clicked heading
			const mode = this.settings?.autoExpandMode ?? 'disabled';
			if (mode !== 'disabled') {
				this.activePathSet = this.computeActivePath(entryIndex);
				this.applyVisibility();
			}
		} finally {
			window.clearTimeout(this.navigationTimer);
			this.navigationTimer = window.setTimeout(() => {
				this.navigating = false;
				this.isJumping = false;
			}, 200);
		}
	}

	private highlightHeading(el: HTMLElement): void {
		el.addClass('book-heading-highlight');
		const handler = () => {
			el.removeClass('book-heading-highlight');
			el.removeEventListener('animationend', handler);
		};
		el.addEventListener('animationend', handler);
	}

	private setsEqual(a: Set<number>, b: Set<number>): boolean {
		if (a.size !== b.size) return false;
		for (const v of a) {
			if (!b.has(v)) return false;
		}
		return true;
	}

	destroy(): void {
		if (this.scrollRafId) {
			window.cancelAnimationFrame(this.scrollRafId);
			this.scrollRafId = 0;
		}
		if (this.scrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		window.clearTimeout(this.fadeTimer);
		window.clearTimeout(this.settleTimer);
		window.clearTimeout(this.navigationTimer);
		window.clearTimeout(this.activePathTimer);
		window.clearTimeout(this.animCleanupTimer);
		this.highlightEl = null;
		this.activeHeading = null;
		this.entries = [];
		this.tocItems = [];
		this.headingLis = [];
		this.chevronEls = [];
		this.headingPositions = [];
		this.userCollapsedSet.clear();
		this.userExpandedSet.clear();
		this.activePathSet.clear();
	}
}
