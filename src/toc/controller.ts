import type { App, TFile } from 'obsidian';
import type { TocSettings, HeadingPositionSource } from './types';
import { TocState } from './state';
import { TocBuilder } from './builder';
import { TocWindow } from './window';
import { TocSpy } from './spy';
import { TocMeasurer } from './measure';
import { TocNavigator } from './navigation';
import { DebugLog } from '../utils/debug';
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
		// Per-note ToC snapshot for the debug dump (the --- ToC --- section):
		// ToC bugs that reproduce only in one note have no per-note context in
		// a chronological log otherwise. The last open book wins — mirrors the
		// single active ToC panel.
		DebugLog.registerTocProvider(() => this.tocDebugSnapshot());
	}

	/** Per-note context for the debug dump. Keys for the classes of ToC bugs
	 *  found so far: index/position count mismatches (the spy silently reading
	 *  stale positions), a stuck isJumping flag (the freeze-to-reopen bug),
	 *  and malformed heading structure — repeated consecutive heading texts
	 *  and a non-heading file start — for one-note-repro bugs (usually an
	 *  edit swapped ~100 headings in). Deliberately a single joined string:
	 *  the dump section is one paste. */
	private tocDebugSnapshot(): string {
		const s = this.state;
		const lines: string[] = [];
		const book = s.files[0] ?? null;
		const posAge = s.positionsStableSince > 0 ? Math.round(performance.now() - s.positionsStableSince) : -1;
		lines.push(
			`book=${book ? book.basename : '?'} files=${s.files.length} entries=${s.entries.length} positions=${s.headingPositions.length} posAge=${posAge}ms`,
		);
		const jumpAge = s.isJumpingSince > 0 ? Math.round(performance.now() - s.isJumpingSince) : 0;
		lines.push(`active=${s.activeEntryIndex} isJumping=${s.isJumping} jumpAge=${jumpAge}ms`);
		let repeated = 0;
		for (let i = 1; i < s.entries.length; i++) {
			const cur = s.entries[i];
			const prev = s.entries[i - 1];
			if (cur && prev && cur.text === prev.text) repeated++;
		}
		const first = s.entries[0];
		const last = s.entries[s.entries.length - 1];
		lines.push(
			`first=[${first ? first.file.basename + ':' + first.line + ' ' + first.text : '?'}] last=[${last ? last.file.basename + ':' + last.line + ' ' + last.text : '?'}] repeated-text=${repeated}`,
		);
		return lines.join('\n');
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
		// re-uses existing rows by data-index. The spy teardown above nulled
		// the highlight host/pill, so re-point them before the render fires
		// onRowsRendered → reapplyHighlight → movePill again.
		this.window.restoreHighlightHost();
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
		DebugLog.registerTocProvider(null);
		this.window.destroy();
		this.measurer.destroy();
		this.spy.destroy();
		this.navigator.destroy();
		this.state.clearData();
	}
}
