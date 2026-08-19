import type { App, TFile } from 'obsidian';
import type { TocSettings, HeadingPositionSource } from './types';
import type { TocEntry } from './entries';
import type { TocWindow } from './window';
import type { VirtualItem } from './virtual';
import { computeActivePath, computeHiddenState } from '../utils/toc';
import { buildVirtualItems, computeVirtualOffsets } from './virtual';

/** One deferred heading-rect measurement queued by tagHeadings. */
export interface PendingTagHeading {
	el: HTMLElement;
	tocIndex: number;
}

/** A section whose pending measurements are drained in the tag frame. */
export interface PendingTagSection {
	sectionEl: HTMLElement;
	toMeasure: PendingTagHeading[];
}

/** Per-entry nesting-guide background (one CSS background per ancestor). */
export interface GuideStyle {
	image: string;
	position: string;
	size: string;
}

/**
 * All mutable ToC state plus the pure expand/collapse and virtual-list logic.
 * The builder/window/spy/measure/navigation modules only operate on this
 * object, so the controller stays a thin orchestrator.
 */
export class TocState {
	containerEl: HTMLElement;
	files: TFile[];
	app: App;
	scrollContainer: HTMLElement;
	settings: TocSettings | null;
	positionSource: HeadingPositionSource | null;

	entries: TocEntry[] = [];
	/** Window renderer; set by the controller. */
	window: TocWindow | null = null;
	activeHeading: HTMLElement | null = null;
	/** Lookup from `${path}#${line}` to ToC entry index (built once per build). */
	entryByPathLine: Map<string, number> = new Map();
	/** Measured y-offset of each entry's heading within its section, in spacer
	 *  coordinates relative to the section top. Unknown (unloaded / fold-hidden)
	 *  entries fall back to the line-based estimate. */
	headingOffsets: Map<number, number> = new Map();

	// --- Virtual list (see src/toc/virtual.ts) ---
	virtualItems: VirtualItem[] = [];
	/** Cumulative top offset per item; last element = total height. */
	virtualOffsets: number[] = [0];
	/** Parallel to entries: virtual item index of a visible heading, -1 when
	 *  hidden (collapsed) or absent. */
	entryToItem: number[] = [];
	/** true when every heading is hidden (e.g. fully collapsed); the spy skips
	 *  highlight/centering and the window renders an empty spacer. */
	allRowsHidden = false;
	rowHeight = 0;
	fileRowHeight = 0;
	/** false while the row-height probe measured nothing (panel not laid out
	 *  yet, e.g. the sidebar was hidden at bind); the panel re-measures on
	 *  first visibility instead of trusting a fallback height. */
	rowHeightValid = false;
	/** Set by the controller: called when the panel first becomes visible so
	 *  the row-height probe can be re-run against a laid-out panel. */
	onVisibilityGain: (() => void) | null = null;
	/** Top padding of the panel scroll container (px). Rows render inside the
	 *  content box, so keepActiveInView compensates for it when pinning to the
	 *  edges; otherwise the top/bottom gaps would differ by the padding. */
	tocPaddingTop = 0;
	/** Per-entry leaf flag (no child heading follows). */
	isLeaf: boolean[] = [];
	/** Per-entry nesting-guide background, null when the entry has no guides. */
	guideStyles: (GuideStyle | null)[] = [];
	/** Live row elements of the current window, keyed by entry index. */
	rowByEntry: Map<number, HTMLElement> = new Map();
	rowAnchorByEntry: Map<number, HTMLElement> = new Map();

	// --- Expand/collapse state ---
	userCollapsedSet: Set<number> = new Set();
	userExpandedSet: Set<number> = new Set();
	/** Force-expanded by scroll tracking (recomputed every tick) */
	activePathSet: Set<number> = new Set();
	activeEntryIndex = -1;
	pendingPathIndex = -1;
	activePathTimer = 0;
	defaultLevel = 0;

	// --- Scroll ---
	headingPositions: number[] = [];
	/** Entry positions only change when section offsets or measured heading
	 *  offsets change, never on scroll; the tick recomputes them lazily. */
	lastLayoutVersion = -1;
	positionsDirty = true;
	scrollHandler: (() => void) | null = null;
	tickScheduled = false;
	/** Sections queued for deferred heading-offset measurement (see
	 *  tagHeadings). */
	pendingTagHeadings: PendingTagSection[] = [];
	tagFrameRequested = false;
	highlightEl: HTMLElement | null = null;
	fadeTimer = 0;
	lastCenterIndex = -1;
	/** Trailing-debounce timer for post-settle scroll centering. */
	centerScrollTimer = 0;
	/** Cached viewport height; reading clientHeight every scroll frame forces a reflow. */
	viewportHeight = 0;
	viewportResizeObserver: ResizeObserver | null = null;
	/** Cached TOC panel height for write-only scroll centering + the row window. */
	tocViewportHeight = 0;
	tocResizeObserver: ResizeObserver | null = null;

	// --- Navigation guard ---
	navigating = false;
	navigationTimer = 0;
	/** true while programmatic scroll is in progress */
	isJumping = false;
	/** Timestamp (ms) when heading positions last changed.  The spy's
	 *  expand/collapse path is suppressed briefly after a position change so
	 *  that estimated heading offsets (which shift as sections lazy-mount) do
	 *  not cause the indicator to briefly highlight a wrong heading and
	 *  toggle expand/collapse before positions settle. */
	positionsStableSince = 0;

