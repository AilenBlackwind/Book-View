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
	renderGen: number;
	mtime: number;
	heightTrusted: boolean;
	wasHidden: boolean;
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
	private activeRenderCount = 0;
	private maxConcurrent = 1;
	private coldStartTimer = 0;
	private idleTimer = 0;
	private lastUserScrollTimestamp = 0;

	// Debug counters (live in the togglable debug layer).
	dbgIo = 0;
	dbgLoads = 0;
	dbgUnloads = 0;
	dbgPrerenders = 0;

	dbgReset(): [number, number, number, number] {
		const r: [number, number, number, number] = [this.dbgIo, this.dbgLoads, this.dbgUnloads, this.dbgPrerenders];
		this.dbgIo = 0;
		this.dbgLoads = 0;
		this.dbgUnloads = 0;
		this.dbgPrerenders = 0;
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
				renderGen: 0,
				mtime,
				heightTrusted: cached !== undefined,
				wasHidden: false,
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
		if (this.renderQueue.includes(path)) return;
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
		// closes, and a fresh render on unfold is instant anyway.
		if (this.host.getFoldMode(path) !== 'full') {
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
			if (this.renderQueue.includes(path)) continue;
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
		this.renderQueue = this.renderQueue.filter(pred);
	}

	destroy(): void {
		this.renderQueue.length = 0;
		this.ioPending.length = 0;
		this.observer.disconnect();
		this.sectionResizeObserver.disconnect();
		window.clearTimeout(this.coldStartTimer);
		window.clearTimeout(this.idleTimer);
		window.clearTimeout(this.idleUnloadTimer);
		window.clearTimeout(this.ioWorkTimer);
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
			return;
		}

		const file = this.host.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;

		const gen = data.renderGen + 1;
		data.renderGen = gen;
		this.host.dbg('load-fresh', path);

		const content = this.host.rawContent.get(path) ?? await this.host.app.vault.cachedRead(file);
		if (this.host.isDestroyed() || data.renderGen !== gen) return;

		data.startsWithHeading = startsWithHeading(content);
		data.endsWithHeading = endsWithHeading(content);

		// Render into a detached container: partial output is never visible
		// and unloadSection cannot cache half-rendered DOM mid-flight.
		const renderContainer = createDiv({
			cls: 'markdown-rendered markdown-preview-view',
		});

		const component = new Component();
		data.component = component;
		await MarkdownRenderer.render(this.host.app, content, renderContainer, path, component);

		if (this.host.isDestroyed() || data.renderGen !== gen || data.component !== component) return;

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

	private drainQueue(): void {
		if (this.host.isDestroyed()) return;
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
		while (this.activeRenderCount < this.maxConcurrent && this.renderQueue.length > 0) {
			const path = this.renderQueue.shift()!;
			const data = this.host.sections.get(path);
			if (!data || data.component) continue;
			if (isStaleRender(data.offset, data.height, primary, primaryBottom, margin)) {
				// Only an out-of-band candidate pays for the live read.
				const live = this.readLiveScrollTop();
				if (isStaleForDrain(data.offset, data.height, primary, primaryBottom, live, live + clientHeight, margin)) {
					this.host.dbg('drop-stale-render', path);
					continue;
				}
			}
			this.activeRenderCount++;
			void this.loadSection(path).finally(() => {
				this.activeRenderCount--;
				this.drainQueue();
			});
		}
	}

	private processIoPending(): void {
		if (this.ioPending.length === 0) return;
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
