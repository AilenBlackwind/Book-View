import { Component, Menu, Notice, type App, type TFile } from 'obsidian';
import type { TocEntry } from './entries';
import { readTocSection } from './section';

/** One delegated listener survives virtual row recycling and outline rebuilds. */
export class TocSectionMenu extends Component {
	private menu: Menu | null = null;

	constructor(
		private containerEl: HTMLElement,
		private app: App,
		private files: TFile[],
		private getEntries: () => TocEntry[],
	) {
		super();
	}

	onload(): void {
		this.registerDomEvent(this.containerEl, 'contextmenu', (event) => {
			// composedPath reaches heading rows inside the ToC's shadow root.
			const elementType = (this.containerEl.win as Window & { HTMLElement: typeof HTMLElement }).HTMLElement;
			const row = event.composedPath().find((node): node is HTMLElement =>
				node instanceof elementType && node.matches('li.bv-toc-heading[data-index]'),
			);
			if (!row) return;
			const entry = this.getEntries()[Number(row.dataset.index)];
			if (!entry) return;
			event.preventDefault();
			event.stopPropagation();
			this.menu?.hide();
			this.menu = new Menu();
			this.menu.addItem((item) => item
				.setTitle('Copy section')
				.setIcon('copy')
				.onClick(async () => {
					try {
						const text = await readTocSection(this.app, this.files, entry);
						await this.containerEl.win.navigator.clipboard.writeText(text);
						new Notice('Section copied to clipboard.');
					} catch (error) {
						new Notice(`Could not copy section: ${error instanceof Error ? error.message : String(error)}`);
					}
				}));
			this.menu.showAtMouseEvent(event);
		});
	}

	onunload(): void {
		this.menu?.hide();
		this.menu = null;
	}
}
