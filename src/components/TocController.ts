import { App, TFile, setIcon } from 'obsidian';
import { BookViewSettings } from '../settings';
import { AbsoluteSectionManager, HEIGHT_PER_LINE } from './AbsoluteSectionManager';
import { renderInlineMarkdown, stripMarkdown } from '../utils/renderInlineMarkdown';
import { pickActiveIndex, computeActivePath, computeHiddenState } from '../utils/toc';
import { DebugLog } from '../utils/debug';

// Per-frame budget for heading-offset measurement. getBoundingClientRect on a
// section inside the huge transformed book container forces a layout flush per
// read; draining a cold-start pile-up in one frame was a 50ms+ stall. Trickle
// at most these many rect reads per frame, and re-request a frame to continue.
const TAG_RECT_BUDGET = 8;
const TAG_MS_BUDGET = 6;

export interface TocEntry {
	level: number;
	text: string;
	file: TFile;
	line: number;
	fileHeadingIndex: number;
}

export class TocController {
	private containerEl: HTMLElement;
	private files: TFile[];
	private app: App;
	private scrollContainer: HTMLElement;
	private settings: BookViewSettings | null;
	private absoluteManager: AbsoluteSectionManager | null;
	private entries: TocEntry[] = [];
	private tocItems: HTMLElement[] = [];
	private headingLis: HTMLElement[] = [];
	private chevronEls: HTMLElement[] = [];
	private activeHeading: HTMLElement | null = null;
	/** Lookup from `${path}#${line}` to ToC entry index (built once per build). */
	private entryByPathLine: Map<string, number> = new Map();
	/** Measured y-offset of each entry's heading within its section, in spacer
	 *  coordinates relative to the section top. Unknown (unloaded / fold-hidden)
	 *  entries fall back to the line-based estimate. */
	private headingOffsets: Map<number, number> = new Map();
	onEntryContextMenu: ((entryIndex: number, evt: MouseEvent) => void) | null = null;

	// --- Expand/collapse state ---
	private userCollapsedSet: Set<number> = new Set();
	private userExpandedSet: Set<number> = new Set();
	/** Force-expanded by scroll tracking (recomputed every tick) */
	private activePathSet: Set<number> = new Set();
	private activeEntryIndex = -1;
	private pendingPathIndex = -1;
	private activePathTimer = 0;
	private animCleanupTimer = 0;
	private defaultLevel = 0;

	// --- Scroll ---
	private headingPositions: number[] = [];
	/** Entry positions only change when section offsets or measured heading
	 *  offsets change, never on scroll; the tick recomputes them lazily. */
	private lastLayoutVersion = -1;
	private positionsDirty = true;
	private scrollHandler: (() => void) | null = null;
	private tickScheduled = false;
	/** Sections queued for deferred heading-offset measurement. tagHeadings sets
	 *  the cheap data-entry-index attributes synchronously, then queues the
	 *  rect reads here; they run in the next frame (coalesced) instead of inside
	 *  the IO macrotask that mounted the section, where a getBoundingClientRect
	 *  right after the mount forces a full layout flush of freshly attached DOM. */
	private pendingTagHeadings: { sectionEl: HTMLElement; toMeasure: { el: HTMLElement; tocIndex: number }[] }[] = [];
	private tagFrameRequested = false;
	private highlightEl: HTMLElement | null = null;
	private fadeTimer = 0;
	private lastCenterIndex = -1;
	/** Trailing-debounce timer for post-settle scroll centering. */
	private centerScrollTimer = 0;
	/** Cached viewport height; reading clientHeight every scroll frame forces a reflow. */
	private viewportHeight = 0;
	private viewportResizeObserver: ResizeObserver | null = null;
	/** Cached TOC panel height for write-only scroll centering. */
	private tocViewportHeight = 0;
	private tocResizeObserver: ResizeObserver | null = null;

	// --- Navigation guard ---
	private navigating = false;
	private navigationTimer = 0;
	/** true while programmatic scroll is in progress */
	private isJumping = false;

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

	getEntries(): TocEntry[] {
		return this.entries;
	}

