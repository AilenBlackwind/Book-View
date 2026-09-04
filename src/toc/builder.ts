import { TFile } from 'obsidian';
import { TocState } from './state';
import { buildTocEntries, buildEntryByPathLine, TocEntry } from './entries';
import { renderHeadingLabel } from './dom';
import type { GuideStyle } from './state';
import type { TocNavigator } from './navigation';

/** Fixed x-offset of the nesting guide for each ancestor level. */
const GUIDE_POSITIONS = [8, 20, 32, 44, 56, 68];

/**
 * Builds the ToC *data* (flattened entries, virtual list, row heights, per-entry
 * leaf/guide info) and provides the row factories the virtual window uses to
 * create heading/file rows on demand. The old approach built every row up front
 * and animated collapse via max-height; with virtualization the panel renders
 * only the visible window, so there are no eternal DOM arrays.
 */
export class TocBuilder {
	/** Rendered label span per entry, cached so a row-window rebuild clones the
	 *  label (cheap) instead of re-parsing the heading markdown through a
	 *  DOMParser for every re-created row. Populated on first render; keyed by
	 *  entry index, reset when the builder is re-created for a new book. */
	private labelCache = new Map<number, HTMLElement>();
	/** The tocRenderMarkdown mode the cache was built with; a settings toggle
	 *  mid-session clears the cache so rebuilt rows use the new mode instead of
	 *  cloning labels parsed under the old one. */
	private cachedMarkdownMode: boolean | null = null;

	constructor(private state: TocState, private navigator: TocNavigator) {}

	build(): void {
		const s = this.state;
		this.labelCache.clear();
		s.entries = buildTocEntries(s.app, s.files);
		s.entryByPathLine = buildEntryByPathLine(s.entries);
		s.defaultLevel = s.settings?.tocCollapsedLevel ?? 0;
		s.autoCollapseRestLevel = s.settings?.tocCollapseRestLevel ?? 0;
		s.visitedSet.clear();

		s.containerEl.addClass('book-toc-relative');
		s.tocPaddingTop = parseFloat(getComputedStyle(s.containerEl).paddingTop) || 0;

		this.measureRowHeights();
		this.computeIsLeaf();
		this.computeGuideStyles();
		s.rebuildVirtualData();
	}

	/** Create a file-title row. The row height is fixed (see CSS), so the
	 *  virtual offsets computed at build time stay exact. */
	createFileRow(listEl: HTMLElement, index: number, file: TFile): HTMLElement {
		const li = listEl.createEl('li', { cls: 'book-toc-file' });
		li.dataset.index = String(index);
		li.createDiv({ cls: 'book-toc-file-title', text: file.basename });
		return li;
	}

	/** Create a heading row. Returns the li + the clickable anchor (the spy
	 *  highlights via the anchor; the window registers both in its row maps). */
	createHeadingRow(listEl: HTMLElement, entryIndex: number, entry: TocEntry): { li: HTMLElement; a: HTMLElement } {
		const s = this.state;
		const li = listEl.createEl('li', { cls: 'book-toc-heading' });
		li.style.paddingLeft = `${(entry.level - 1) * 12}px`;
		li.dataset.level = String(entry.level);
		li.dataset.index = String(entryIndex);

		const inner = li.createDiv({ cls: 'book-toc-heading-inner' });

		// Inline SVG chevron: currentColor inherits the row's text color and the
		// glyph is centered in its box, so rotating it between the open (down)
		// and collapsed (right) states turns it in place — the old border-L
		// pseudo element had its optical center ~2px off the box center, which
		// made it sit crooked against the heading text and shift when rotated.
		// Orientation matches the book's fold chevrons: open points down.
		const chevron = inner.createSpan({ cls: 'book-toc-chevron' });
		const chevronSvg = chevron.createSvg('svg', { attr: { viewBox: '0 0 16 16' } });
		chevronSvg.createSvg('path', {
			attr: {
				d: 'M5 4l4 4-4 4',
				fill: 'none',
				stroke: 'currentColor',
				'stroke-width': '2',
				'stroke-linecap': 'round',
				'stroke-linejoin': 'round',
			},
		});

		const a = inner.createEl('a', {
			cls: 'book-toc-item',
			attr: {
				'data-path': entry.file.path,
				'data-line': String(entry.line),
				'data-level': String(entry.level),
			},
		});
		const renderMarkdown = s.settings?.tocRenderMarkdown ?? false;
		if (this.cachedMarkdownMode !== renderMarkdown) {
			this.labelCache.clear();
			this.cachedMarkdownMode = renderMarkdown;
		}
		let label = this.labelCache.get(entryIndex);
		if (label) {
			a.appendChild(label.cloneNode(true));
		} else {
			label = renderHeadingLabel(a, entry.text, renderMarkdown);
			this.labelCache.set(entryIndex, label);
		}

		if (s.isLeaf[entryIndex]) {
			li.addClass('book-toc-leaf');
		} else if (!s.isEntryExpanded(entryIndex)) {
			li.addClass('book-toc-collapsed');
		}

		const guide = s.guideStyles[entryIndex];
		if (guide) {
			li.style.backgroundImage = guide.image;
			li.style.backgroundPosition = guide.position;
			li.style.backgroundSize = guide.size;
		}

		return { li, a };
	}

