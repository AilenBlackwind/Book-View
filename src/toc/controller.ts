import type { App, TFile } from 'obsidian';
import type { BookViewSettings } from '../settings';
import type { AbsoluteSectionManager } from '../components/AbsoluteSectionManager';
import { TocState } from './state';
import { TocBuilder } from './builder';
import { TocSpy } from './spy';
import { TocMeasurer } from './measure';
import { TocNavigator } from './navigation';
import type { TocEntry } from './entries';

export type { TocEntry } from './entries';

/**
 * Thin orchestrator for the table of contents. Owns the shared TocState and
 * wires the dedicated modules — builder (DOM), state (expand/collapse),
 * measurer (heading offsets), spy (scroll tracking), navigator (click jumps).
 */
export class TocController {
	private state: TocState;
	private builder: TocBuilder;
	private spy: TocSpy;
	private measurer: TocMeasurer;
	private navigator: TocNavigator;

	constructor(
		containerEl: HTMLElement,
		files: TFile[],
		app: App,
		scrollContainer: HTMLElement,
		settings: BookViewSettings | null,
		absoluteManager: AbsoluteSectionManager | null,
	) {
		this.state = new TocState(containerEl, files, app, scrollContainer, settings, absoluteManager);
		this.measurer = new TocMeasurer(this.state);
		this.spy = new TocSpy(this.state);
		this.navigator = new TocNavigator(this.state, this.spy);
		this.builder = new TocBuilder(this.state, this.navigator);
	}

	getEntries(): TocEntry[] {
		return this.state.entries;
	}

	build(): void {
		this.destroy();
		this.builder.build();
		this.state.applyVisibility();
		this.spy.calculatePositions();
		if (this.state.tocItems.length === 0) return;
		this.measurer.setup();
		this.spy.setup();
	}

	/** Tag a freshly mounted section's headings; rect reads are deferred to
	 *  the shared manager frame (see TocMeasurer). */
	tagHeadings(path: string, container: HTMLElement): void {
		this.measurer.tagHeadings(path, container);
	}

	invalidatePath(path: string): void {
		this.measurer.invalidatePath(path);
	}

	destroy(): void {
		this.measurer.destroy();
		this.spy.destroy();
		this.navigator.destroy();
		this.state.clearData();
	}
}