	private createHeadingItem(parent: HTMLElement, entry: TocEntry, heading: { heading: string; position: { start: { line: number } }; level: number }, file: TFile): void {
		const li = parent.createEl('li', { cls: 'book-toc-heading' });
		li.style.paddingLeft = `${(heading.level - 1) * 12}px`;
		li.dataset.level = String(heading.level);

		// Inner wrapper for grid row animation
		const inner = li.createDiv({ cls: 'book-toc-heading-inner' });

		const chevron = inner.createSpan({ cls: 'book-toc-chevron' });
		setIcon(chevron, 'chevron-right');
		const entryIdx = this.entries.length - 1;
		this.chevronEls.push(chevron);
		chevron.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleCollapse(entryIdx);
		});

		const a = inner.createEl('a', {
			cls: 'book-toc-item',
			attr: { 'data-path': file.path, 'data-line': String(heading.position.start.line), 'data-level': String(heading.level) },
		});
		if (this.settings?.tocRenderMarkdown) {
			const span = a.createSpan();
			const html = renderInlineMarkdown(heading.heading);
			const doc = new DOMParser().parseFromString(html, 'text/html');
			while (doc.body.firstChild) {
				span.appendChild(doc.body.firstChild);
			}
		} else {
			a.createSpan({ text: stripMarkdown(heading.heading) });
		}

		this.headingLis.push(li);
		this.tocItems.push(a);
		a.addEventListener('click', (evt) => {
			evt.preventDefault();
			void this.scrollToHeading(entryIdx);
		});
		a.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.onEntryContextMenu?.(entryIdx, evt);
		});
	}

	build(): void {
		this.destroy();
		this.containerEl.empty();
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

		const tocEl = this.containerEl.createDiv({ cls: 'book-toc' });
		if (this.settings?.tocGuides) {
			tocEl.addClass('book-toc-guides');
		}
		const listEl = tocEl.createEl('ul', { cls: 'book-toc-list' });

		for (const file of this.files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.headings) continue;

			if (this.settings?.tocShowFileNames) {
				const fileHeading = listEl.createEl('li', { cls: 'book-toc-file' });
				fileHeading.createDiv({
					cls: 'book-toc-file-title',
					text: file.basename,
				});

				const subList = fileHeading.createEl('ul', { cls: 'book-toc-file-headings' });

				for (let i = 0; i < cache.headings.length; i++) {
					const heading = cache.headings[i];
					if (!heading) continue;
					const entry: TocEntry = {
						level: heading.level,
						text: heading.heading,
						file,
						line: heading.position.start.line,
						fileHeadingIndex: i,
					};
					this.entries.push(entry);
					this.createHeadingItem(subList, entry, heading, file);
				}
			} else {
				for (let i = 0; i < cache.headings.length; i++) {
					const heading = cache.headings[i];
					if (!heading) continue;
					const entry: TocEntry = {
						level: heading.level,
						text: heading.heading,
						file,
						line: heading.position.start.line,
						fileHeadingIndex: i,
					};
					this.entries.push(entry);
					this.createHeadingItem(listEl, entry, heading, file);
				}
			}
		}

		this.containerEl.addClass('book-toc-relative');
		this.highlightEl = this.containerEl.createDiv({ cls: 'book-toc-highlight' });

		this.entryByPathLine = new Map<string, number>();
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;
			this.entryByPathLine.set(`${entry.file.path}#${entry.line}`, i);
		}

		if (this.settings?.tocActiveColor) {
			this.containerEl.style.setProperty('--bv-toc-active-color', this.settings.tocActiveColor);
		}

		this.markLeafChevrons();
		this.applyNestingGuides();
		this.applyVisibility();
		this.calculatePositions();
		this.setupScrollSpy();

		this.viewportHeight = this.scrollContainer.clientHeight;
		this.viewportResizeObserver?.disconnect();
		this.viewportResizeObserver = new ResizeObserver(() => {
			this.viewportHeight = this.scrollContainer.clientHeight;
		});
		this.viewportResizeObserver.observe(this.scrollContainer);

		this.tocViewportHeight = this.containerEl.clientHeight;
		this.tocResizeObserver?.disconnect();
		this.tocResizeObserver = new ResizeObserver(() => {
			this.tocViewportHeight = this.containerEl.clientHeight;
		});
		this.tocResizeObserver.observe(this.containerEl);

		// Bootstrap: highlight first heading after build. Route through the
		// manager frame so onScrollTick's cached scrollTop read is fresh (the
		// frame refreshes lastScrollTop before the callbacks run).
		if (this.entries.length > 0) {
			this.absoluteManager?.requestFrame();
		}
	}

	private markLeafChevrons(): void {
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;
			const nextEntry = this.entries[i + 1];
			const hasChildren = nextEntry != null && nextEntry.level > entry.level;
			if (!hasChildren) {
				this.chevronEls[i]?.addClass('book-toc-leaf');
			}
		}
	}

	private static GUIDE_POSITIONS = [8, 20, 32, 44, 56, 68];

	private applyNestingGuides(): void {
		if (!this.settings?.tocGuides) return;

		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (!entry) continue;

			const ancestorLevels: number[] = [];
			let targetLevel = entry.level - 1;
			for (let j = i - 1; j >= 0 && targetLevel >= 1; j--) {
				const ancestor = this.entries[j];
				if (!ancestor) break;
				if (ancestor.level <= targetLevel) {
					ancestorLevels.push(ancestor.level);
					targetLevel = ancestor.level - 1;
				}
			}

			if (ancestorLevels.length === 0) continue;

			const li = this.headingLis[i];
			if (!li) continue;

			const gradients: string[] = [];
			const positions: string[] = [];
			const sizes: string[] = [];

			for (const level of ancestorLevels) {
				const pos = TocController.GUIDE_POSITIONS[level - 1] ?? 0;
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

	// --- Expand / Collapse logic ---

	/** Is entry `i` expanded (showing its children)? */
	private isEntryExpanded(i: number): boolean {
		if (this.activePathSet.has(i)) return true;
		if (this.userExpandedSet.has(i)) return true;
		if (this.userCollapsedSet.has(i)) return false;
		if (this.defaultLevel === 0) return true;
		return (this.entries[i]?.level ?? 0) < this.defaultLevel;
	}

	/** Compute the active path: entry `index` (if it has children) + all ancestors */
	private computeActivePath(index: number): Set<number> {
		return computeActivePath(this.entries, index);
	}

	private toggleCollapse(index: number): void {
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

	private applyVisibility(): void {
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

	/** Recompute entry positions only when something that feeds them changed:
	 *  section offsets (layout version) or measured heading offsets (dirty
	 *  flag). Plain scroll frames keep the last array — positions do not depend
	 *  on scrollTop, so recomputing them was pure O(entries) waste per frame. */
	private updatePositionsIfDirty(): void {
		const layoutVersion = this.absoluteManager?.getLayoutVersion() ?? -1;
		if (!this.positionsDirty && layoutVersion === this.lastLayoutVersion) return;
		this.positionsDirty = false;
		this.lastLayoutVersion = layoutVersion;
		this.calculatePositions();
	}

	calculatePositions(): void {
		if (!this.absoluteManager) return;

		const n = this.entries.length;
		if (this.headingPositions.length !== n) {
			this.headingPositions = new Array<number>(n);
		}
		// Per-entry getOffset avoids allocating a Map for every frame of scroll;
		// the array is reused to avoid GC churn. Prefer the measured within-
		// section offset (set by tagHeadings when the section is mounted) over
		// the line-based estimate.
		for (let i = 0; i < n; i++) {
			const entry = this.entries[i];
			if (!entry) continue;
			const within = this.headingOffsets.get(i);
			this.headingPositions[i] = (this.absoluteManager.getOffset(entry.file.path) ?? 0)
				+ (within ?? entry.line * HEIGHT_PER_LINE);
		}
	}

	/** Drop measured within-section offsets for one path. Called when a file's
	 *  content is edited (markDirty re-renders the section without a TOC
	 *  rebuild), so the next render re-measures instead of trusting a stale
	 *  offset. */
	invalidatePath(path: string): void {
		let removed = 0;
		for (let k = 0; k < this.entries.length; k++) {
			if (this.entries[k]?.file.path === path && this.headingOffsets.delete(k)) removed++;
		}
		// Debug: is the headingOffsets cache being silently evicted by
		// markDirty (file modify events) while the user is elsewhere?
		if (removed > 0) {
			this.positionsDirty = true;
			DebugLog.log('TOC invalidate', path, removed);
		}
	}

	tagHeadings(path: string, container: HTMLElement): void {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.headings) return;

		const sectionEl = container.parentElement;
		if (!(sectionEl instanceof HTMLElement)) return;

		const headingEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');

		// Cheap part, kept synchronous: tag each heading with its ToC entry so
		// context menus can map a heading back to an entry. No layout reads.
		const toMeasure: { el: HTMLElement; tocIndex: number }[] = [];
		for (let i = 0; i < cache.headings.length; i++) {
			const heading = cache.headings[i];
			if (!heading) continue;
			const el = headingEls[i];
			if (!(el instanceof HTMLElement)) continue;

			const tocIndex = this.entryByPathLine.get(`${path}#${heading.position.start.line}`);
			if (tocIndex === undefined) continue;

			el.setAttribute('data-entry-index', String(tocIndex));

			// Churn re-mounts of the same file re-render an identical layout, so
			// the measured within-section offsets stay valid across renders. Only
			// measure headings without a cached offset. Content edits invalidate
			// the cache via invalidatePath, so stale offsets are re-measured
			// there.
			if (this.headingOffsets.has(tocIndex)) continue;
			toMeasure.push({ el, tocIndex });
		}
		if (toMeasure.length === 0) return;

		// Defer the rect reads to the next frame: tagHeadings runs inside the
		// IO macrotask right after the section's DOM mounted, and reading
		// getBoundingClientRect there forces a fresh layout flush of that
		// subtree on every section load. Batching all pending measurements into
		// one frame pass shares a single layout flush (with the spy's scrollTop
		// read) instead of one flush per section.
		this.pendingTagHeadings.push({ sectionEl, toMeasure });
		if (!this.tagFrameRequested) {
			this.tagFrameRequested = true;
			this.absoluteManager?.requestFrame();
		}
	}

	/** Frame callback (registered in setupScrollSpy, runs after processUpdates):
	 *  drains the deferred heading measurements in one coalesced pass. A cold
	 *  start mounts many sections back to back, so a whole window's worth of
	 *  heading rect reads can pile up; draining them all in a single frame was
	 *  a 50ms+ stall (tag=54.4ms in one cold-start debug window). Each rect read
	 *  on a section inside the huge transformed container forces a layout
	 *  flush, so cap the per-frame budget and trickle the rest — the offsets
	 *  are cached per tocIndex, so late measurements are still correct, and
	 *  the line-based fallback covers the highlight until they land. */
	private onTagFrame = (): void => {
		this.tagFrameRequested = false;
		if (this.pendingTagHeadings.length === 0) return;
		const t0 = performance.now();
		const timeLimit = t0 + TAG_MS_BUDGET;
		let rects = 0;
		const stillPending: { sectionEl: HTMLElement; toMeasure: { el: HTMLElement; tocIndex: number }[] }[] = [];
		for (const p of this.pendingTagHeadings) {
			const { sectionEl, toMeasure } = p;
			// Section unloaded before the frame arrived — skip; the line-based
			// fallback covers it until a future render re-queues the measure.
			if (!sectionEl.isConnected) continue;
			let sectionRect: DOMRect | null = null;
			const remaining: { el: HTMLElement; tocIndex: number }[] = [];
			for (const item of toMeasure) {
				if (rects >= TAG_RECT_BUDGET || performance.now() >= timeLimit) {
					remaining.push(item);
					continue;
				}
				if (!item.el.isConnected) continue;
				// Headings hidden by fold-mode collapse have display:none —
				// their rect is zeroed, so skip them and keep the line-based
				// fallback.
				if (item.el.offsetParent === null) continue;
				if (!sectionRect) sectionRect = sectionEl.getBoundingClientRect();
				const headingRect = item.el.getBoundingClientRect();
				this.headingOffsets.set(item.tocIndex, headingRect.top - sectionRect.top);
				this.positionsDirty = true;
				rects++;
				AbsoluteSectionManager.dbgTagRects++;
			}
			if (remaining.length > 0) stillPending.push({ sectionEl, toMeasure: remaining });
		}
		this.pendingTagHeadings = stillPending;
		AbsoluteSectionManager.dbgTagMs += performance.now() - t0;
		if (stillPending.length > 0) {
			this.tagFrameRequested = true;
			this.absoluteManager?.requestFrame();
		}
	};

	// --- Scroll spy ---

	private setupScrollSpy(): void {
		if (this.tocItems.length === 0) return;

		this.scrollHandler = () => {
			// No layout read in the scroll event: events can dispatch while the
			// book layout is dirty (async section loads), and reading scrollTop
			// would force a full style recalc right here. Instead request one
			// coalesced frame; the tick reads scrollTop in the rAF, before the
			// offset writes.
			if (this.tickScheduled) return;
			this.tickScheduled = true;
			this.absoluteManager?.requestFrame();
		};

		this.absoluteManager?.addFrameCallback(this.onTagFrame);
		this.absoluteManager?.addFrameCallback(this.onFrameTick);
		this.scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true });
	}

	/** Runs at the start of the shared frame, before position writes. */
	private onFrameTick = (): void => {
		this.tickScheduled = false;
		this.onScrollTick();
	};

	/** Called once per rAF frame on scroll */
	private onScrollTick(): void {
		if (this.isJumping) return;

		this.updatePositionsIfDirty();

		// Use the manager's per-frame viewport snapshot instead of reading
		// scrollTop here: the manager already read it in runFrame (next to its
		// own writes), and a second read in the same frame forces a second
		// layout flush — including on frames where processUpdates just dirtied
		// the layout. The snapshot is from this same frame, so it is exact.
		const scrollTop = this.absoluteManager?.getScrollTop() ?? this.scrollContainer.scrollTop;

		// find active heading by position
		const viewportHeight = this.viewportHeight;
		const bestIndex = pickActiveIndex(this.headingPositions, scrollTop, viewportHeight);

		if (bestIndex < 0) {
			window.clearTimeout(this.activePathTimer);
			this.pendingPathIndex = -1;
			if (this.activePathSet.size > 0) {
				this.activePathSet.clear();
				this.applyVisibility();
			}
			return;
		}

		this.activeEntryIndex = bestIndex;

		const mode = this.settings?.autoExpandMode ?? 'disabled';

		// Update highlight immediately (tracks scroll in real-time)
		let highlightIndex = bestIndex;
		if (mode === 'disabled') {
			const li = this.headingLis[bestIndex];
			if (li?.hasClass('book-toc-collapsed-hidden')) {
				let targetLevel = this.entries[bestIndex]?.level ?? 0;
				for (let j = bestIndex - 1; j >= 0; j--) {
					const a = this.entries[j];
					if (!a) break;
					if (a.level < targetLevel) {
						const ancLi = this.headingLis[j];
						if (ancLi && !ancLi.hasClass('book-toc-collapsed-hidden')) {
							highlightIndex = j;
							break;
						}
						targetLevel = a.level;
					}
				}
			}
		}

		this.updateHighlight(highlightIndex);

		// Center the active item once the scroll settles. Centering inside the
		// scroll frame both forced a layout read (li.offsetTop) and restarted a
		// smooth scroll on the panel for every active-item change; a single
		// trailing animation after the wheel rests is one read + one animation.
		if (this.lastCenterIndex !== bestIndex) {
			this.lastCenterIndex = bestIndex;
			this.scheduleCenterScroll(bestIndex);
		}

		// Debounce expand/collapse: wait for scroll to settle (30ms)
		if (bestIndex !== this.pendingPathIndex) {
			this.pendingPathIndex = bestIndex;
			window.clearTimeout(this.activePathTimer);
			this.activePathTimer = window.setTimeout(() => {
				this.pendingPathIndex = -1;
				const newPath = mode !== 'disabled'
					? this.computeActivePath(this.activeEntryIndex)
					: new Set<number>();

				if (!this.setsEqual(this.activePathSet, newPath)) {
					this.activePathSet = newPath;
					this.applyVisibility();
				}
			}, 30);
		}

		// Fade highlight indicator after idle
		if (this.highlightEl) {
			this.highlightEl.classList.remove('fading');
		}
		window.clearTimeout(this.fadeTimer);
		this.fadeTimer = window.setTimeout(() => {
			this.highlightEl?.classList.add('fading');
		}, 400);
	}

	private updateHighlight(index: number): void {
		const el = this.tocItems[index];
		if (!el) return;

		// Only touch the DOM when the active item actually changes; during a
		// scroll within one heading the active item is stable.
		if (el !== this.activeHeading) {
			this.activeHeading?.removeClass('is-active');
			el.addClass('is-active');
			this.activeHeading = el;

			// Host the highlight bar inside the active row: it then follows the
			// item automatically through collapse/expand animations and TOC
			// reflows, so it can never sit on a stale cached position.
			if (this.highlightEl) {
				const li = this.headingLis[index];
				if (li && this.highlightEl.parentElement !== li) {
					li.appendChild(this.highlightEl);
				}
			}
		}
	}

	/** Write-only scroll centering, run once after the scroll settles. Computes
	 *  the target from the active row's offset (the rows' offsetParent is the
	 *  positioned .book-toc-relative container) and the cached panel height.
	 *  Runs in a macrotask so the layout read/write happens after the frame's
	 *  render, when the layout is clean. */
	private scheduleCenterScroll(index: number): void {
		window.clearTimeout(this.centerScrollTimer);
		this.centerScrollTimer = window.setTimeout(() => {
			const li = this.headingLis[index];
			if (!li || this.tocViewportHeight <= 0) return;
			const target = Math.max(0, li.offsetTop - (this.tocViewportHeight - li.offsetHeight) / 2);
			this.containerEl.scrollTo({ top: target, behavior: 'smooth' });
		}, 150);
	}

	async scrollToHeading(entryIndex: number): Promise<void> {
		const entry = this.entries[entryIndex];
		if (!entry || !this.absoluteManager) return;

		this.navigating = true;
		this.isJumping = true;
		try {
			const sectionOffset = this.absoluteManager.getOffset(entry.file.path);
			const estimatedY = sectionOffset + entry.line * HEIGHT_PER_LINE;

			this.scrollContainer.scrollTo({ top: Math.max(0, estimatedY - 20), behavior: 'auto' });

			const placeholder = this.scrollContainer.querySelector(
				`.book-section-placeholder[data-path="${entry.file.path}"]`,
			);
			if (!(placeholder instanceof HTMLElement)) return;

			let targetHeading: Element | null = null;
			for (let attempt = 0; attempt < 30; attempt++) {
				const headings = placeholder.querySelectorAll('h1, h2, h3, h4, h5, h6');
				targetHeading = headings[entry.fileHeadingIndex] ?? null;
				if (targetHeading) break;
				await new Promise<void>((resolve) =>
					window.requestAnimationFrame(() => resolve()),
				);
			}

			if (targetHeading) {
				await this.settleScrollToHeading(targetHeading as HTMLElement);
				this.highlightHeading(targetHeading as HTMLElement);
			}

			this.calculatePositions();
			this.updateHighlight(entryIndex);

			// Apply auto-expand for the clicked heading
			const mode = this.settings?.autoExpandMode ?? 'disabled';
			if (mode !== 'disabled') {
				this.activePathSet = this.computeActivePath(entryIndex);
				this.applyVisibility();
			}
		} finally {
			window.clearTimeout(this.navigationTimer);
			this.navigationTimer = window.setTimeout(() => {
				this.navigating = false;
				this.isJumping = false;
			}, 200);
		}
	}

	/**
	 * The heading rect read right after a section mounts is stale: async
	 * renders (images, code blocks) and re-mounting of neighbouring sections
	 * keep shifting the layout for a few frames. Re-measure and re-correct
	 * the scroll until the heading's on-screen position stabilizes.
	 */
	private async settleScrollToHeading(heading: HTMLElement): Promise<void> {
		for (let attempt = 0; attempt < 30; attempt++) {
			const headingRect = heading.getBoundingClientRect();
			const containerRect = this.scrollContainer.getBoundingClientRect();
			const target =
				this.scrollContainer.scrollTop +
				(headingRect.top - containerRect.top) -
				20;
			if (Math.abs(this.scrollContainer.scrollTop - target) < 1) break;
			this.scrollContainer.scrollTo({
				top: Math.max(0, target),
				behavior: 'auto',
			});
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() => resolve()),
			);
		}
	}

	private highlightHeading(el: HTMLElement): void {
		el.addClass('book-heading-highlight');
		const handler = () => {
			el.removeClass('book-heading-highlight');
			el.removeEventListener('animationend', handler);
		};
		el.addEventListener('animationend', handler);
	}

	private setsEqual(a: Set<number>, b: Set<number>): boolean {
		if (a.size !== b.size) return false;
		for (const v of a) {
			if (!b.has(v)) return false;
		}
		return true;
	}

	destroy(): void {
		this.absoluteManager?.removeFrameCallback(this.onFrameTick);
		this.absoluteManager?.removeFrameCallback(this.onTagFrame);
		this.tickScheduled = false;
		this.pendingTagHeadings = [];
		this.tagFrameRequested = false;
		if (this.scrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		window.clearTimeout(this.fadeTimer);
		window.clearTimeout(this.centerScrollTimer);
		window.clearTimeout(this.navigationTimer);
		window.clearTimeout(this.activePathTimer);
		window.clearTimeout(this.animCleanupTimer);
		this.viewportResizeObserver?.disconnect();
		this.viewportResizeObserver = null;
		this.tocResizeObserver?.disconnect();
		this.tocResizeObserver = null;
		this.highlightEl = null;
		this.activeHeading = null;
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
}