	constructor(
		containerEl: HTMLElement,
		files: TFile[],
		app: App,
		scrollContainer: HTMLElement,
		settings: TocSettings | null,
		positionSource: HeadingPositionSource | null,
	) {
		this.containerEl = containerEl;
		this.files = files;
		this.app = app;
		this.scrollContainer = scrollContainer;
		this.settings = settings;
		this.positionSource = positionSource;
	}

	/** Reset build-scoped state before a rebuild. */
	resetForBuild(): void {
		this.entries = [];
		this.virtualItems = [];
		this.virtualOffsets = [0];
		this.entryToItem = [];
		this.isLeaf = [];
		this.guideStyles = [];
		this.rowByEntry.clear();
		this.rowAnchorByEntry.clear();
		this.userCollapsedSet.clear();
		this.userExpandedSet.clear();
		this.activePathSet.clear();
		this.activeEntryIndex = -1;
		this.isJumping = false;
		this.headingOffsets.clear();
		this.defaultLevel = this.settings?.tocCollapsedLevel ?? 0;
		this.allRowsHidden = false;
	}

	/** Drop all collected data (full teardown; DOM is emptied by the view). */
	clearData(): void {
		this.entries = [];
		this.virtualItems = [];
		this.virtualOffsets = [0];
		this.entryToItem = [];
		this.isLeaf = [];
		this.guideStyles = [];
		this.headingPositions = [];
		this.headingOffsets.clear();
		this.entryByPathLine.clear();
		this.userCollapsedSet.clear();
		this.userExpandedSet.clear();
		this.activePathSet.clear();
		this.rowByEntry.clear();
		this.rowAnchorByEntry.clear();
		this.allRowsHidden = false;
	}

	// --- Expand / Collapse logic ---

	/** Is entry `i` expanded (showing its children)? */
	isEntryExpanded(i: number): boolean {
		if (this.activePathSet.has(i)) return true;
		if (this.userExpandedSet.has(i)) return true;
		if (this.userCollapsedSet.has(i)) return false;
		if (this.defaultLevel === 0) return true;
		return (this.entries[i]?.level ?? 0) < this.defaultLevel;
	}

	/** Compute the active path: entry `index` (if it has children) + all
	 *  ancestors. */
	computeActivePath(index: number): Set<number> {
		return computeActivePath(this.entries, index);
	}

	setsEqual(a: Set<number>, b: Set<number>): boolean {
		if (a.size !== b.size) return false;
		for (const v of a) {
			if (!b.has(v)) return false;
		}
		return true;
	}

	toggleCollapse(index: number): void {
		const currentlyExpanded = this.isEntryExpanded(index);

		if (currentlyExpanded) {
			this.userCollapsedSet.add(index);
			this.userExpandedSet.delete(index);
		} else {
			this.userCollapsedSet.delete(index);
			this.userExpandedSet.add(index);
		}

		// Anchor the toggled row so it does not jump when the total height
		// shrinks/grows above it.
		this.applyVisibility(index);
	}

	/** Rebuild the virtual list after a visibility change. Optional
	 *  `anchorEntry` keeps that entry's row visually pinned (scroll anchoring)
	 *  by compensating the panel scrollTop for the height delta above it. */
	applyVisibility(anchorEntry?: number): void {
		let delta = 0;
		if (anchorEntry !== undefined && anchorEntry >= 0) {
			const item = this.entryToItem[anchorEntry];
			const before = item === undefined || item < 0 ? 0 : (this.virtualOffsets[item] ?? 0);
			this.rebuildVirtualData();
			const itemAfter = this.entryToItem[anchorEntry];
			const after = itemAfter === undefined || itemAfter < 0 ? 0 : (this.virtualOffsets[itemAfter] ?? 0);
			delta = after - before;
		} else {
			this.rebuildVirtualData();
		}

		// Clamp the panel scrollTop to the new total height, applying the
		// anchor compensation so content above/below the anchor stays put.
		const viewport = this.tocViewportHeight > 0 ? this.tocViewportHeight : this.containerEl.clientHeight;
		const total = this.virtualOffsets[this.virtualOffsets.length - 1] ?? 0;
		const max = Math.max(0, total - viewport);
		this.containerEl.scrollTop = Math.max(0, Math.min(this.containerEl.scrollTop + delta, max));

		this.window?.render();
	}

	/** Recompute hidden state → virtual items → offsets from the current
	 *  collapse/expand state. Runs at build (after row heights are measured)
	 *  and on every visibility change. */
	rebuildVirtualData(): void {
		const hidden = computeHiddenState(this.entries, (i) => this.isEntryExpanded(i));
		const { items, entryToItem } = buildVirtualItems(
			this.entries,
			this.files,
			hidden,
			this.settings?.tocShowFileNames ?? false,
		);
		this.virtualItems = items;
		this.entryToItem = entryToItem;
		this.virtualOffsets = computeVirtualOffsets(items, this.rowHeight, this.fileRowHeight);
		this.allRowsHidden = !items.some((item) => item.type === 'heading');
	}
}
