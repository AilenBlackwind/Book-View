import type { App, TFile } from 'obsidian';
import type { BookViewSettings } from '../settings';
import type { AbsoluteSectionManager } from '../components/AbsoluteSectionManager';
import type { TocEntry } from './entries';
import { computeActivePath, computeHiddenState } from '../utils/toc';

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

/**
 * All mutable ToC state plus the pure expand/collapse and visibility logic.
 * The builder/spy/measure/navigation modules only operate on this object, so
 * the controller stays a thin orchestrator.
 */
export class TocState {
	containerEl: HTMLElement;
	files: TFile[];
	app: App;
	scrollContainer: HTMLElement;
	settings: BookViewSettings | null;
	absoluteManager: AbsoluteSectionManager | null;

	entries: TocEntry[] = [];
	tocItems: HTMLElement[] = [];
	headingLis: HTMLElement[] = [];
	chevronEls: HTMLElement[] = [];
	activeHeading: HTMLElement | null = null;
	/** Lookup from `${path}#${line}` to ToC entry index (built once per build). */
	entryByPathLine: Map<string, number> = new Map();
	/** Measured y-offset of each entry's heading within its section, in spacer
	 *  coordinates relative to the section top. Unknown (unloaded / fold-hidden)
	 *  entries fall back to the line-based estimate. */
	headingOffsets: Map<number, number> = new Map();

	// --- Expand/collapse state ---
	userCollapsedSet: Set<number> = new Set();
	userExpandedSet: Set<number> = new Set();
	/** Force-expanded by scroll tracking (recomputed every tick) */
	activePathSet: Set<number> = new Set();
	activeEntryIndex = -1;
	pendingPathIndex = -1;
	activePathTimer = 0;
	animCleanupTimer = 0;
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
	/** Cached TOC panel height for write-only scroll centering. */
	tocViewportHeight = 0;
	tocResizeObserver: ResizeObserver | null = null;

	// --- Navigation guard ---
	navigating = false;
	navigationTimer = 0;
	/** true while programmatic scroll is in progress */
	isJumping = false;

	constructor(
		containerEl: HTMLElement,
		files: TFile[],
		app: App,
		scrollContainer: HTMLElement,
		settings: BookViewSettings | null,
		absoluteManager: AbsoluteSectionManager | null,
	) {
		this.containerEl = containerEl;
		this.files = files;
		this.app = app;
		this.scrollContainer = scrollContainer;
		this.settings = settings;
		this.absoluteManager = absoluteManager;
	}

	/** Reset build-scoped state before a rebuild. */
	resetForBuild(): void {
		this.entries = [];
		this.tocItems = [];
		this.headingLis = [];
		this.chevronEls = [];
		this.userCollapsedSet.clear();
		this.userExpandedSet.clear();
		this.activePathSet.clear();
		this.activeEntryIndex = -1;
		this.isJumping = false;
		this.headingOffsets.clear();
		this.defaultLevel = this.settings?.tocCollapsedLevel ?? 0;
	}

	/** Drop all collected data (full teardown; DOM is emptied by the view). */
	clearData(): void {
		this.entries = [];
		this.tocItems = [];
		this.headingLis = [];
		this.chevronEls = [];
		this.headingPositions = [];
		this.headingOffsets.clear();
		this.entryByPathLine.clear();
		this.userCollapsedSet.clear();
		this.userExpandedSet.clear();
		this.activePathSet.clear();
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

		this.applyVisibility();
	}

	applyVisibility(): void {
		// Phase 1: compute new state in a single forward pass (O(n)) using a
		// stack of open ancestors instead of a backward scan per entry.
		const willHide = computeHiddenState(this.entries, (i) => this.isEntryExpanded(i));

		// Phase 2: lock heights for changing items. Read all scroll heights
		// first (one forced reflow), then write all max-heights.
		const changed: { li: HTMLElement; index: number; start: number }[] = [];
		for (let i = 0; i < this.entries.length; i++) {
			const li = this.headingLis[i];
			if (!li) continue;
			const currentlyHidden = li.hasClass('book-toc-collapsed-hidden');
			if (willHide[i] === currentlyHidden) continue;
			changed.push({ li, index: i, start: li.scrollHeight });
		}
		for (const c of changed) {
			c.li.style.maxHeight = `${c.start}px`;
		}

		// Force the max-height "start" value to be picked up before the target
		// write. Read the contained panel instead of document.body: the TOC
		// container has contain:layout, so this reflows only the panel subtree,
		// not the whole document.
		if (changed.length > 0) void this.containerEl.offsetHeight;

		// Phase 3: toggle class and set target height
		for (let i = 0; i < this.entries.length; i++) {
			const li = this.headingLis[i];
			if (!li) continue;
			if (willHide[i]) {
				li.addClass('book-toc-collapsed-hidden');
			} else {
				li.removeClass('book-toc-collapsed-hidden');
			}
		}

		for (const c of changed) {
			c.li.style.maxHeight = willHide[c.index] ? '0' : `${c.start}px`;
		}

		// Phase 4: after transition, clear inline max-height for expanded items
		window.clearTimeout(this.animCleanupTimer);
		this.animCleanupTimer = window.setTimeout(() => {
			for (let i = 0; i < this.entries.length; i++) {
				const li = this.headingLis[i];
				if (!li || willHide[i]) continue;
				li.style.removeProperty('max-height');
			}
		}, 160);

		for (let i = 0; i < this.chevronEls.length; i++) {
			const chevron = this.chevronEls[i];
			if (!chevron) continue;
			if (this.isEntryExpanded(i)) {
				chevron.removeClass('book-toc-chevron-closed');
			} else {
				chevron.addClass('book-toc-chevron-closed');
			}
		}
	}
}
