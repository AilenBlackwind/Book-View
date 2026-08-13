import { setIcon } from 'obsidian';
import { TocState } from './state';
import { TocEntry, buildTocEntries, buildEntryByPathLine } from './entries';
import { renderHeadingLabel } from './dom';
import type { TocNavigator } from './navigation';

/** Builds the ToC DOM (file wrappers, heading rows, chevrons, nesting guides,
 *  highlight bar) from the flattened entry list. */
export class TocBuilder {
	private static GUIDE_POSITIONS = [8, 20, 32, 44, 56, 68];

	constructor(private state: TocState, private navigator: TocNavigator) {}

	build(): void {
		const s = this.state;
		s.containerEl.empty();

		const tocEl = s.containerEl.createDiv({ cls: 'book-toc' });
		if (s.settings?.tocGuides) {
			tocEl.addClass('book-toc-guides');
		}
		const listEl = tocEl.createEl('ul', { cls: 'book-toc-list' });

		// Entries are the single source of truth; group them back by file so
		// the optional file wrapper (tocShowFileNames) can be built around them.
		const byFile = new Map<string, TocEntry[]>();
		for (const entry of buildTocEntries(s.app, s.files)) {
			const list = byFile.get(entry.file.path);
			if (list) {
				list.push(entry);
			} else {
				byFile.set(entry.file.path, [entry]);
			}
		}

		for (const file of s.files) {
			const fileEntries = byFile.get(file.path);
			if (!fileEntries || fileEntries.length === 0) continue;

			if (s.settings?.tocShowFileNames) {
				const fileHeading = listEl.createEl('li', { cls: 'book-toc-file' });
				fileHeading.createDiv({
					cls: 'book-toc-file-title',
					text: file.basename,
				});
				const subList = fileHeading.createEl('ul', { cls: 'book-toc-file-headings' });
				for (const entry of fileEntries) {
					s.entries.push(entry);
					this.createHeadingItem(subList, entry);
				}
			} else {
				for (const entry of fileEntries) {
					s.entries.push(entry);
					this.createHeadingItem(listEl, entry);
				}
			}
		}

		s.containerEl.addClass('book-toc-relative');
		s.highlightEl = s.containerEl.createDiv({ cls: 'book-toc-highlight' });

		s.entryByPathLine = buildEntryByPathLine(s.entries);

		if (s.settings?.tocActiveColor) {
			s.containerEl.style.setProperty('--bv-toc-active-color', s.settings.tocActiveColor);
		}

		this.markLeafChevrons();
		this.applyNestingGuides();
	}

	private createHeadingItem(parent: HTMLElement, entry: TocEntry): void {
		const s = this.state;
		const li = parent.createEl('li', { cls: 'book-toc-heading' });
		li.style.paddingLeft = `${(entry.level - 1) * 12}px`;
		li.dataset.level = String(entry.level);

		// Inner wrapper for grid row animation
		const inner = li.createDiv({ cls: 'book-toc-heading-inner' });

		const chevron = inner.createSpan({ cls: 'book-toc-chevron' });
		setIcon(chevron, 'chevron-right');
		const entryIdx = s.entries.length - 1;
		s.chevronEls.push(chevron);
		chevron.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			s.toggleCollapse(entryIdx);
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

		s.headingLis.push(li);
		s.tocItems.push(a);
		a.addEventListener('click', (evt) => {
			evt.preventDefault();
			void this.navigator.scrollToHeading(entryIdx);
		});
	}

	private markLeafChevrons(): void {
		const s = this.state;
		for (let i = 0; i < s.entries.length; i++) {
			const entry = s.entries[i];
			if (!entry) continue;
			const nextEntry = s.entries[i + 1];
			const hasChildren = nextEntry != null && nextEntry.level > entry.level;
			if (!hasChildren) {
				s.chevronEls[i]?.addClass('book-toc-leaf');
			}
		}
	}

	private applyNestingGuides(): void {
		const s = this.state;
		if (!s.settings?.tocGuides) return;

		for (let i = 0; i < s.entries.length; i++) {
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

			const li = s.headingLis[i];
			if (!li) continue;

			const gradients: string[] = [];
			const positions: string[] = [];
			const sizes: string[] = [];

			for (const level of ancestorLevels) {
				const pos = TocBuilder.GUIDE_POSITIONS[level - 1] ?? 0;
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
}
