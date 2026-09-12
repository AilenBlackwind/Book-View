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

	/** Recompute nesting-guide colors (css identity change). */
	refreshGuides(): void {
		this.builder.refreshGuides();
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

	/** Rebuild the entries and rows after a book file's headings changed
	 *  (markDirty re-renders the section itself).
	 *
	 *  Originally this destroyed and re-mounted the row window — a full
	 *  tear-down of the shadow DOM + an incremental refill (16 rows/rAF), which
	 *  on a big ToC read as "the ToC just disappeared" on every heading edit.
	 *  Now the window stays mounted: only the data layer and the tracking /
	 *  measurement subscriptions (which reference old entries and positions)
	 *  are rebuilt, then the existing row window is re-rendered in place, with
	 *  rows patched by data-index through the builder's in-place update paths. */
	rebuild(): void {
		this.measurer.destroy();
		this.spy.destroy();
		this.state.resetForBuild();
		this.builder.build();

		// The panel kept its scrollTop through the data rebuild. If the edit
		// added/removed headings above the current view, the total height
		// changed and the cached position can sit past the new end; clamp it
		// (and the container) before the window re-renders, mirroring
		// applyVisibility, so render() never computes an out-of-range window.
		const s = this.state;
		const viewport = s.tocViewportHeight > 0 ? s.tocViewportHeight : s.containerEl.clientHeight;
		const total = s.virtualOffsets[s.virtualOffsets.length - 1] ?? 0;
		const max = Math.max(0, total - viewport);
		if (s.panelScrollTop > max) {
			s.panelScrollTop = max;
			s.containerEl.scrollTop = max;
		}

		// NOTE: window.setup() is intentionally NOT called here. The window
		// was never destroyed, so its scroll/click handlers and debug probe
		// are still installed; calling setup() again would double-bind the
		// panel scroll listener. render() re-renders the visible window and
		// re-uses existing rows by data-index.
		this.window.render();
		this.spy.calculatePositions();
		if (s.entries.length === 0) return;
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
