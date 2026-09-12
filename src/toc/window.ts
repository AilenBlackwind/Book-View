import { TocState } from './state';
import type { TocBuilder } from './builder';
import { firstItemAt, firstItemAfter } from './virtual';
import type { VirtualItem } from './virtual';
import { TOC_SHADOW_CSS } from './shadow.css';
import { DebugLog } from '../utils/debug';

/** Extra rows rendered above/below the visible panel range. */
const OVERSCAN = 10;

/** Experiment A/B (resolved): large visibility rebuilds fill the row window
 *  across a few rAFs (see startIncrementalFill); the synchronous path remains
 *  for scroll-window moves and small rebuilds (INCREMENTAL_THRESHOLD). */
const INCREMENTAL_THRESHOLD = 24;

/** Rows created per rAF during an incremental fill. Roughly matches the ~15
 *  rows per ~8ms a big expansion moved per paint when profiled, i.e. one
 *  sub-frame of work that does not dominate the 16ms budget. */
const INCREMENTAL_BATCH = 16;

/** Duration of the row position/opacity animation on expand/collapse rebuilds
 *  (ms). Fast but readable: a fold/unfold reads as rows flowing into place
 *  (FLIP glide on survivors, slink + fade on fresh rows) instead of snapping. */
const ROW_ANIM_MS = 140;

/** How long the just-opened/just-closed section heading pulses (ms). */
const PULSE_MS = 300;

/**
 * Virtualized row window for the ToC panel. The panel is a plain scrollable
 * container holding a spacer (sets the total scroll height) and one absolutely
 * positioned list element whose rows are re-created only when the visible
 * range [start, end) changes. The panel DOM stays O(viewport + overscan)
 * regardless of book size.
 */
export class TocWindow {
	private spacerEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	/** Last height written to the spacer (px). The spacer height only changes
	 *  when the virtual total changes (expand/collapse), so writing it on
	 *  every render dirties the spacer's style — now a leaf, but still cheaper
	 *  to skip when unchanged. */
	private spacerHeightPx = -1;
	private startIndex = 0;
	private endIndex = 0;
	/** The virtual item list rendered in the current window. Compared against
	 *  `state.virtualItems` so a collapse that hides/folds rows re-creates the
	 *  window even when the visible [start, end) range did not move. */
	private renderedItems: VirtualItem[] | null = null;
	/** When a visibility rebuild needs to create many fresh rows (auto-expand
	 *  of a large section), the row window is filled progressively — a batch of
	 *  rows per rAF — instead of tearing up and re-creating the whole window in
	 *  one main-thread hit. `incrementalFrom` is the next desired row index to
	 *  create; -1 while not filling. */
	private incrementalFrom = -1;
	private incrementalItems: VirtualItem[] | null = null;
	private incrementalEnd = 0;
	private incrementalByKey: Map<string, HTMLElement> | null = null;
	private incrementalAnimate = false;
	private incrementalRaf = 0;
	private scrollHandler: (() => void) | null = null;
	private clickHandler: ((evt: MouseEvent) => void) | null = null;
	private renderScheduled = false;
	/** Debug-only probe (see installDebugProbe): original PropertyDescriptor
	 *  backups needed to restore the panel accessors in destroy(). */
	private dbgOrigScrollTop: PropertyDescriptor | null = null;
	private dbgOrigScrollTo: (() => void) | null = null;
	private dbgOrigScrollBy: (() => void) | null = null;

	/** Called after a row-window rebuild (used to re-host the highlight pill
	 *  into the active row, which may have been re-created). */
	onRowsRendered: (() => void) | null = null;

	constructor(private state: TocState, private builder: TocBuilder) {}

