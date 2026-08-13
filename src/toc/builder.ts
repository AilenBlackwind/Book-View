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
	constructor(private state: TocState, private navigator: TocNavigator) {}

	build(): void {
		const s = this.state;
		s.entries = buildTocEntries(s.app, s.files);
		s.entryByPathLine = buildEntryByPathLine(s.entries);
		s.defaultLevel = s.settings?.tocCollapsedLevel ?? 0;

		s.containerEl.addClass('book-toc-relative');
		if (s.settings?.tocActiveColor) {
			s.containerEl.style.setProperty('--bv-toc-active-color', s.settings.tocActiveColor);
		}

		this.measureRowHeights();
		this.computeIsLeaf();
		this.computeGuideStyles();
		s.rebuildVirtualData();
	}

	/** Create a file-title row. The row height is fixed (see CSS), so the
	 *  virtual offsets computed at build time stay exact. */
	createFileRow(listEl: HTMLElement, file: TFile): HTMLElement {
		const li = listEl.createEl('li', { cls: 'book-toc-file' });
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

		const inner = li.createDiv({ cls: 'book-toc-heading-inner' });

		// CSS-drawn chevron (no SVG setIcon): the span is only a click target.
		const chevron = inner.createSpan({ cls: 'book-toc-chevron' });
		chevron.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			s.toggleCollapse(entryIndex);
		});

		const a = inner.createEl('a', {
			cls: 'book-toc-item',
			attr: {
				'data-path': entry.file.path,
				'data-line': String(entry.line),
				'data-level': String(entry.level),
			},
		});
		renderHeadingLabel(a, entry.text, s.settings?.tocRenderMarkdown ?? false);
		a.addEventListener('click', (evt) => {
			evt.preventDefault();
			void this.navigator.scrollToHeading(entryIndex);
		});

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

	/** Measure the fixed row heights (heading row + file row) from a probe
	 *  appended to the connected panel, so the virtual offsets match the real
	 *  rendered rows. */
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

		s.rowHeight = li.offsetHeight || 24;
		s.fileRowHeight = fileLi.offsetHeight || 24;
		probe.remove();
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
					`linear-gradient(to right, color-mix(in srgb, var(--h${level}-color) 70%, transparent) 0.5px, transparent 0.5px)`,
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