	/** Update an existing heading <li> in place instead of re-creating it.
	 *  Reuses the inner wrapper + chevron + anchor and only patches what
	 *  changes (data, padding, classes, guide background, label), so a
	 *  path/visibility change touches the same DOM nodes instead of tearing
	 *  them down — far fewer elements invalidated during forced reflow. */
	updateHeadingRow(li: HTMLElement, entryIndex: number, entry: TocEntry): HTMLElement {
		const s = this.state;

		// Dirty-check: when the row already shows this exact entry in this
		// exact state, nothing changed (label is keyed by entryIndex and the
		// guide is immutable per entry). Touching the DOM here is what forced
		// a style recalculation on every wheel tick, so skip all mutations.
		const leafNow = !!s.isLeaf[entryIndex];
		const collNow = !leafNow && !s.isEntryExpanded(entryIndex);
		const hasLeaf = li.classList.contains('book-toc-leaf');
		const hasColl = li.classList.contains('book-toc-collapsed');
		if (li.dataset.index === String(entryIndex) && li.dataset.level === String(entry.level) && hasLeaf === leafNow && hasColl === collNow) {
			return li.querySelector<HTMLElement>('a.book-toc-item')!;
		}

		li.style.paddingLeft = `${(entry.level - 1) * 12}px`;
		li.dataset.level = String(entry.level);
		li.dataset.index = String(entryIndex);
		li.addClass('book-toc-heading');

		let inner = li.querySelector<HTMLElement>('.book-toc-heading-inner');
		if (!inner) {
			inner = li.createDiv({ cls: 'book-toc-heading-inner' });
			const chevron = inner.createSpan({ cls: 'book-toc-chevron' });
			const chevronSvg = chevron.createSvg('svg', { attr: { viewBox: '0 0 16 16' } });
			chevronSvg.createSvg('path', {
				attr: {
					d: 'M5 4l4 4-4 4',
					fill: 'none',
					stroke: 'currentColor',
					'stroke-width': '2',
					'stroke-linecap': 'round',
					'stroke-linejoin': 'round',
				},
			});
		}

		let a = inner.querySelector<HTMLElement>('a.book-toc-item');
		if (!a) {
			a = inner.createEl('a', { cls: 'book-toc-item' });
		}
		a.setAttribute('data-path', entry.file.path);
		a.setAttribute('data-line', String(entry.line));
		a.setAttribute('data-level', String(entry.level));

		const renderMarkdown = s.settings?.tocRenderMarkdown ?? false;
		if (this.cachedMarkdownMode !== renderMarkdown) {
			this.labelCache.clear();
			this.cachedMarkdownMode = renderMarkdown;
		}
		let label = this.labelCache.get(entryIndex);
		if (label) {
			a.empty();
			a.appendChild(label.cloneNode(true));
		} else {
			a.empty();
			label = renderHeadingLabel(a, entry.text, renderMarkdown);
			this.labelCache.set(entryIndex, label);
		}

		// Reset then re-apply per-entry state classes.
		li.removeClass('book-toc-leaf');
		li.removeClass('book-toc-collapsed');
		if (s.isLeaf[entryIndex]) {
			li.addClass('book-toc-leaf');
		} else if (!s.isEntryExpanded(entryIndex)) {
			li.addClass('book-toc-collapsed');
		}

		// Reset then re-apply the nesting-guide background.
		const guide = s.guideStyles[entryIndex];
		li.style.backgroundImage = guide ? guide.image : '';
		li.style.backgroundPosition = guide ? guide.position : '';
		li.style.backgroundSize = guide ? guide.size : '';

		return a;
	}

	/** Update an existing file-title <li> in place (see updateHeadingRow). */
	updateFileRow(li: HTMLElement, index: number, file: TFile): void {
		li.addClass('book-toc-file');
		li.dataset.index = String(index);
		let title = li.querySelector<HTMLElement>('.book-toc-file-title');
		if (!title) {
			title = li.createDiv({ cls: 'book-toc-file-title' });
		}
		title.setText(file.basename);
	}