	/** Build the panel skeleton (spacer + window + highlight bar) and render
	 *  the initial row window. */
/** Build the panel skeleton (spacer + window + highlight bar) and render
	 *  the initial row window. Rows live inside a shadow root attached to the
	 *  panel's content element so document-level `:has()` selectors (Obsidian's
	 *  reading-enhancement sheet re-scans every div ancestor of an inserted
	 *  node) can never see them: a wheel-glide auto-expand used to hit a
	 *  ~670-element panel-wide style recalc on every crossing. The highlight
	 *  and the row window are separated again — the spacer is a bare height
	 *  holder, the list + pill are its siblings — and the shadow CSS (mirror of
	 *  the ToC block in styles.css) is injected as a <style> child. */
	mount(): void {
		const s = this.state;
		// Scope layout invalidation to this panel: applyVisibility mutates ToC
		// rows + highlight + scrollTop, and without containment each mutation
		// wakes layout from <body> down (500+ elements, ~9ms forced reflow).
		// With containment the browser scopes the reflow to this subtree.
		s.containerEl.addClass('bv-contain-layout');
		const shadow = s.ensureShadow();
		// mount() is only reached from a fresh view bind (destroy already
		// emptied the shadow), so a defensive drop of leftover rows/highlight is
		// safe and keeps the already-injected <style>. The incremental rebuild
		// (TocController.rebuild) never reaches here — it renders in place.
		shadow.replaceChildren();
		const style = s.containerEl.ownerDocument.createElement('style');
		style.textContent = TOC_SHADOW_CSS;
		shadow.appendChild(style);
		const tocEl = s.containerEl.ownerDocument.createElement('section');
		tocEl.className = 'bv-toc';
		shadow.appendChild(tocEl);
		if (s.settings?.tocGuides) {
			tocEl.classList.add('bv-toc-guides');
		}
		this.spacerEl = tocEl.createEl('section', { cls: 'bv-toc-spacer' });
		// The highlight bar lives in the row window's parent (not the spacer,
		// which is now a bare height holder), so it is never touched by the row
		// reconciliation loop and can be moved with transform-only writes
		// instead of reparenting into rows. The pill shares the tocEl
		// coordinate space with the spacer (spacer is its first in-flow child),
		// so virtual row offsets are exact for both.
		this.listEl = tocEl.createEl('ul', { cls: 'bv-toc-list' });
		s.highlightHost = tocEl;
		// highlightEl is NOT created here — TocSpy.movePill lazily creates it
		// as a child of the row window's parent on the first highlight
		// application.
		this.render();
	}

