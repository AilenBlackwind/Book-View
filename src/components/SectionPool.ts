import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';
import type { FoldMode } from '../utils/fold';
import { estimateHeight, startsWithHeading, endsWithHeading, guessFirstType, guessLastType } from '../utils/content';
import { getFirstContentElement, getLastContentElement, getHeaderLevel } from '../utils/dom';

export const OVERSCAN_TOP = 2500;

const PRERENDER_BATCH = 4;
const PRERENDER_DELAY = 60;
const PRERENDER_SETTLE = 300;
const PRERENDER_PARK_DELAY = 80;
const COLD_START_DELAY = 200;
const IDLE_UNLOAD_DELAY = 500;
const FAR_UNLOAD_MARGIN = 2000;
// How far past the load window pre-render may measure heights. Sections beyond
// it get parked/unloaded immediately (parkIfOutOfZone), so measuring them early
// just churns the renderer: mount + measure + full recalc + unload for nothing.
export const PRERENDER_WINDOW = 3000;

// How long a live scrollTop read stays valid across drainQueue calls. The read
// only runs when a queued section is out of band under the IO-dispatch
// position; refreshing it on every such batch during a fast scroll would force
// a layout flush (freshly mounted DOM) on the main thread mid-gesture. A short
// TTL keeps the at-rest correction (the case that matters for correctness)
// exact while bounding the flush rate during churn.
const LIVE_READ_TTL = 100;

// Content size (chars) above which a section is flagged as heavy in the debug
// log. Heavy sections are the ones whose MarkdownRenderer.render can take tens
// to hundreds of milliseconds; the marker lets the log distinguish them from
// the bulk of cheap notes without reading the DBG counters.
export const HEAVY_SECTION_CHARS = 12000;

// Renders that took at least this long get their own render-ms line. Below
// that a section is cheap enough to be part of the aggregate DBG counter.
const RENDER_MS_LOG_THRESHOLD = 20;

// How long after the last user scroll event fresh renders of heavy sections
// are deferred. Heavy content (math, mermaid) costs 100-260ms per render in
// the stress book, so a fast gesture that enqueues several of them stalls the
// main thread for hundreds of ms mid-scroll. While a gesture is this fresh,
// drainQueue skips heavy sections and reconcile re-enqueues each visible one
// every frame; once the gesture settles they render normally — same visual
// result, no jank. Matches PRERENDER_SETTLE, the existing "user is scrolling"
// guard used for idle work.
const HEAVY_DEFER_MS = 300;

// Gap between consecutive placeholder→full upgrades. Each full render of a
// heavy section blocks the main thread for 150-260ms, so upgrades must be
// serialized and spaced: upgrading every placeholder at once (all started in
// the same frame) froze the UI for a second after each scroll settle. One
// upgrade per step keeps the freeze short and between-scrolls.
const UPGRADE_STEP_DELAY = 300;

// Cap on consecutive drain passes where a section is deferred because its raw
// content hasn't landed yet. The deferral is meant to last a frame or two while
// the async cachedRead resolves; a read that never resolves (a vanished file, a
// rejected vault read) would otherwise leave the section blank forever while the
// user stands on it, because reconcile re-enqueues it each frame only for it to
// be deferred again. Past the cap the full render (with its own cachedRead
// fallback inside loadSection) takes over so the section always renders.
const MAX_CONTENT_PENDING_SKIPS = 45;

// Cold starts produce floods of drop-stale-render lines: while heights are
// still 35px estimates the IO window spans ~170 tiny sections, and each wheel
// step during the initial scroll re-delivers dozens of crossings that drain
// correctly drops as stale. Logging ~2000 lines per cold start buries the
// signal. Collapse a drop storm into one summary line; keep individual lines
// only for small (meaningful) counts.
const DROP_STALE_LOG_MAX = 4;

// Output budget (chars) for the placeholder preview. The old placeholder passed
// the whole stripped note through MarkdownRenderer, which cost tens of ms per
// section even with the math removed — 15 of them in one cold-start window
// added ~2.5s of render time. The preview is only the note's opening (heavy
// notes put their math up front, so after stripping $$/mermaid blocks the
// opening is mostly the title and first lines): real text for the user to read
// while scrolling, but a couple of ms of render work. The rest of the note's
// height is covered by the fixed-height box loadPlaceholder sizes to the
// section's current data.height.
const PLACEHOLDER_CHARS = 500;

/**
 * Predictor for sections whose MarkdownRenderer.render is expensive enough to
 * skip while the user is actively scrolling. Empirically (stress book): math
 * blocks `$$...$$` correlate perfectly with 120-260ms sync renders, mermaid
 * blocks cost asynchronously right after mount (layout/paint), while tables,
 * callouts, and code fences are cheap regardless of count. Cheap substring
 * scan of the raw markdown — no parsing, no DOM.
 */
export function isHeavyContent(content: string): boolean {
	// Block math `$$...$$` (inline `$...$` excluded: too common to be a signal).
	if (content.includes('$$')) return true;
	// Mermaid diagram fenced block.
	if (content.includes('```mermaid')) return true;
	return false;
}

const MATH_PLACEHOLDER_TAG = 'book-view-ph-math';
const MERMAID_PLACEHOLDER_TAG = 'book-view-ph-mermaid';

function placeholderDiv(tag: string, lines: number): string {
	// Estimate the placeholder height from the size of the block it replaces so
	// the scroll layout stays close while the full render is still deferred. The
	// real render corrects the height via the ResizeObserver, so an estimate is
	// enough — mermaid especially varies wildly (a flowchart can be 80px or
	// 600px), so exactness here is impossible without rendering.
	const base = tag === MERMAID_PLACEHOLDER_TAG ? 80 : 44;
	const perLine = tag === MERMAID_PLACEHOLDER_TAG ? 22 : 24;
	const h = Math.max(base, Math.min(600, lines * perLine));
	return `<div class="book-view-ph ${tag}" style="height:${h}px"></div>`;
}

/**
 * Cheap rendering input for heavy sections while the user is actively
 * scrolling. Strips display-math `$$` blocks and mermaid fences (the two
 * markers that make MarkdownRenderer.render expensive) and replaces each with
 * a placeholder div of estimated height; everything else — headings, tables,
 * callouts, code, inline `$...$` — is passed through untouched. Only the
 * leading part of the note up to PLACEHOLDER_CHARS is kept: heavy notes put
 * their math up front, so after stripping the blocks the excerpt is mostly the
 * title and first lines — real text, rendered in a couple of ms instead of the
 * whole note's pipeline. Rendering the full stripped note cost tens of ms per
 * section and made a cold-start window of 15 placeholders stall the scroll for
 * seconds. The caller mounts this inside a box fixed to the section's current
 * data.height, so the layout stays correct while the excerpt shows a clipped
 * preview until the full render replaces it after the gesture settles.
 */