	/** Delegated click handler installed once on the listEl (see TocWindow).
	 *  Rows themselves carry no listeners, so recycling / re-creating <li>s
	 *  can never leak or double-bind handlers. */
	handleRowClick(evt: MouseEvent): void {
		const s = this.state;
		const target = evt.target as HTMLElement;

		// Chevron toggles collapse/expand without navigating.
		const chevron = target.closest<HTMLElement>('.book-toc-chevron');
		if (chevron) {
			evt.preventDefault();
			evt.stopPropagation();
			const li = chevron.closest<HTMLElement>('li[data-index]');
			if (li) {
				s.toggleCollapse(Number(li.dataset.index));
			}
			return;
		}

		// Anchor navigates to the heading.
		const a = target.closest<HTMLElement>('a.book-toc-item');
		if (a) {
			evt.preventDefault();
			const li = a.closest<HTMLElement>('li[data-index]');
			if (li) {
				void this.navigator.scrollToHeading(Number(li.dataset.index));
			}
		}
	}

	/** Measure the fixed row heights (heading row + file row) from a probe
	 *  appended to the connected panel, so the virtual offsets match the real
	 *  rendered rows. The probe can measure nothing (0) while the panel has no
	 *  layout (sidebar hidden at bind); remeasure() re-runs it on visibility. */
	private measureRowHeights(): void {
		const s = this.state;
		const probe = s.containerEl.createDiv({ cls: 'book-toc-list' });
	
		const li = probe.createEl('li', { cls: 'book-toc-heading' });
		const inner = li.createDiv({ cls: 'book-toc-heading-inner' });
		inner.createSpan({ cls: 'book-toc-chevron' });
		const a = inner.createEl('a', { cls: 'book-toc-item' });
		a.createSpan({ text: 'X' });

		const fileLi = probe.createEl('li', { cls: 'book-toc-file' });
		fileLi.createDiv({ cls: 'book-toc-file-title', text: 'X' });

		const headingH = li.offsetHeight;
		const fileH = fileLi.offsetHeight;
		s.rowHeight = headingH || 26;
		s.fileRowHeight = fileH || 34;
		s.rowHeightValid = headingH > 0 && fileH > 0;
		probe.remove();
	}

	/** Re-run the height probe once the panel has layout (sidebar opened after
	 *  bind). No-op while the panel is still unhit; rebuilds the virtual data
	 *  so offsets match the real rows instead of the fallback heights. */
	remeasure(): void {
		const s = this.state;
		if (s.containerEl.clientHeight <= 0) return;
		this.measureRowHeights();
		if (!s.rowHeightValid) return;
		s.rebuildVirtualData();
		s.window?.render();
	}

	/** Per-entry leaf flag: an entry is a leaf when no deeper heading follows. */
	private computeIsLeaf(): void {
		const s = this.state;
		const n = s.entries.length;
		s.isLeaf = new Array<boolean>(n);
		for (let i = 0; i < n; i++) {
			const entry = s.entries[i];
			if (!entry) continue;
			const next = s.entries[i + 1];
			s.isLeaf[i] = !(next && next.level > entry.level);
		}
	}

	/** Per-entry nesting-guide background (one CSS linear-gradient per visible
	 *  ancestor), applied to the row when the window creates it. */
	private computeGuideStyles(): void {
		const s = this.state;
		const n = s.entries.length;
		s.guideStyles = new Array<GuideStyle | null>(n).fill(null);
		if (!s.settings?.tocGuides) return;

		for (let i = 0; i < n; i++) {
			const entry = s.entries[i];
			if (!entry) continue;

			const ancestorLevels: number[] = [];
			let targetLevel = entry.level - 1;
			for (let j = i - 1; j >= 0 && targetLevel >= 1; j--) {
				const ancestor = s.entries[j];
				if (!ancestor) break;
				if (ancestor.level <= targetLevel) {
					ancestorLevels.push(ancestor.level);
					targetLevel = ancestor.level - 1;
				}
			}
			if (ancestorLevels.length === 0) continue;

			const gradients: string[] = [];
			const positions: string[] = [];
			const sizes: string[] = [];
			for (const level of ancestorLevels) {
				const pos = GUIDE_POSITIONS[level - 1] ?? 0;
				gradients.push(
					`linear-gradient(to right, color-mix(in srgb, var(--h${level}-color) 70%, transparent) 1px, transparent 1px)`,
				);
				positions.push(`${pos}px 0`);
				sizes.push('1px 100%');
			}
			s.guideStyles[i] = {
				image: gradients.join(', '),
				position: positions.join(', '),
				size: sizes.join(', '),
			};
		}
	}
}