	/** Re-render the row window for the current panel scroll position. No-op
	 *  when the visible range did not change. */
	render(): void {
		const s = this.state;
		const listEl = this.listEl;
		const spacerEl = this.spacerEl;
		if (!listEl || !spacerEl) {
			this.cancelIncremental();
			return;
		}

		const items = s.virtualItems;
		const offsets = s.virtualOffsets;
		const n = items.length;
		const viewport = s.tocViewportHeight > 0 ? s.tocViewportHeight : s.containerEl.clientHeight;
		const scrollTop = s.panelScrollTop;

		// Mid-fill: keep the running batch alive on its own rAF, but only while
		// the visible scroll range still falls inside the window being filled
		// (the fill lags a panel scroll that leaps outside its range — then it
		// is cancelled and the range is rebuilt synchronously).
		if (this.incrementalFrom >= 0 && this.incrementalItems === items) {
			const coveredTop = offsets[this.startIndex] ?? 0;
			const coveredBottom = offsets[this.endIndex] ?? Infinity;
			if (coveredTop <= scrollTop && scrollTop + viewport <= coveredBottom) {
				this.scheduleFillFrame();
				return;
			}
			this.cancelIncremental();
		}

		if (n === 0) {
			this.cancelIncremental();
			spacerEl.setCssProps({ height: '0px' });
			this.startIndex = 0;
			this.endIndex = 0;
			listEl.empty();
			s.rowByEntry.clear();
			s.rowAnchorByEntry.clear();
			return;
		}

		const total = offsets[n] ?? 0;
		if (this.spacerHeightPx !== total) {
			this.spacerHeightPx = total;
			spacerEl.style.height = `${total}px`;
		}

		// Lazy window: the rendered range only has to *cover* the visible one
		// (it already spans OVERSCAN rows past it), so a scroll that stays
		// inside the rendered range is a no-op instead of a full row rebuild.
		// Wheel scrolling moves a few rows per event, so this turns per-event
		// rebuilds into one per ~OVERSCAN rows — the dominant panel-scroll cost
		// is DOM churn, not the range math. Row screen positions stay exact
		// (absolute list + virtual offsets), so the lag is invisible until the
		// scroll reaches the window edge, where a rebuild re-centers it.
		if (
			this.renderedItems === items &&
			(offsets[this.startIndex] ?? 0) <= scrollTop &&
			scrollTop + viewport <= (offsets[this.endIndex] ?? Infinity)
		) {
			return;
		}

		// A structural render is one where the virtual item set changed (a
		// visibility rebuild): reused rows move to new offsets and fresh rows
		// appear. Scroll-window moves keep the same items and only append rows
		// past the scroll edge, so those never animate. The opening build
		// (fresh panel mount, `renderedItems === null`) is not animated either.
		const structural = this.renderedItems !== items;
		const animate =
			structural && this.renderedItems !== null && (s.settings?.tocExpandAnim ?? true);

		let start = firstItemAt(offsets, scrollTop, n);
		let end = firstItemAfter(offsets, scrollTop + viewport, n);
		start = Math.max(0, start - OVERSCAN);
		end = Math.min(n, end + OVERSCAN);

		// Data change (rebuildVirtualData after a collapse/expand) re-creates
		// the window even if the range is identical: rows below the fold got
		// hidden/folded and the surviving rows need fresh collapsed/leaf state.
		if (start === this.startIndex && end === this.endIndex && this.renderedItems === items) return;

		this.cancelIncremental();
		this.startIndex = start;
		this.endIndex = end;
		this.renderedItems = items;

		// Rows are absolutely positioned at their virtual offsets (top set per
		// row), so the list element itself never needs to translate — inserting
		// or removing a row does not shift any sibling.
		s.rowByEntry.clear();
		s.rowAnchorByEntry.clear();

		// Recycle page rows: keep and patch existing heading/file rows in place
		// (matched by data-index) instead of tearing down the whole list, so a
		// visibility/path change mutates the same DOM nodes. Because rows are
		// absolutely positioned, DOM order never affects layout — each new row
		// simply appends and unused ones are removed at the end. Live auto-expand
		// rebuilds the window on every active-path crossing, so the reuse
		// scan is keyed by row kind + data-index in one pass instead of
		// scanning the present set per desired row (O(rows²) on every build).
		const present = new Set<HTMLElement>(Array.from(listEl.children) as HTMLElement[]);
		const byKey = new Map<string, HTMLElement>();
		for (const child of present) {
			const idx = child.dataset.index;
			if (!idx) continue;
			// file and heading row indices share a numeric space; key both so
			// a file row with file index N never reuses a heading row with
			// entry index N (or vice versa).
			const kind = child.classList.contains('bv-toc-file') ? 'file' : 'heading';
			byKey.set(`${kind}:${idx}`, child);
		}

		// Count how many rows in [start, end) already exist (reusable). When a
		// large expansion creates most of the visible rows fresh, building the
		// window in one hit pays a ~24ms panel-wide recalc that hitches the
		// frame. Spreading the *creation* over a few rAF (rows land at exact
		// offsets, so positions never shift, the list just fills in) turns the
		// single spike into several small ones. Small rebuilds and scrolls
		// stay fully synchronous.
		let newRows = 0;
		for (let i = start; i < end; i++) {
			const item = items[i];
			if (!item) continue;
			const kind = item.type === 'file' ? 'file' : 'heading';
			if (!byKey.has(`${kind}:${item.index}`)) newRows++;
		}

		if (newRows >= INCREMENTAL_THRESHOLD) {
			this.startIncrementalFill(start, end, items, byKey, animate);
			return;
		}

		this.renderWindowRange(start, end, byKey, animate);
		this.pulseToggled();
		this.onRowsRendered?.();
	}