export function buildPlaceholderContent(content: string): string {
	const lines = content.split('\n');
	const out: string[] = [];
	let budget = PLACEHOLDER_CHARS;
	let inFence = false;
	let fenceIsMermaid = false;
	let inMath = false;
	let mathLines = 0;
	for (const raw of lines) {
		// Past half the budget, end the excerpt at a paragraph or heading
		// boundary so it reads like an intentional preview, not a cut sentence.
		// The math/fence state above is unaffected: the stripped math body is
		// never pushed, and an unclosed real fence simply has nothing after it.
		if (budget <= PLACEHOLDER_CHARS / 2) {
			const t = raw.trim();
			if (t === '' || /^#{1,6}\s/.test(t)) break;
		}
		if (inFence) {
			if (/^\s*```/.test(raw)) {
				inFence = false;
				// A normal code fence keeps its closing marker; a mermaid fence
				// is fully replaced by the placeholder emitted at its opening.
				if (!fenceIsMermaid) out.push(raw);
			} else if (!fenceIsMermaid) {
				// Fence body: pass through for real code, drop for mermaid
				// (its content is replaced by the placeholder).
				out.push(raw);
			}
			budget -= raw.length;
			continue;
		}
		if (inMath) {
			// Close on any line that still carries `$$` — either a bare `$$` or
			// the trailing `$$` of an `\end{...}$$` sequence.
			if (raw.includes('$$')) {
				inMath = false;
				out.push(placeholderDiv(MATH_PLACEHOLDER_TAG, mathLines));
			} else {
				mathLines++;
			}
			budget -= raw.length;
			continue;
		}
		const fenceMatch = /^\s*(```+)\s*([^`]*)\s*$/.exec(raw);
		if (fenceMatch) {
			inFence = true;
			const lang = (fenceMatch[2] ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
			fenceIsMermaid = lang === 'mermaid';
			if (fenceIsMermaid) out.push(placeholderDiv(MERMAID_PLACEHOLDER_TAG, 0));
			else out.push(raw);
			budget -= raw.length;
			continue;
		}
		const trimmed = raw.trim();
		if (trimmed === '$$') {
			inMath = true;
			mathLines = 0;
			continue;
		}
		if (trimmed.startsWith('$$')) {
			if (trimmed.endsWith('$$')) {
				// `$$...$$` fully on one line.
				out.push(placeholderDiv(MATH_PLACEHOLDER_TAG, 1));
				budget -= raw.length;
			} else {
				// `$$\begin{...}` style: the block body follows.
				inMath = true;
				mathLines = 0;
			}
			continue;
		}
		if (raw.includes('$$')) {
			// Mixed line: strip inline display-math spans, keep the text.
			out.push(raw.replace(/\$\$(.*?)\$\$/g, () => placeholderDiv(MATH_PLACEHOLDER_TAG, 1)));
			budget -= raw.length;
			continue;
		}
		out.push(raw);
		budget -= raw.length;
		if (budget <= 0) break;
	}
	return out.join('\n');
}

/**
 * Decides whether a queued section is so far from the viewport that rendering
 * it now would be wasted churn. Section at [offset, offset+height) must fall
 * within [scrollTop - margin, viewportBottom + margin] to be worth mounting;
 * margin = OVERSCAN_TOP + loadMargin keeps the drop window wider than the IO
 * window so entries that legitimately crossed into the overscan survive.
 *
 * scrollTop must be the CURRENT scroll position: judged against a stale (deep)
 * snapshot, a section that just entered the top overscan during a fast scroll
 * up looks far away, gets dropped here, and — being already intersecting — the
 * IO never re-enqueues it, leaving a blank gap until the user scrolls again.
 */
export function isStaleRender(
	offset: number,
	height: number,
	scrollTop: number,
	viewportBottom: number,
	margin: number,
): boolean {
	const end = offset + height;
	return end < scrollTop - margin || offset > viewportBottom + margin;
}

/**
 * Two-position stale check: a queued section is dropped only when it is out
 * of band under BOTH the primary (IO-dispatch) scroll position AND a current
 * live read. The primary alone misjudges a fast scroll-up: it is a single
 * value overwritten by every IO dispatch, so by the time the queue drains it
 * can be far past a section that entered the window mid-gesture and that the
 * user now rests on. Already intersecting, the IO never re-enqueues that
 * section, so dropping on the primary alone leaves a blank section (worst for
 * a very tall one, which blanks a huge region). The live read grounds the
 * decision in where the user actually is; sections genuinely far in both are
 * still dropped, so the down-scroll churn guard holds.
 */
export function isStaleForDrain(
	offset: number,
	height: number,
	primaryScrollTop: number,
	primaryViewportBottom: number,
	liveScrollTop: number,
	liveViewportBottom: number,
	margin: number,
): boolean {
	return isStaleRender(offset, height, primaryScrollTop, primaryViewportBottom, margin)
		&& isStaleRender(offset, height, liveScrollTop, liveViewportBottom, margin);
}

/**
 * True when a section's rendered extent [offset, offset+height) overlaps the
 * IO load window [scrollTop - overscanTop, scrollTop + clientHeight +
 * loadMargin]. The IntersectionObserver watches the zero-height placeholder,
 * so it only ever sees the section's top point: a section whose top has left
 * the window while its content is still in view (a tall note) or whose offset
 * moved under a stale IO state never re-enqueues through the observer — only
 * this extent check keeps it loaded. The drain's two-position stale check
 * still drops anything this over-enqueues, so judging against the estimate
 * height of unloaded sections is safe.
 */
export function isSectionInWindow(
	offset: number,
	height: number,
	scrollTop: number,
	clientHeight: number,
	overscanTop: number,
	loadMargin: number,
): boolean {
	return offset + height >= scrollTop - overscanTop
		&& offset <= scrollTop + clientHeight + loadMargin;
}

export interface SectionData {
	el: HTMLElement;
	component: Component | null;
	offset: number;
	height: number;
	startsWithHeading: boolean;
	endsWithHeading: boolean;
	firstType: string;   // 'h1'..'h6' or 'text'
	lastType: string;    // 'h1'..'h6' or 'text'
	foldHeadingHeight: number;  // measured height of first heading when folded
	/** True when the raw content contains markers (math, mermaid) that make
	 *  MarkdownRenderer.render expensive; such sections are deferred while the
	 *  user is actively scrolling and rendered when the gesture settles. */
	heavy: boolean;
	/** True while the mounted DOM is the cheap placeholder render (text with
	 *  formula placeholders). Upgraded to the full render once the gesture
	 *  settles (scheduleDeferredDrain → upgradePlaceholders). */
	placeholder: boolean;
	renderGen: number;
	mtime: number;
	heightTrusted: boolean;
	wasHidden: boolean;
	/** Consecutive drain passes this section was skipped because its raw
	 *  content had not landed yet (see MAX_CONTENT_PENDING_SKIPS). Reset to 0
	 *  whenever the section actually mounts. */
	deferralCount: number;
}

export interface HeightPersistence {
	get?: (path: string, mtime: number, width: number) => number | undefined;
	put?: (path: string, mtime: number, width: number, height: number) => void;
}

export interface SectionPoolHost {
	readonly sections: Map<string, SectionData>;
	readonly rawContent: Map<string, string>;
	readonly heightCache: Map<string, number>;
	readonly renderedDomCache: Map<string, HTMLElement>;
	readonly fileOrder: string[];
	readonly scrollContainer: HTMLElement;
	readonly spacerEl: HTMLElement;
	readonly app: App;
	readonly loadMargin: number;
	readonly persistence: HeightPersistence;
	isDestroyed(): boolean;
	getFoldMode(path: string): FoldMode;
	foldSectionNeedsFoldStub(path: string): boolean;
	foldScheduleHeightMeasure(path: string): void;
	foldTagSection(path: string, el: HTMLElement): void;
	findAnchorAt(scrollTop: number): { idx: number; anchorOffset: number } | null;
	getOnSectionRendered(): ((path: string, container: HTMLElement) => void) | null;
	/** Viewport snapshot from the last frame (avoid re-reading geometry in the
	 *  IO macrotask, where the freshly mounted DOM would force a reflow). */
	getScrollTop(): number;
	getClientHeight(): number;
	getContainerWidth(): number;
	reportSectionHeight(path: string, newHeight: number): void;
	scheduleUpdate(): void;
	scheduleFrame(): void;
	dbg(msg: string, path?: string, a?: number | string, b?: number | string, c?: number | string): void;
}

/**
 * Owns the DOM lifecycle of book sections: creating the section elements,
 * reading note contents, loading/unloading markdown renders into an
 * IntersectionObserver window, the concurrent render queue, and idle-time
 * prerendering. It never reads or writes scroll offsets — the manager owns
 * the layout and only hands this pool the shared data it must maintain.
 */
export class SectionPool {
	private ioPending: { path: string; intersecting: boolean }[] = [];
	private idleUnloadTimer = 0;
	private ioWorkTimer = 0;
	/** Scroll position captured at the last IntersectionObserver dispatch.
	 *  Fresher than the manager's rAF snapshot (getScrollTop), which lags IO
	 *  delivery by up to a frame — on a heavy book, by more, because the IO
	 *  fires in its own task while the rAF callback is starved behind layout.
	 *  drainQueue uses this as the primary drop-window position; a live read
	 *  (readLiveScrollTop) corrects it when it drifted past the current spot. */
	private ioScrollTop: number | null = null;
	private liveScrollTop: number | null = null;
	private liveScrollAt = 0;
	private observer: IntersectionObserver;
	private sectionResizeObserver: ResizeObserver;
	private renderQueue: string[] = [];
	// O(1) membership mirror of renderQueue. enqueueRender/reconcile checked
	// `includes` over the whole queue, and a cold-start IO storm queues ~2000
	// crossings at once; with a plain array that was O(n²) per storm, invisible
	// in the DBG timing (which only covers the frame callback). The Set keeps
	// enqueue/reconcile/drain O(1).
	private renderQueueSet: Set<string> = new Set();
	private activeRenderCount = 0;
	private maxConcurrent = 1;
	private coldStartTimer = 0;
	private idleTimer = 0;
	private deferredDrainTimer = 0;
	private lastUserScrollTimestamp = 0;

	/** scrollTop seen by the previous reconcile frame. A frame-to-frame change
	 *  marks the book as moving even when no user scroll event fired — the
	 *  anchor restore at open and the manager's height-compensation writes
	 *  change scrollTop while their scroll events are consumed as "adjusting"
	 *  and never reach noteUserScroll. Full renders of heavy sections during
	 *  that repositioning are the cold-start freeze (rm=2115ms in one debug
	 *  window), so any movement must count as an active gesture. */
	private lastReconcileScrollTop: number | null = null;
	private upgradeQueue: string[] = [];
	private upgradeInFlight = false;
	private upgradePumpTimer = 0;

	// Debug counters (live in the togglable debug layer).
	dbgIo = 0;
	dbgLoads = 0;
	dbgUnloads = 0;
	dbgPrerenders = 0;
	/** Debug: total ms spent inside MarkdownRenderer.render in the window. */
	dbgRenderMs = 0;
	/** Debug: renders thrown away because the section was unloaded mid-render. */
	dbgAborts = 0;
	/** Debug: heavy full renders replaced by a cheap placeholder while scrolling. */
	dbgPlaceholders = 0;
	/** Debug: placeholder sections upgraded to their full render after settle. */
	dbgUpgrades = 0;
	/** Debug: total ms spent in processIoPending + drainQueue (the IO-storm
	 *  churn that runs outside the frame callback and was previously invisible). */
	dbgQueueMs = 0;

	dbgReset(): [number, number, number, number, number, number, number, number, number] {
		const r: [number, number, number, number, number, number, number, number, number] = [this.dbgIo, this.dbgLoads, this.dbgUnloads, this.dbgPrerenders, this.dbgRenderMs, this.dbgAborts, this.dbgPlaceholders, this.dbgUpgrades, this.dbgQueueMs];
		this.dbgIo = 0;
		this.dbgLoads = 0;
		this.dbgUnloads = 0;
		this.dbgPrerenders = 0;
		this.dbgRenderMs = 0;
		this.dbgAborts = 0;
		this.dbgPlaceholders = 0;
		this.dbgUpgrades = 0;
		this.dbgQueueMs = 0;
		return r;
	}

	constructor(private host: SectionPoolHost) {
		this.observer = new IntersectionObserver(
			(entries) => {
				// Keep the IO delivery cheap: record which sections crossed the
				// boundary and let the next frame do the DOM work batched with
				// the scroll-spy read. Loads/unloads here ran markdown renders
				// and attach/detach churn synchronously inside the IO event.
				// Capture the dispatch-time scroll position too. The browser has
				// just computed the intersections, so its layout is clean and
				// this read costs no reflow — unlike reading it later in
				// drainQueue, after the mounts this batch may trigger. The frame
				// snapshot (host.getScrollTop) can be stale when the main thread
				// is busy, and judging the drop window against it drops sections
				// entering the top overscan on a fast scroll-up.
				this.ioScrollTop = this.host.scrollContainer.scrollTop;
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const path = el.dataset.path;
					if (!path) continue;

					if (entry.isIntersecting && el.classList.contains('book-section-folded')) {
						// Hidden by fold — never render or unrender
						continue;
					}

					this.ioPending.push({ path, intersecting: entry.isIntersecting });
					this.dbgIo++;
				}
				if (this.ioPending.length > 0) {
					this.host.scheduleFrame();
				}
			},
			{
				root: this.host.scrollContainer,
				rootMargin: `${OVERSCAN_TOP}px 0px ${this.host.loadMargin}px 0px`,
				threshold: 0,
			},
		);

		this.sectionResizeObserver = new ResizeObserver((entries) => {
			// No getBoundingClientRect here: the rects were only used for the
			// debug log, and reading them forced a full style recalc + layout
			// flush inside every height change (which is exactly where the
			// scroll layout is most likely to be dirty).
			for (const entry of entries) {
				const el = entry.target as HTMLElement;
				const path = el.dataset.path;
				if (!path) continue;

				const newHeight = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
				if (newHeight <= 0) continue;

				const data = this.host.sections.get(path);
				if (!data) continue;
				// Ignore stale notifications delivered after unload.
				if (!data.component) continue;
				// A section collapsed to its own heading (or fully hidden) only
				// renders its stub; that height must never overwrite data.height,
				// which always holds the full unfolded height the layout re-expands
				// with on unfold. Baking the stub in would pack the following
				// sections against ~40px while the DOM still spans the full note,
				// overlapping every heading and turning the text to mush. The stub
				// height is measured separately as foldHeadingHeight.
				if (this.host.getFoldMode(path) !== 'none') continue;
				// Ignore sub-pixel churn: fractional fluctuations still trigger
				// scrollTop writes, and each write cancels an in-flight wheel tick.
				// A size that matches the current height also confirms the height
				// is real, which lets prerender stop revisiting the section.
				if (Math.abs(newHeight - data.height) < 2) {
					data.heightTrusted = true;
					continue;
				}

				this.host.dbg('height-change', path, Math.round(data.height), Math.round(newHeight));
				this.host.reportSectionHeight(path, newHeight);
			}
		});

		this.coldStartTimer = window.setTimeout(() => {
			this.maxConcurrent = 2;
			this.scheduleIoWork();
		}, COLD_START_DELAY);
	}

	noteUserScroll(): void {
		this.lastUserScrollTimestamp = Date.now();
	}

	get lastUserScrollAt(): number {
		return this.lastUserScrollTimestamp;
	}

	render(links: ManifestLink[]): Promise<void>[] {
		const readPromises: Promise<void>[] = [];
		for (const link of links) {
			if (link.type === 'broken') {
				const el = this.host.spacerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '❌ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Note not found: ${link.display}` });
				continue;
			}

			if (link.type === 'empty') {
				const el = this.host.spacerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '⚠️ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Empty note: ${link.file.path}` });
				continue;
			}

			const file = link.file;
			const path = file.path;

			const el = this.host.spacerEl.createDiv({
				cls: 'book-section-placeholder book-section-absolute',
				attr: { 'data-path': path },
			});

			const mtime = file.stat.mtime;
			const cached = this.host.heightCache.get(path) ?? this.host.persistence.get?.(path, mtime, this.host.getContainerWidth());
			const estimated = cached ?? 35;

			const data: SectionData = {
				el,
				component: null,
				offset: 0,
				height: estimated,
				startsWithHeading: false,
				endsWithHeading: false,
				firstType: 'text',
				lastType: 'text',
				foldHeadingHeight: 0,
				heavy: false,
				placeholder: false,
				renderGen: 0,
				mtime,
				heightTrusted: cached !== undefined,
				wasHidden: false,
				deferralCount: 0,
			};
			this.host.sections.set(path, data);
			this.host.fileOrder.push(path);

			const p = this.host.app.vault.cachedRead(file).then((content) => {
				this.host.rawContent.set(path, content);
				const est = cached ?? estimateHeight(content);
				data.height = est;
				if (!cached) {
					this.host.heightCache.set(path, est);
				}
				data.startsWithHeading = startsWithHeading(content);
				data.endsWithHeading = endsWithHeading(content);
				data.firstType = guessFirstType(content);
				data.lastType = guessLastType(content);
				data.heavy = isHeavyContent(content);
			});
			readPromises.push(p);

			this.observer.observe(el);
		}

		this.schedulePreRender();
		return readPromises;
	}

	enqueueRender(path: string): void {
		if (this.host.isDestroyed()) return;
		const data = this.host.sections.get(path);
		if (!data || data.component) return;
		if (this.renderQueueSet.has(path)) return;
		this.renderQueueSet.add(path);
		this.renderQueue.push(path);
		this.scheduleIoWork();
	}

	unloadSection(path: string): void {
		const data = this.host.sections.get(path);
		if (!data || !data.component) return;
		this.dbgUnloads++;

		this.host.dbg('unload', path);
		this.sectionResizeObserver.unobserve(data.el);

		// Only cache visible sections. A 'full' fold hides the section entirely;
		// its invisible DOM would be pure waste in the cache until the view
		// closes, and a fresh render on unfold is instant anyway. Placeholder
		// DOM is likewise never cached: it lacks the formulas, and serving it as
		// the "full" render on a later remount would keep them hidden forever.
		if (!data.placeholder && this.host.getFoldMode(path) !== 'full') {
			const rendered = data.el.querySelector('.markdown-rendered');
			if (rendered) {
				this.host.renderedDomCache.set(path, rendered as HTMLElement);
			}
		}

		data.component.unload();
		data.component = null;
		// Invalidate any in-flight render for this section.
		data.renderGen++;
		data.el.empty();
	}

	refreshSection(path: string): void {
		const data = this.host.sections.get(path);
		if (!data) return;

		this.sectionResizeObserver.unobserve(data.el);

		if (data.component) {
			data.component.unload();
			data.component = null;
		}

		this.host.rawContent.delete(path);
		this.host.renderedDomCache.delete(path);
		const file = this.host.app.vault.getFileByPath(path);
		if (file instanceof TFile) {
			data.mtime = file.stat.mtime;
		}
		// Keep the last measured height and heading flags until the re-render
		// produces new measurements: collapsing the height here would shift
		// everything below without any scroll compensation.
		data.renderGen++;
		data.el.empty();
		void this.loadSection(path);
	}

	scheduleIoWork(): void {
		if (this.host.isDestroyed()) return;
		if (this.ioWorkTimer) return;
		if (this.ioPending.length === 0 && this.renderQueue.length === 0) return;
		this.ioWorkTimer = window.setTimeout(() => {
			this.ioWorkTimer = 0;
			if (this.host.isDestroyed()) return;
			const hadPending = this.ioPending.length > 0;
			this.processIoPending();
			if (hadPending) {
				// processIoPending may have unloaded a section mid-render (a
				// fast scroll firing IO false while its markdown render is in
				// flight) or acted on a stale IO state. One more frame
				// reconciles the load window against fresh offsets/scrollTop
				// so a section the user now stands on is re-enqueued instead
				// of staying blank. No-op when a frame is already scheduled.
				this.host.scheduleFrame();
			}
			this.drainQueue();
		}, 0);
	}

	/**
	 * Reconciliation pass: enqueue every unloaded section whose extent
	 * overlaps the load window, regardless of what the IntersectionObserver
	 * last reported. The IO is the fast-path enqueue signal, but it can
	 * disagree with the actual geometry: a section whose offset moved (neighbor
	 * height correction, width reset, fold transition) or whose render was
	 * aborted mid-flight by a fast scroll ends up visible-but-unmounted with
	 * no crossing left to fire the IO again — a permanent blank until the user
	 * scrolls. Offsets are the authority, so this walk (binary search to the
	 * window, scan forward) closes those gaps every frame and after each IO
	 * batch. The drain's stale check filters whatever this over-enqueues, so
	 * it never renders far-down churn.
	 */
	reconcileVisibleSections(scrollTop: number, clientHeight: number): void {
		if (this.host.isDestroyed()) return;
		// Any frame-to-frame scrollTop movement counts as an active gesture,
		// even when it never reached noteUserScroll (anchor restore at open,
		// height-compensation writes, TOC smooth jumps). While the book moves,
		// heavy sections get placeholders instead of 100-260ms full renders
		// that freeze the gesture; the movement check also keeps the very
		// first frames after open (restoring to a saved position) inside that
		// window.
		if (this.lastReconcileScrollTop !== null && Math.abs(scrollTop - this.lastReconcileScrollTop) >= 1) {
			this.noteUserScroll();
		}
		this.lastReconcileScrollTop = scrollTop;
		const order = this.host.fileOrder;
		if (order.length === 0) return;
		const winTop = scrollTop - OVERSCAN_TOP;
		const winBottom = scrollTop + clientHeight + this.host.loadMargin;
		// Offsets are non-decreasing, so binary search the first section that
		// can touch the window, then scan forward until past its bottom edge.
		let lo = 0;
		let hi = order.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const data = this.host.sections.get(order[mid] ?? '');
			const off = data ? data.offset : Number.MAX_SAFE_INTEGER;
			if (off < winTop) lo = mid + 1;
			else hi = mid;
		}
		for (let i = Math.max(0, lo - 1); i < order.length; i++) {
			const path = order[i] ?? '';
			const data = this.host.sections.get(path);
			if (!data) break;
			if (data.offset > winBottom) break;
			if (!isSectionInWindow(data.offset, data.height, scrollTop, clientHeight, OVERSCAN_TOP, this.host.loadMargin)) continue;
			// Mirror the IO callback: hidden-by-fold sections are never
			// rendered or unrendered; heading stubs (book-section-heading-folded)
			// are not hidden and still need their stub mounted.
			if (data.component) continue;
			if (data.el.classList.contains('book-section-folded')) continue;
			if (this.renderQueueSet.has(path)) continue;
			this.host.dbg('reconcile', path);
			this.enqueueRender(path);
		}
	}

	scheduleIdleUnload(): void {
		if (this.host.isDestroyed()) return;
		window.clearTimeout(this.idleUnloadTimer);
		this.idleUnloadTimer = window.setTimeout(() => {
			this.idleUnloadTimer = 0;
			this.unloadFarSections();
		}, IDLE_UNLOAD_DELAY);
	}

	pruneRenderQueue(pred: (path: string) => boolean): void {
		const kept: string[] = [];
		const set = new Set<string>();
		for (const p of this.renderQueue) {
			if (pred(p)) {
				kept.push(p);
				set.add(p);
			}
		}
		this.renderQueue = kept;
		this.renderQueueSet = set;
	}

	destroy(): void {
		this.renderQueue.length = 0;
		this.renderQueueSet.clear();
		this.ioPending.length = 0;
		this.upgradeQueue.length = 0;
		this.observer.disconnect();
		this.sectionResizeObserver.disconnect();
		window.clearTimeout(this.coldStartTimer);
		window.clearTimeout(this.idleTimer);
		window.clearTimeout(this.idleUnloadTimer);
		window.clearTimeout(this.ioWorkTimer);
		window.clearTimeout(this.deferredDrainTimer);
		window.clearTimeout(this.upgradePumpTimer);
	}

	/** Re-apply the placeholder transform from the always-current offset. The
	 *  layout only rewrites transforms inside a window around the viewport, so
	 *  a section that was far away when its offset changed must fix its own
	 *  position when it (re)mounts. */
	private applyTransform(path: string): void {
		const data = this.host.sections.get(path);
		if (!data) return;
		const transform = `translateY(${data.offset}px)`;
		if (data.el.style.transform !== transform) {
			data.el.style.transform = transform;
		}
	}

	private async loadSection(path: string): Promise<void> {
		this.dbgLoads++;
		const data = this.host.sections.get(path);
		if (!data || data.component) return;

		const cachedDom = this.host.renderedDomCache.get(path);
		if (cachedDom) {
			this.host.dbg('load-cached', path);
			this.host.renderedDomCache.delete(path);
			data.el.appendChild(cachedDom);
			this.applyTransform(path);
			this.host.foldTagSection(path, data.el);
			// data.firstType/lastType persist across unload (set at render time
			// or on the fresh render), and the cached DOM is immutable — no need
			// to re-walk the subtree on every load.
			if (data.foldHeadingHeight <= 0 && this.host.foldSectionNeedsFoldStub(path)) {
				this.host.foldScheduleHeightMeasure(path);
			}
			data.component = new Component();
			this.sectionResizeObserver.observe(data.el);
			data.deferralCount = 0;
			return;
		}

		const file = this.host.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;

		const gen = data.renderGen + 1;
		data.renderGen = gen;
		this.host.dbg('load-fresh', path);

		const content = this.host.rawContent.get(path) ?? await this.host.app.vault.cachedRead(file);
		if (this.host.isDestroyed() || data.renderGen !== gen) return;
		data.placeholder = false;
		if (content.length >= HEAVY_SECTION_CHARS) {
			this.host.dbg('heavy', path, content.length, Math.round(data.height));
		}

		data.startsWithHeading = startsWithHeading(content);
		data.endsWithHeading = endsWithHeading(content);

		// Render into a detached container: partial output is never visible
		// and unloadSection cannot cache half-rendered DOM mid-flight.
		const renderContainer = createDiv({
			cls: 'markdown-rendered markdown-preview-view',
		});

		const component = new Component();
		data.component = component;
		// Note: async renderers (mermaid, math) keep working after this await
		// resolves, so their SVG/HTML lands a beat later and the layout/paint
		// cost shows up after the section mounted — render-ms only captures the
		// synchronous part (parsing + DOM construction of the cheap blocks).
		const t0 = performance.now();
		await MarkdownRenderer.render(this.host.app, content, renderContainer, path, component);
		const renderMs = performance.now() - t0;

		if (this.host.isDestroyed() || data.renderGen !== gen || data.component !== component) {
			// The render was thrown away — a fast scroll unloaded the section
			// mid-flight, or the content was invalidated. That work was wasted;
			// this counter is what "defer heavy renders during fast scroll"
			// should drive to zero.
			this.dbgAborts++;
			this.host.dbg('abort-render', path, Math.round(renderMs));
			return;
		}
		this.dbgRenderMs += renderMs;
		if (renderMs >= RENDER_MS_LOG_THRESHOLD) {
			this.host.dbg('render-ms', path, Math.round(renderMs));
		}

		data.el.empty();
		data.el.appendChild(renderContainer);
		this.applyTransform(path);
		this.host.foldTagSection(path, data.el);
		const firstType = this.getFirstType(data.el);
		const lastType = this.getLastType(data.el);
		const typeChanged = firstType !== data.firstType || lastType !== data.lastType;
		data.firstType = firstType;
		data.lastType = lastType;
		// Fresh render may have changed the heading; invalidate. Re-measure at
		// idle time only when a folded stub actually needs the height.
		data.foldHeadingHeight = 0;
		if (this.host.foldSectionNeedsFoldStub(path)) {
			this.host.foldScheduleHeightMeasure(path);
		}
		this.sectionResizeObserver.observe(data.el);
		data.deferralCount = 0;
		this.host.getOnSectionRendered()?.(path, renderContainer);
		// Recalculate only when something that affects the layout actually
		// changed: the heading flags (which drive the gaps), or a fold mode
		// ('full' sections must be unmounted, 'heading' stubs measured). A
		// render that matches the estimate, or a re-render of identical
		// content, needs no recalc — offsets stay correct and the height
		// correction arrives separately through reportSectionHeight. Without
		// this gate every section load forced a full recalcOffsets over the
		// whole book (~25ms on 2000 notes, visible as the pendingHeights=0
		// 'update' lines in the debug log).
		if (typeChanged || this.host.getFoldMode(path) !== 'none') {
			this.host.scheduleUpdate();
		}
	}

	/** Current scroll position, read live at most once per LIVE_READ_TTL.
	 *  The IO-dispatch position (ioScrollTop) can drift past a section that
	 *  entered the window mid-gesture; this read grounds the drop decision in
	 *  where the user actually is. Called only for out-of-band candidates. */
	private readLiveScrollTop(): number {
		if (this.liveScrollTop === null || Date.now() - this.liveScrollAt > LIVE_READ_TTL) {
			this.liveScrollTop = this.host.scrollContainer.scrollTop;
			this.liveScrollAt = Date.now();
		}
		return this.liveScrollTop;
	}

	/**
	 * Cheap placeholder render for a heavy section while the user is actively
	 * scrolling: the raw markdown with `$$`/mermaid blocks replaced by
	 * estimated-height divs, limited to the note's opening (buildPlaceholderContent).
	 * The synchronous part of MarkdownRenderer.render drops from 100-260ms to a
	 * couple of ms, so the text of the note shows immediately instead of a blank
	 * gap. The preview is mounted inside a box fixed to the section's current
	 * data.height (and the box is the whole section content), so mounting it
	 * measures back the height the layout already expects — no height correction,
	 * no offset cascade, no IntersectionObserver re-fire storm. The full render
	 * (with real formulas) replaces this DOM once the gesture settles. The render
	 * is never cached as the full DOM and does not touch the ToC; the upgrade does.
	 */
	private async loadPlaceholder(path: string): Promise<void> {
		this.dbgLoads++;
		const data = this.host.sections.get(path);
		if (!data || data.component) return;

		// Use the content already read by the batch reconcile read. A fresh
		// cachedRead per placeholder is a vault disk read on the critical path
		// of an active gesture — the placeholder is a stopgap, not worth a read.
		// If the content hasn't landed yet, skip: reconcileVisibleSections
		// re-enqueues the section next frame and it either placeholders then or
		// gets its full render once the gesture settles.
		const content = this.host.rawContent.get(path);
		if (content === undefined) {
			this.host.dbg('placeholder-skip', path);
			return;
		}

		const gen = data.renderGen + 1;
		data.renderGen = gen;
		this.host.dbg('placeholder-render', path);

		const renderContainer = createDiv({
			cls: 'markdown-rendered markdown-preview-view',
		});

		const component = new Component();
		data.component = component;
		data.placeholder = true;
		const t0 = performance.now();
		await MarkdownRenderer.render(this.host.app, buildPlaceholderContent(content), renderContainer, path, component);
		const renderMs = performance.now() - t0;

		if (this.host.isDestroyed() || data.renderGen !== gen || data.component !== component) {
			// Thrown away — a fast scroll unloaded the section mid-render.
			this.dbgAborts++;
			this.host.dbg('abort-render', path, Math.round(renderMs));
			return;
		}
		this.dbgRenderMs += renderMs;

		// Fixed-height box: the mounted section's height is exactly data.height
		// (the layout's current value for it), so the resize observer reports no
		// change and no correction/recalc runs. Without the box the preview's
		// measured height differed from the estimate by up to hundreds of px,
		// each placeholder mount shifted every following section and re-fired
		// the whole IO window (io=2056 in one bad window) — the feedback loop
		// that made cold starts as janky as the full renders they replaced.
		// Folded sections are the exception: the fold collapses the content to a
		// heading stub, so a box fixed to the full unfolded height would leave a
		// huge empty region under the stub. Mount those without the box and let
		// the fold's own stub measurement correct the height as usual.
		const foldMode = this.host.getFoldMode(path);
		if (foldMode === 'none') {
			const box = createDiv({ cls: 'book-view-ph-box' });
			box.style.height = `${Math.round(data.height)}px`;
			box.appendChild(renderContainer);
			data.el.empty();
			data.el.appendChild(box);
		} else {
			data.el.empty();
			data.el.appendChild(renderContainer);
		}
		this.applyTransform(path);
		this.host.foldTagSection(path, data.el);
		// No onSectionRendered (ToC tagging) and no fold-stub measurement here:
		// the placeholder is transient, and the upgrade re-tags/re-measures. No
		// scheduleUpdate either: the box matches data.height, so there is nothing
		// for the resize observer to correct.
		this.sectionResizeObserver.observe(data.el);
		data.deferralCount = 0;
	}

	/** Queue the placeholder sections still in the load window for full renders,
	 *  nearest to the viewport first, then pump them one at a time. Called once
	 *  the scroll gesture has settled. */
	private upgradePlaceholders(): void {
		const primary = this.ioScrollTop ?? this.host.getScrollTop();
		const clientHeight = this.host.getClientHeight();
		const viewportCenter = primary + clientHeight / 2;
		const candidates: Array<[string, number]> = [];
		for (const [path, data] of this.host.sections) {
			if (!data.placeholder || !data.component) continue;
			if (!isSectionInWindow(data.offset, data.height, primary, clientHeight, OVERSCAN_TOP, this.host.loadMargin)) continue;
			const mid = data.offset + data.height / 2;
			candidates.push([path, Math.abs(mid - viewportCenter)]);
		}
		if (candidates.length === 0) return;
		candidates.sort((a, b) => a[1] - b[1]);
		for (const [p] of candidates) {
			if (!this.upgradeQueue.includes(p)) this.upgradeQueue.push(p);
		}
		this.pumpUpgrades();
	}

	/** Run one placeholder→full upgrade, then schedule the next after a gap. A
	 *  resumed gesture pauses the pump: the remaining sections stay placeholders
	 *  and the settle timer re-arms. Each full render blocks the main thread for
	 *  150-260ms, so upgrading concurrently would re-freeze the UI — one at a
	 *  time keeps the freeze short and lets scroll frames run between steps. */
	private pumpUpgrades(): void {
		if (this.host.isDestroyed()) return;
		if (this.upgradeInFlight) return;
		if (Date.now() - this.lastUserScrollTimestamp < HEAVY_DEFER_MS) {
			// Gesture resumed — postpone the rest of the queue.
			this.scheduleDeferredDrain();
			return;
		}
		const path = this.upgradeQueue.shift();
		if (!path) return;
		const data = this.host.sections.get(path);
		if (!data || !data.placeholder || !data.component) {
			// Stale entry (unloaded or already replaced) — skip it.
			this.pumpUpgrades();
			return;
		}
		const primary = this.ioScrollTop ?? this.host.getScrollTop();
		const clientHeight = this.host.getClientHeight();
		if (!isSectionInWindow(data.offset, data.height, primary, clientHeight, OVERSCAN_TOP, this.host.loadMargin)) {
			this.pumpUpgrades();
			return;
		}
		this.dbgUpgrades++;
		this.host.dbg('upgrade', path);
		this.upgradeInFlight = true;
		void this.upgradePlaceholder(path).finally(() => {
			this.upgradeInFlight = false;
			if (this.host.isDestroyed()) return;
			this.upgradePumpTimer = window.setTimeout(() => {
				this.upgradePumpTimer = 0;
				this.pumpUpgrades();
			}, UPGRADE_STEP_DELAY);
		});
	}

	private upgradePlaceholder(path: string): Promise<void> {
		const data = this.host.sections.get(path);
		if (!data || !data.placeholder || !data.component) return Promise.resolve();
		data.placeholder = false;
		// Release the placeholder's component and observation, but keep its DOM
		// mounted while the full render runs: loadSection swaps it out on
		// completion, so the user keeps seeing the text instead of a blank gap
		// during the 150-260ms formula render.
		this.sectionResizeObserver.unobserve(data.el);
		data.component.unload();
		data.component = null;
		data.renderGen++;
		return this.loadSection(path);
	}

	private drainQueue(): void {
		if (this.host.isDestroyed()) return;
		const t0 = performance.now();
		// Fast scroll enqueues every section that crossed the overscan window,
		// but renders run at maxConcurrent so the queue drains slower than a
		// fast gesture fills it. By drain time most entries are already far past
		// the viewport; rendering them is wasted main-thread work that keeps the
		// app janky for seconds after the scroll settles. Read the window once
		// and drop entries that drifted outside it.
		//
		// The primary position is the one captured at the IO dispatch, not the
		// manager's frame snapshot: the snapshot lags IO delivery (the IO fires
		// in its own task while the rAF callback can be starved). But a single
		// dispatch position can itself drift far past a section that entered
		// the window mid-gesture and that the user now rests on — dropping it
		// there would blank a section the IO never re-enqueues (already
		// intersecting). So a drop is only final after a live read agrees the
		// section is far from where the user actually is. The live read is
		// TTL-cached: the common settled case (sections in window, no drops)
		// never pays it, and during churn it runs at most once per window.
		const primary = this.ioScrollTop ?? this.host.getScrollTop();
		const clientHeight = this.host.getClientHeight();
		const margin = OVERSCAN_TOP + this.host.loadMargin;
		const primaryBottom = primary + clientHeight;
		// Heavy sections (block math / mermaid) spend 100-260ms in the
		// synchronous part of MarkdownRenderer.render. During an active gesture
		// that stalls the main thread mid-scroll, and several enqueued at once
		// freeze the page for hundreds of ms. While the gesture is fresh, render
		// the cheap placeholder version instead (text with formula placeholders)
		// and upgrade to the full render once it settles (scheduleDeferredDrain).
		// A cached full DOM is preferred over the placeholder: remounting it is
		// <1ms. Light sections keep rendering underneath, exactly as before.
		const scrolling = Date.now() - this.lastUserScrollTimestamp < HEAVY_DEFER_MS;
		let placeholders = 0;
		let staleDropped: string[] = [];
		// shift() per item was O(n²) when a cold-start IO storm queued ~2000
		// sections at once. Consume a prefix by index and remove it with one
		// splice; every branch below consumes the item (drops it, defers it, or
		// starts an async render), so the loop either hits maxConcurrent or
		// empties the queue.
		let head = 0;
		while (this.activeRenderCount < this.maxConcurrent && head < this.renderQueue.length) {
			const path = this.renderQueue[head++]!;
			this.renderQueueSet.delete(path);
			const data = this.host.sections.get(path);
			if (!data || data.component) continue;
			// The `heavy` flag is set by the async cachedRead in render() and can
			// lag the first enqueue (reconcile/IO may fire a frame earlier). Fall
			// back to a scan of the raw content when the flag hasn't landed yet,
			// so a section is never full-rendered mid-gesture just because its
			// read resolved a frame too late.
			const raw = this.host.rawContent.get(path);
			const heavy = data.heavy || (raw !== undefined && isHeavyContent(raw));
			// Shared staleness gate, applied before the placeholder branch too:
			// a full render of a far-drifted section is churn, and a placeholder
			// of one is worse — the mount+measure would shift the layout for
			// something offscreen. reconcileVisibleSections re-enqueues it the
			// moment it actually re-enters the window, so dropping is safe.
			if (isStaleRender(data.offset, data.height, primary, primaryBottom, margin)) {
				// Only an out-of-band candidate pays for the live read.
				const live = this.readLiveScrollTop();
				if (isStaleForDrain(data.offset, data.height, primary, primaryBottom, live, live + clientHeight, margin)) {
					staleDropped.push(path);
					continue;
				}
			}
			// The `heavy` flag and rawContent land asynchronously (cachedRead in
			// render()). When neither has arrived yet the section is
			// unclassified, and full-rendering it mid-gesture could mean a
			// 100-260ms math render inside a scroll frame. Defer instead —
			// reconcileVisibleSections re-enqueues it every frame, so it
			// placeholders (if heavy) or renders normally the moment the read
			// lands. Bounded by deferralCount: a read that never resolves would
			// otherwise blank the section forever while the user stands on it.
			if (raw === undefined && scrolling) {
				if (data.deferralCount < MAX_CONTENT_PENDING_SKIPS) {
					data.deferralCount++;
					this.host.dbg('content-pending', path, data.deferralCount);
					continue;
				}
				this.host.dbg('content-pending-force', path, data.deferralCount);
			}
			if (heavy && scrolling && !this.host.renderedDomCache.has(path)) {
				this.dbgPlaceholders++;
				placeholders++;
				this.activeRenderCount++;
				void this.loadPlaceholder(path).finally(() => {
					this.activeRenderCount--;
					this.drainQueue();
				});
				continue;
			}
			this.activeRenderCount++;
			void this.loadSection(path).finally(() => {
				this.activeRenderCount--;
				this.drainQueue();
			});
		}
		if (head > 0) {
			this.renderQueue.splice(0, head);
		}
		if (placeholders > 0) {
			this.scheduleDeferredDrain();
		}
		if (staleDropped.length > 0) {
			if (staleDropped.length <= DROP_STALE_LOG_MAX) {
				for (const p of staleDropped) this.host.dbg('drop-stale-render', p);
			} else {
				this.host.dbg('drop-stale-render', '', staleDropped.length);
			}
		}
		this.dbgQueueMs += performance.now() - t0;
	}

	/** Upgrade placeholder sections to their full render once the gesture has
	 *  had time to settle, then re-drain the queue. Re-armed on every defer, so
	 *  a long gesture just keeps pushing the upgrade forward; the first timer
	 *  after the settle window replaces placeholders with real formulas. */
	private scheduleDeferredDrain(): void {
		if (this.host.isDestroyed()) return;
		if (this.deferredDrainTimer) return;
		this.deferredDrainTimer = window.setTimeout(() => {
			this.deferredDrainTimer = 0;
			if (this.host.isDestroyed()) return;
			this.upgradePlaceholders();
			this.scheduleIoWork();
		}, HEAVY_DEFER_MS);
	}

	private processIoPending(): void {
		if (this.ioPending.length === 0) return;
		const t0 = performance.now();
		const pending = this.ioPending;
		this.ioPending = [];
		// Unload far sections immediately instead of deferring until the
		// scroll settles. Deferring made the DOM grow with every section the
		// user scrolled past, which caused a multi-second lag after long fast
		// scrolls while the accumulated sections were torn down. Immediate
		// unload keeps the mounted set small; DOM is parked in the render
		// cache, so scrolling back reattaches without a full re-render.
		for (const item of pending) {
			if (this.host.isDestroyed()) continue;
			if (item.intersecting) {
				this.enqueueRender(item.path);
			} else {
				this.unloadSection(item.path);
			}
		}
		this.dbgQueueMs += performance.now() - t0;
	}

	private unloadFarSections(): void {
		if (this.host.isDestroyed()) return;
		if (Date.now() - this.lastUserScrollTimestamp < PRERENDER_SETTLE) {
			this.scheduleIdleUnload();
			return;
		}
		// Use the computed offsets/heights instead of getBoundingClientRect:
		// rect reads force a full recalc of whatever the last scroll frame
		// dirtied, turning idle cleanup into a big synchronous layout spike.
		const scrollTop = this.host.scrollContainer.scrollTop;
		const viewport = this.host.scrollContainer.clientHeight;
		const margin = OVERSCAN_TOP + this.host.loadMargin + FAR_UNLOAD_MARGIN;
		for (const [path, data] of this.host.sections) {
			if (!data.component) continue;
			const end = data.offset + data.height;
			if (end < scrollTop - margin || data.offset > scrollTop + viewport + margin) {
				this.unloadSection(path);
			}
		}
	}

	private schedulePreRender(): void {
		if (this.host.isDestroyed()) return;
		window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => void this.preRenderBatch(), PRERENDER_DELAY);
	}

	private preRenderBatch(): void {
		if (this.host.isDestroyed()) return;
		// Never pre-measure while the user is actively scrolling: the resulting
		// height corrections would land in the middle of wheel/touch gestures.
		if (Date.now() - this.lastUserScrollTimestamp < PRERENDER_SETTLE) {
			this.schedulePreRender();
			return;
		}
		// Render a whole window of sections around the current anchor (nearest
		// first) so first mounts and their first layout happen while idle —
		// by the time the user scrolls there the section is already mounted,
		// laid out, and height-measured, so the scroll frames stay free.
		const paths = this.nextPreRenderPaths(PRERENDER_BATCH);
		if (paths.length === 0) return;
		for (const path of paths) {
			this.dbgPrerenders++;
			this.host.dbg('pre-render', path);
			void this.loadSection(path).then(() => {
				window.setTimeout(() => {
					if (this.host.isDestroyed()) return;
					this.parkIfOutOfZone(path);
					this.schedulePreRender();
				}, PRERENDER_PARK_DELAY);
			});
		}
	}

	private parkIfOutOfZone(path: string): void {
		if (Date.now() - this.lastUserScrollTimestamp < PRERENDER_SETTLE) return;
		const data = this.host.sections.get(path);
		if (!data?.component) return;
		// Offset math instead of rects: reading getBoundingClientRect here
		// forces a recalc of everything the load just dirtied. (scrollTop /
		// clientHeight are cheaper reads but still flush; they are idle-safe
		// because of the scroll guard above.)
		const scrollTop = this.host.scrollContainer.scrollTop;
		const viewport = this.host.scrollContainer.clientHeight;
		const end = data.offset + data.height;
		const inZone = end > scrollTop - OVERSCAN_TOP && data.offset < scrollTop + viewport + this.host.loadMargin;
		// Park the measured DOM in the cache so memory stays bounded.
		if (!inZone) this.unloadSection(path);
	}

	private nextPreRenderPaths(count: number): string[] {
		const anchor = this.host.findAnchorAt(this.host.scrollContainer.scrollTop);
		const center = anchor?.idx ?? 0;
		const scrollTop = this.host.scrollContainer.scrollTop;
		const viewport = this.host.scrollContainer.clientHeight;
		const windowTop = scrollTop - OVERSCAN_TOP - this.host.loadMargin;
		const windowBottom = scrollTop + viewport + this.host.loadMargin + PRERENDER_WINDOW;
		const result: string[] = [];
		for (let step = 0; step < this.host.fileOrder.length && result.length < count; step++) {
			const candidates = [center - step, center + step];
			for (const idx of candidates) {
				if (result.length >= count) break;
				if (idx < 0 || idx >= this.host.fileOrder.length) continue;
				const path = this.host.fileOrder[idx];
				if (!path) continue;
				const data = this.host.sections.get(path);
				if (!data || data.component) continue;
				if (data.heightTrusted) continue;
				if (this.host.renderedDomCache.has(path)) continue;
				// Pre-render only inside a window around the viewport. When the
				// near field is fully trusted+mounted the walk used to skip
				// ~thousands of entries and land on the first unmeasured note
				// (e.g. Note_1055 while the viewport sat at Note_0003); that
				// batch was then thrown away by parkIfOutOfZone after a full
				// mount + measure + recalc, and the recalc spiked every batch
				// straight into the user's scroll frames.
				const end = data.offset + data.height;
				if (end < windowTop || data.offset > windowBottom) continue;
				result.push(path);
			}
		}
		return result;
	}

	private getFirstType(container: HTMLElement): string {
		const first = getFirstContentElement(container);
		if (!first) return 'text';
		const level = getHeaderLevel(first);
		return level ?? 'text';
	}

	private getLastType(container: HTMLElement): string {
		const last = getLastContentElement(container);
		if (!last) return 'text';
		const level = getHeaderLevel(last);
		return level ?? 'text';
	}
}
