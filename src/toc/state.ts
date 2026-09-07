import type { App, TFile } from 'obsidian';
import type { TocSettings, HeadingPositionSource } from './types';
import type { TocEntry } from './entries';
import type { TocWindow } from './window';
import type { VirtualItem } from './virtual';
import { computeActivePath, computeHiddenState } from '../utils/toc';
import { buildVirtualItems, computeVirtualOffsets } from './virtual';
import { TOC_SHADOW_CSS } from './shadow.css';

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
	/** Attached to `containerEl` once; rows, spacer and highlight bar live
	 *  inside it so document-level `:has()` selectors can never match them. */
	shadowRoot: ShadowRoot | null = null;
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
	/** Sections that were ever on the active path (i.e. the user scrolled to /
	 *  navigated into them). Grows monotonically across the session. Drives the
	 *  mode differences: 'only-expand' keeps these expanded forever; 
	 *  'expand-collapse-level' collapses the *visited* sections to the extra
	 *  "collapse rest to level" setting while leaving not-yet-visited sections
	 *  at the default level. */
	visitedSet: Set<number> = new Set();
	activeEntryIndex = -1;
	pendingPathIndex = -1;
	activePathTimer = 0;
	/** true while a coalesced auto-expand rebuild is scheduled
	 *  (schedulePathRebuild). Guards against one crossing per frame queueing a
	 *  second rebuild, and against applying a stale path after teardown. */
	activePathPending = false;
	defaultLevel = 0;
	/** Rest-collapse level for 'expand-collapse-level' mode, copied from
	 *  settings at build time (separate from the initial-collapse defaultLevel). */
	autoCollapseRestLevel = 0;

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
	/** The spacer element that hosts the (single, transform-positioned)
	 *  highlight bar — set by the window, removed on teardown. */
	highlightHost: HTMLElement | null = null;
	fadeTimer = 0;
	lastCenterIndex = -1;
	/** Trailing-debounce timer for post-settle scroll centering. */
	centerScrollTimer = 0;
	/** Cached viewport height; reading clientHeight every scroll frame forces a reflow. */
	viewportHeight = 0;
	viewportResizeObserver: ResizeObserver | null = null;
	/** Cached TOC panel height for write-only scroll centering + the row window. */
	tocViewportHeight = 0;
	/** Cached TOC panel scrollTop. Refreshed from the panel's own scroll
	 *  handler (window.ts) and after every internal panel scroll write, so the
	 *  continuous per-frame reads in keepActiveInView never touch the DOM —
	 *  reading scrollTop there forced a style recalc of the whole row list
	 *  every frame. */
	panelScrollTop = 0;
	tocResizeObserver: ResizeObserver | null = null;

	// --- Navigation guard ---
	navigating = false;
	navigationTimer = 0;
	/** Monotonically increasing counter; incremented on each scrollToHeading
	 *  call so in-flight async loops can detect they've been superseded. */
	navigationGeneration = 0;
	/** true while programmatic scroll is in progress */
	isJumping = false;
	/** Timestamp (ms) when heading positions last changed.  The spy's
	 *  expand/collapse path is suppressed briefly after a position change so
	 *  that estimated heading offsets (which shift as sections lazy-mount) do
	 *  not cause the indicator to briefly highlight a wrong heading and
	 *  toggle expand/collapse before positions settle. */
	positionsStableSince = 0;
	/** Timestamp (ms) of last scrollToHeading call and the scrollTop at that
	 *  moment.  The spy defers pickActiveIndex + updateHighlight until the
	 *  user scrolls significantly away from the teleport target, so the pill
	 *  stays on the teleported-to entry while heading offsets are measured
	 *  and line-based estimates settle. */
	lastNavigationTime = 0;
	lastNavigationScrollTop = -1;

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

	/** Create (or reuse) the open shadow root on `containerEl` and inject the
	 *  ToC stylesheet into it. All row/highlight/spacer DOM must live in the
	 *  shadow tree so Obsidian's `div:has(...)` enhancement sheet (which
	 *  re-rescans every div ancestor when a node is inserted) can never match
	 *  the rows: the row window's own stylesheet is injected here, scoped to
	 *  the shadow tree, and `var(--...)` custom properties inherit across the
	 *  boundary so book-scope theming keeps working. Idempotent: a second call
	 *  only re-injects the stylesheet if it was removed (e.g. the window
	 *  emptied the root in destroy()). */
	ensureShadow(): ShadowRoot {
		const existing = this.containerEl.shadowRoot;
		if (existing) {
			this.shadowRoot = existing;
		} else {
			this.shadowRoot = this.containerEl.attachShadow({ mode: 'open' });
		}
		const hasStyle = Array.from(this.shadowRoot.childNodes).some(
			(n) => n.nodeName === 'STYLE',
		);
		if (!hasStyle) {
			const style = this.containerEl.ownerDocument.createElement('style');
			style.textContent = TOC_SHADOW_CSS;
			this.shadowRoot.appendChild(style);
		}
		return this.shadowRoot;
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
		this.navigationGeneration++;
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

		const mode = this.settings?.autoExpandMode ?? 'disabled';
		const level = this.entries[i]?.level ?? 0;
		const initialLevel = this.defaultLevel;

		switch (mode) {
			case 'only-expand':
				// Sections visited (ever on the active path) stay expanded; the
				// rest follow the initial/default level.
				if (this.visitedSet.has(i)) return true;
				return initialLevel === 0 || level < initialLevel;
			case 'expand-collapse-level':
				// Visited sections (other than the active path) collapse to the
				// extra "collapse rest to level"; not-yet-visited sections keep
				// the default level. So collapsing creeps along with the scroll
				// instead of reflowing the whole book at once.
				if (this.visitedSet.has(i)) {
					return this.autoCollapseRestLevel === 0 || level < this.autoCollapseRestLevel;
				}
				return initialLevel === 0 || level < initialLevel;
			case 'expand-collapse-default':
			case 'disabled':
			default:
				return initialLevel === 0 || level < initialLevel;
		}
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
		// Read through the cached panel scrollTop (kept fresh by the panel's
		// scroll handler and by every internal panel scroll write) so a layout
		// change does not force a style recalc mid-tick.
		this.containerEl.scrollTop = Math.max(0, Math.min(this.panelScrollTop + delta, max));
		this.panelScrollTop = this.containerEl.scrollTop;

		this.window?.render();
	}

	/** Schedule the merged auto-expand rebuild off the book's scroll frame.
	 *  The scroll spy updates the active path live, but applyVisibility +
	 *  the row-window render mutate the panel and pay a panel-wide style
	 *  recalc over the panel subtree (measured ~24ms/690 elements here);
	 *  running it synchronously in the crossing frame hitches the scroll.
	 *  A single macrotask runs right after the current frame paints (macrotasks
	 *  run after the rendering steps), rebuilding for the newest path and
	 *  clearing the pending flag — crossings that arrive while a rebuild is
	 *  scheduled fold into it, so a glide across several sections settles on
	 *  one rebuild instead of one O(entries) pass + recalc per crossing. */
	schedulePathRebuild(): void {
		if (this.activePathPending) return;
		this.activePathPending = true;
		window.clearTimeout(this.activePathTimer);
		this.activePathTimer = window.setTimeout(() => {
			this.activePathTimer = 0;
			this.activePathPending = false;
			this.applyVisibility();
		}, 0);
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