	/** Synchronously build every row in [start, end) into `listEl`. Rows are
	 *  absolutely positioned at their virtual offsets, so build order is
	 *  irrelevant to layout; reused rows keep their node (patched), new rows
	 *  append, and unused rows are removed at the end. Used for scroll-window
	 *  moves and small rebuilds; large fills go through startIncrementalFill. */
	private renderWindowRange(
		start: number,
		end: number,
		byKey: Map<string, HTMLElement>,
		animate: boolean,
	): void {
		const s = this.state;
		const listEl = this.listEl!;
		for (let i = start; i < end; i++) {
			const item = s.virtualItems[i];
			if (!item) continue;
			this.buildRow(listEl, item, byKey, s.virtualOffsets[i] ?? 0, animate);
		}
		this.removeUnused(byKey);
	}

	/** Kick off an incremental fill of the visible window when a rebuild has to
	 *  create many fresh rows: the first batch renders immediately (the viewport
	 *  is populated right away, rows land at their exact offsets so nothing
	 *  shifts), then one rAF drives each subsequent batch. */
	private startIncrementalFill(
		start: number,
		end: number,
		items: VirtualItem[],
		byKey: Map<string, HTMLElement>,
		animate: boolean,
	): void {
		this.incrementalFrom = start;
		this.incrementalEnd = end;
		this.incrementalItems = items;
		this.incrementalByKey = byKey;
		this.incrementalAnimate = animate;
		this.fillWindowBatch();
	}

	/** Create and reconcile the next INCREMENTAL_BATCH of rows, then either
	 *  schedule the following batch or finish the fill (removing leftover rows
	 *  and firing onRowsRendered so the highlight re-hosts). */
	private fillWindowBatch(): void {
		const listEl = this.listEl;
		if (!listEl) {
			this.cancelIncremental();
			return;
		}
		if (this.incrementalFrom < 0 || this.incrementalEnd < 0) return;
		const items = this.incrementalItems!;
		const byKey = this.incrementalByKey!;
		const offsets = this.state.virtualOffsets;

		const from = this.incrementalFrom;
		const to = Math.min(this.incrementalEnd, from + INCREMENTAL_BATCH);
		// Rows are absolutely positioned, so a batch can simply create/append
		// its rows at their virtual offsets — no ordering or slot reconciles.
		for (let i = from; i < to; i++) {
			const item = items[i];
			if (!item) continue;
			this.buildRow(listEl, item, byKey, offsets[i] ?? 0, this.incrementalAnimate);
		}
		this.incrementalFrom = to;

		if (this.incrementalFrom >= this.incrementalEnd) {
			this.removeUnused(byKey);
			this.incrementalFrom = -1;
			this.incrementalItems = null;
			this.incrementalByKey = null;
			this.incrementalRaf = 0;
			this.pulseToggled();
			this.onRowsRendered?.();
			return;
		}

		this.scheduleFillFrame();
	}

	/** Schedule the next incremental-fill rAF, coalescing duplicate schedules. */
	private scheduleFillFrame(): void {
		if (this.incrementalFrom < 0) return;
		if (this.incrementalRaf) return;
		this.incrementalRaf = window.requestAnimationFrame(() => {
			this.incrementalRaf = 0;
			this.fillWindowBatch();
		});
	}

