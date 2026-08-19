import { TocState } from './state';
import type { TocBuilder } from './builder';
import { firstItemAt, firstItemAfter } from './virtual';
import type { VirtualItem } from './virtual';

/** Extra rows rendered above/below the visible panel range. */
const OVERSCAN = 10;

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
	private startIndex = 0;
	private endIndex = 0;
	/** The virtual item list rendered in the current window. Compared against
	 *  `state.virtualItems` so a collapse that hides/folds rows re-creates the
	 *  window even when the visible [start, end) range did not move. */
	private renderedItems: VirtualItem[] | null = null;
	private scrollHandler: (() => void) | null = null;
	private renderScheduled = false;
	/** Called after a row-window rebuild (used to re-host the highlight pill
	 *  into the active row, which may have been re-created). */
	onRowsRendered: (() => void) | null = null;

	constructor(private state: TocState, private builder: TocBuilder) {}

	/** Build the panel skeleton (spacer + window + highlight bar) and render
	 *  the initial row window. */
	mount(): void {
		const s = this.state;
		const tocEl = s.containerEl.createDiv({ cls: 'book-toc' });
		if (s.settings?.tocGuides) {
			tocEl.addClass('book-toc-guides');
		}
		this.spacerEl = tocEl.createDiv({ cls: 'book-toc-spacer' });
		this.listEl = this.spacerEl.createDiv({ cls: 'book-toc-list' });
		s.highlightEl = s.containerEl.createDiv({ cls: 'book-toc-highlight' });
		this.render();
	}

	/** Re-render the row window for the current panel scroll position. No-op
	 *  when the visible range did not change. */
	render(): void {
		const s = this.state;
		const listEl = this.listEl;
		const spacerEl = this.spacerEl;
		if (!listEl || !spacerEl) return;

		const items = s.virtualItems;
		const offsets = s.virtualOffsets;
		const n = items.length;
		if (n === 0) {
			spacerEl.setCssProps({ height: '0px' });
			this.startIndex = 0;
			this.endIndex = 0;
			listEl.empty();
			s.rowByEntry.clear();
			s.rowAnchorByEntry.clear();
			return;
		}

		const total = offsets[n] ?? 0;
		spacerEl.style.height = `${total}px`;

		const viewport = s.tocViewportHeight > 0 ? s.tocViewportHeight : s.containerEl.clientHeight;
		const scrollTop = s.containerEl.scrollTop;

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

		let start = firstItemAt(offsets, scrollTop, n);
		let end = firstItemAfter(offsets, scrollTop + viewport, n);
		start = Math.max(0, start - OVERSCAN);
		end = Math.min(n, end + OVERSCAN);

		// Data change (rebuildVirtualData after a collapse/expand) re-creates
		// the window even if the range is identical: rows below the fold got
		// hidden/folded and the surviving rows need fresh collapsed/leaf state.
		if (start === this.startIndex && end === this.endIndex && this.renderedItems === items) return;

		this.startIndex = start;
		this.endIndex = end;
		this.renderedItems = items;

		listEl.empty();
		listEl.style.top = `${offsets[start] ?? 0}px`;
		s.rowByEntry.clear();
		s.rowAnchorByEntry.clear();

		for (let i = start; i < end; i++) {
			const item = items[i];
			if (!item) continue;
			if (item.type === 'file') {
				const file = s.files[item.index];
				if (file) this.builder.createFileRow(listEl, file);
			} else {
				const entry = s.entries[item.index];
				if (!entry) continue;
				const row = this.builder.createHeadingRow(listEl, item.index, entry);
				s.rowByEntry.set(item.index, row.li);
				s.rowAnchorByEntry.set(item.index, row.a);
			}
		}

		this.onRowsRendered?.();
	}

	/** Wire the panel scroll listener (coalesced to one rAF render). */
	setup(): void {
		const s = this.state;
		if (s.virtualItems.length === 0) return;
		this.scrollHandler = () => {
			if (this.renderScheduled) return;
			this.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.renderScheduled = false;
				this.render();
			});
		};
		s.containerEl.addEventListener('scroll', this.scrollHandler, { passive: true });
	}

	destroy(): void {
		if (this.scrollHandler) {
			this.state.containerEl.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		this.renderScheduled = false;
		this.startIndex = 0;
		this.endIndex = 0;
		this.renderedItems = null;
		// Remove the DOM this window created (skeleton + highlight). The view
		// also empties the panel on full teardown, but the incremental rebuild
		// (TocController.rebuild) re-runs mount without a view-level wipe, so
		// the old skeleton must not leak into the panel.
		this.spacerEl?.parentElement?.remove();
		this.state.highlightEl?.remove();
		this.state.highlightEl = null;
		this.spacerEl = null;
		this.listEl = null;
	}
}
