import type { App, TFile } from 'obsidian';
import type { TocSettings, HeadingPositionSource } from './types';
import { TocState } from './state';
import { TocBuilder } from './builder';
import { TocWindow } from './window';
import { TocSpy } from './spy';
import { TocMeasurer } from './measure';
import { TocNavigator } from './navigation';
import type { TocEntry } from './entries';

export type { TocEntry } from './entries';

/**
 * Thin orchestrator for the table of contents. Owns the shared TocState and
 * wires the dedicated modules — builder (data + row factories), window
 * (virtualized row rendering), state (expand/collapse), measurer (heading
 * offsets), spy (scroll tracking), navigator (click jumps).
 */
export class TocController {
	private state: TocState;
	private builder: TocBuilder;
	private window: TocWindow;
	private spy: TocSpy;
	private measurer: TocMeasurer;
	private navigator: TocNavigator;

	constructor(
		containerEl: HTMLElement,
		files: TFile[],
		app: App,
		scrollContainer: HTMLElement,
		settings: TocSettings | null,
		positionSource: HeadingPositionSource | null,
	) {
		this.state = new TocState(containerEl, files, app, scrollContainer, settings, positionSource);
		this.measurer = new TocMeasurer(this.state);
		this.spy = new TocSpy(this.state);
		this.navigator = new TocNavigator(this.state, this.spy);
		this.builder = new TocBuilder(this.state, this.navigator);
		this.window = new TocWindow(this.state, this.builder);
		this.state.onVisibilityGain = () => this.builder.remeasure();
		this.state.window = this.window;
		// A window render re-creates the row elements; re-apply the highlight so
		// the pill is re-hosted into the active row instead of a detached one.
		this.window.onRowsRendered = () => this.spy.reapplyHighlight();
	}

	getEntries(): TocEntry[] {
		return this.state.entries;
	}

	build(): void {
		this.destroy();
		this.builder.build();
		this.window.mount();
		this.window.setup();
		this.spy.calculatePositions();
		if (this.state.entries.length === 0) return;
		this.measurer.setup();
		this.spy.setup();
	}

	/** Rebuild the entries and rows from the current metadata cache without
	 *  destroying the controller or wiping the panel DOM. Used when a book
	 *  file's headings changed (markDirty re-renders the section itself). A
	 *  full bind/unbind wipe-and-rebuild is the ToC flicker source during mass
	 *  edits; this keeps the panel mounted and only swaps the data + rows. */
	rebuild(): void {
		this.window.destroy();
		this.measurer.destroy();
		this.spy.destroy();
		this.state.resetForBuild();
		this.builder.build();
		this.window.mount();
		this.window.setup();
		this.spy.calculatePositions();
		if (this.state.entries.length === 0) return;
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
		this.window.destroy();
		this.measurer.destroy();
		this.spy.destroy();
		this.navigator.destroy();
		this.state.clearData();
	}
}