	/** Abort any in-flight incremental fill (teardown, full re-render, empty
	 *  list). */
	private cancelIncremental(): void {
		this.incrementalFrom = -1;
		this.incrementalItems = null;
		this.incrementalByKey = null;
		if (this.incrementalRaf) {
			window.cancelAnimationFrame(this.incrementalRaf);
			this.incrementalRaf = 0;
		}
	}

/** Create (or patch-and-reuse) the row for one virtual item, returning the
 *  <li> to place, or null when the item references a missing file. Rows are
 *  absolutely positioned at their virtual offset so no sibling shifts when a
 *  row is added/removed. On a structural (visibility-change) render, surviving
 *  rows FLIP-glide from their previous offset and fresh rows slink in, so an
 *  expand/collapse reads as a flow instead of a snap. Only the row content
 *  animates — the nesting-guide background on the li stays at its final
 *  offset, keeping the guide lines continuous for the whole animation. */
	private buildRow(
		listEl: HTMLElement,
		item: VirtualItem,
		byKey: Map<string, HTMLElement>,
		top: number,
		animate: boolean,
	): HTMLElement | null {
		const s = this.state;
		if (item.type === 'file') {
			const file = s.files[item.index];
			if (!file) return null;
			const reused = this.take(byKey, `file:${item.index}`);
			if (reused) {
				const prevTop = parseFloat(reused.style.top);
				this.builder.updateFileRow(reused, item.index, file);
				reused.style.top = `${top}px`;
				if (animate && isFinite(prevTop) && Math.abs(prevTop - top) > 0.5) {
					this.glideRow(reused, prevTop - top);
				}
				return reused;
			}
			const created = this.builder.createFileRow(listEl, item.index, file);
			created.style.top = `${top}px`;
			if (animate) this.fadeInRow(created);
			return created;
		}
		const entry = s.entries[item.index];
		if (!entry) return null;
		const reused = this.take(byKey, `heading:${item.index}`);
		if (reused) {
			const prevTop = parseFloat(reused.style.top);
			const a = this.builder.updateHeadingRow(reused, item.index, entry);
			s.rowByEntry.set(item.index, reused);
			s.rowAnchorByEntry.set(item.index, a);
			reused.style.top = `${top}px`;
			if (animate && isFinite(prevTop) && Math.abs(prevTop - top) > 0.5) {
				this.glideRow(this.glideTarget(reused), prevTop - top);
			}
			return reused;
		}
		const row = this.builder.createHeadingRow(listEl, item.index, entry);
		s.rowByEntry.set(item.index, row.li);
		s.rowAnchorByEntry.set(item.index, row.a);
		row.li.style.top = `${top}px`;
		if (animate) this.fadeInRow(row.li);
		return row.li;
	}

	/** Remove rows in the reuse map that were not reused (collapsed/folded rows
	 *  that no longer belong to the window). Must run only after all reuse is
	 *  done, i.e. at the end of a synchronous render or the last fill batch. */
	private removeUnused(byKey: Map<string, HTMLElement>): void {
		for (const child of byKey.values()) {
			child.remove();
		}
	}

	/** Consume (remove + return) the row cached under `key` in the reuse map,
	 *  or null when it is absent/foreign. Mutating the map instead of tracking
	 *  a separate consumed set keeps the removal pass linear. */
	private take(byKey: Map<string, HTMLElement>, key: string): HTMLElement | null {
		const el = byKey.get(key);
		if (el) byKey.delete(key);
		return el ?? null;
	}

	/** The animatable content of a row: the .bv-toc-heading-inner wrapper
	 *  (chevron + anchor) for heading rows, or the whole element for rows
	 *  without a guide background (file rows). Everything that carries nesting
	 *  guides must stay at its final offset during an expand/collapse — moving
	 *  the li would drag its background segments and tear the lines at the
	 *  seam with the freshly-unfolded block — so glides/fades always target
	 *  the content, never the li's background. */
	private glideTarget(li: HTMLElement): HTMLElement {
		return li.querySelector<HTMLElement>('.bv-toc-heading-inner') ?? li;
	}

	/** FLIP-glide a surviving row's content from its previous top to the new
	 *  one. The row's guide background is NOT animated: it lives on the <li>
	 *  at its final offset, so the nesting lines stay continuous through the
	 *  whole animation — only the chevron+label travels. The layout `top` is
	 *  already the new offset; translateY inverts it so the first painted
	 *  frame is the old position, then the animation eases it to 0. Transform
	 *  + opacity only, so the whole thing runs on the compositor (the panel is
	 *  `contain: layout`, rows stay paint/transform-isolated). */
	private glideRow(el: HTMLElement, translatePx: number): void {
		if (this.reducedMotion() || typeof el.animate !== 'function') return;
		try {
			el.animate(
				[
					{ transform: `translateY(${translatePx.toFixed(1)}px)` },
					{ transform: 'translateY(0px)' },
				],
				{ duration: ROW_ANIM_MS, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' },
			);
		} catch {
			/* animation API missing — instant render is fine */
		}
	}

	/** Slink a freshly-created row in (a section just unfolded): fade + a 5px
	 *  rise applied only to the row content, so the guides (background on the
	 *  li) are already at their final position while the text appears — the
	 *  nesting lines never move or tear even on the fresh rows. */
	private fadeInRow(li: HTMLElement): void {
		if (this.reducedMotion() || typeof li.animate !== 'function') return;
		const el = this.glideTarget(li);
		try {
			el.animate(
				[
					{ opacity: 0, transform: 'translateY(5px)' },
					{ opacity: 1, transform: 'translateY(0px)' },
				],
				{ duration: ROW_ANIM_MS, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' },
			);
		} catch {
			/* animation API missing — instant render is fine */
		}
	}

	/** Brief highlight on the heading rows that just opened/closed, so a fast
	 *  auto-expand crossing through small sections stays legible. Consumed once
	 *  per structural render; timeout touches a detached node benignly if the
	 *  row is recycled within PULSE_MS. */
	private pulseToggled(): void {
		const s = this.state;
		if (s.lastToggledEntries.length === 0) return;
		if (!(s.settings?.tocExpandAnim ?? true)) {
			s.lastToggledEntries = [];
			return;
		}
		const toggled = s.lastToggledEntries;
		s.lastToggledEntries = [];
		if (this.reducedMotion()) return;
		for (const idx of toggled) {
			const rowEl = s.rowByEntry.get(idx);
			if (!rowEl) continue;
			rowEl.addClass('bv-pulse');
			window.setTimeout(() => rowEl.removeClass('bv-pulse'), PULSE_MS + 60);
		}
	}

	private reducedMotion(): boolean {
		return !!(
			this.state.containerEl.ownerDocument.defaultView?.matchMedia?.(
				'(prefers-reduced-motion: reduce)',
			).matches ?? false
		);
	}

	/** Debug: intercept every programmatic scrollTop/scrollTo/scrollBy write on
	 *  the panel and log it with a caller label. Native user scrolling never
	 *  goes through the JS setters — the compositor writes the native slot
	 *  directly — so any captured write is plugin code (or a foreign library)
	 *  moving the panel, i.e. the possible source of a perceived bounce-back.
	 *  No-op while DebugLog is disabled. Uninstalled in destroy(). */
	private installDebugProbe(): void {
		const el = this.state.containerEl;
		const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
		if (!desc?.set || !desc.get) return;
		const label = (): string =>
			new Error().stack?.split('\n').slice(2, 4).map((l) => l.trim().match(/at (.+)/)?.[1] ?? l.trim()).join(' > ') ?? '';
		Object.defineProperty(el, 'scrollTop', {
			configurable: true,
			get: function (this: HTMLElement): number {
				return desc.get!.call(this) as number;
			},
			set: function (this: HTMLElement, v: number): void {
				if (DebugLog.enabled) {
					DebugLog.log('TOCWRITE', '', `scrollTop=${Math.round(v)}`, label());
				}
				desc.set!.call(this, v);
			},
		});
		this.dbgOrigScrollTop = desc;
		for (const name of ['scrollTo', 'scrollBy'] as const) {
			const original = (el as unknown as Record<string, unknown>)[name] as
				| ((...a: unknown[]) => void)
				| undefined;
			if (typeof original !== 'function') continue;
			const bound = original.bind(el);
			(el as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
				if (DebugLog.enabled) {
					DebugLog.log('TOCWRITE', '', `${name}`, label());
				}
				bound(...args);
			};
			if (name === 'scrollTo') this.dbgOrigScrollTo = original.bind(el);
			else this.dbgOrigScrollBy = original.bind(el);
		}
	}

	/** Wire the panel scroll listener (coalesced to one rAF render). */
	setup(): void {
		const s = this.state;
		if (s.virtualItems.length === 0) return;
		this.installDebugProbe();
		this.scrollHandler = () => {
			// Debug: log every panel scroll event (native user scrolls AND any
			// programmatic jump) so a bounce-back is visible in the log as a
			// scroll event whose position regresses after a jump.
			if (DebugLog.enabled) {
				DebugLog.log('TOCSCROLL', '', `scrollTop=${Math.round(s.containerEl.scrollTop)}`);
			}
			// Cache the panel scrollTop before deferring the render: the render
			// (and every per-frame reader) reads from this cache instead of the
			// live element, so a scroll frame never pays a forced style recalc
			// for the panel subtree.
			s.panelScrollTop = s.containerEl.scrollTop;
			if (this.renderScheduled) return;
			this.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.renderScheduled = false;
				this.render();
			});
		};
		s.containerEl.addEventListener('scroll', this.scrollHandler, { passive: true });

		// Single delegated click handler for all rows (chevron toggle +
		// heading navigation). Rows carry no per-element listeners, so
		// re-creating/recycling <li>s never leaks or double-binds handlers.
		this.clickHandler = (evt: MouseEvent) => {
			this.builder.handleRowClick(evt);
		};
		this.listEl?.addEventListener('click', this.clickHandler, { passive: false });
	}

	destroy(): void {
		if (this.scrollHandler) {
			this.state.containerEl.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		if (this.clickHandler) {
			this.listEl?.removeEventListener('click', this.clickHandler);
			this.clickHandler = null;
		}
		this.renderScheduled = false;
		this.cancelIncremental();
		this.startIndex = 0;
		this.endIndex = 0;
		this.renderedItems = null;
		// Remove the DOM this window created (skeleton + highlight). The shadow
		// root stays attached (a second attachShadow on the same host would
		// throw); mount clears and re-seeds its children each time. Note the
		// incremental rebuild (TocController.rebuild) does NOT call destroy any
		// more — it rebuilds data in place and re-renders the visible rows, so
		// only a full teardown (TocView/Dom teardown) reaches this path and
		// wipes the panel.
		const shadow = this.state.shadowRoot;
		if (shadow) {
			shadow.replaceChildren();
		}
		this.state.highlightEl?.remove();
		this.state.highlightEl = null;
		this.state.highlightHost = null;
		this.spacerEl = null;
		this.listEl = null;
		this.uninstallDebugProbe();
	}

	/** Debug: restore the panel's native scroll accessors patched by
	 *  installDebugProbe (idempotent, safe after any teardown order). */
	private uninstallDebugProbe(): void {
		const el = this.state.containerEl;
		if (this.dbgOrigScrollTop) {
			try {
				Object.defineProperty(el, 'scrollTop', this.dbgOrigScrollTop);
			} catch {
				/* panel re-created; nothing to restore */
			}
			this.dbgOrigScrollTop = null;
		}
		const rec = el as unknown as Record<string, unknown>;
		if (this.dbgOrigScrollTo && typeof rec.scrollTo === 'function' && rec.scrollTo !== this.dbgOrigScrollTo) {
			rec.scrollTo = this.dbgOrigScrollTo;
		}
		if (this.dbgOrigScrollBy && typeof rec.scrollBy === 'function' && rec.scrollBy !== this.dbgOrigScrollBy) {
			rec.scrollBy = this.dbgOrigScrollBy;
		}
		this.dbgOrigScrollTo = null;
		this.dbgOrigScrollBy = null;
	}
}
