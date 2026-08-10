import { Component } from 'obsidian';
import {
	computeHeadingFoldState,
	getFoldMode,
	isFoldedSubtree,
	isSectionHidden,
	nextVisibleIndex,
	sectionNeedsFoldStub,
	type FoldContext,
	type FoldMode,
	type HeadingNode,
} from '../utils/fold';
import { getFirstContentElement, getHeaderLevel } from '../utils/dom';

/** Stub height used for a folded heading until its real height is measured,
 *  so a freshly-folded section never collapses to 'full' (which would hide
 *  the heading and its chevron with no way to expand back). */
export const FALLBACK_FOLD_HEADING_HEIGHT = 40;

/** The slice of section layout data the fold engine reads. */
export interface FoldSection {
	el: HTMLElement;
	component: Component | null;
	foldHeadingHeight: number;
}

/** Manager capabilities the fold engine calls back into. The heading/fold
 *  collections are the manager's live (in-place mutated) structures — they are
 *  never reassigned, so referencing them by identity stays correct. */
export interface FoldControllerHost {
	readonly headingIndex: readonly HeadingNode[];
	readonly headingIndexById: ReadonlyMap<string, HeadingNode>;
	readonly firstHeadingByPath: ReadonlyMap<string, HeadingNode>;
	readonly fileOrder: readonly string[];
	readonly sections: ReadonlyMap<string, FoldSection>;
	readonly headingsByPath: ReadonlyMap<string, HeadingNode[]>;
	isDestroyed(): boolean;
	getLastUserScrollAt(): number;
	/** Capture the scroll anchor before a toggle mutates the fold set, so the
	 *  post-update layout restores against the pre-fold geometry. */
	captureAnchor(): void;
	scheduleUpdate(): void;
	dbg(msg: string, path?: string, a?: number | string, b?: number | string, c?: number | string, d?: number | string): void;
}

/** Owns the heading-fold state and its DOM effects: fold toggles, the folded
 *  subtree predicates, per-heading chevrons (positioned and revealed by CSS),
 *  and deferred fold-stub-height measurement. All timers are cleared in
 *  destroy(). */
export class FoldController {
	foldedHeadings: Set<string> = new Set();

	/** Sections whose rendered DOM needs fold-hiding reapplied after a toggle.
	 *  Whole-section modes need no DOM work, but low-level folds hide content
	 *  inside an otherwise 'none' section. */
	private pendingFoldRetag: string[] = [];
	private pendingFoldHeight: string[] = [];
	private foldHeightTimer = 0;

	/** Cached bundle of the fold state collections for the pure predicates in
	 *  utils/fold.ts. All collections are mutated in place (Set/Map ops, array
	 *  length=0 + push) and never reassigned, so one bundle stays valid for the
	 *  engine's lifetime and the hot paths allocate nothing. */
	private foldCtx: FoldContext | null = null;
	private get foldContext(): FoldContext {
		if (!this.foldCtx) {
			this.foldCtx = {
				foldedHeadings: this.foldedHeadings,
				headingIndex: this.host.headingIndex,
				headingIndexById: this.host.headingIndexById,
				firstHeadingByPath: this.host.firstHeadingByPath,
				fileOrder: this.host.fileOrder,
				hasSection: (path) => this.host.sections.has(path),
			};
		}
		return this.foldCtx;
	}

	constructor(private host: FoldControllerHost) {}

	isFolded(id: string): boolean {
		return this.foldedHeadings.has(id);
	}

	getFoldMode(path: string): FoldMode {
		return getFoldMode(path, this.foldContext);
	}

	nextVisibleIndex(start: number): number {
		return nextVisibleIndex(start, this.foldContext);
	}

	private isFoldedSubtree(headingId: string): boolean {
		return isFoldedSubtree(headingId, this.foldContext);
	}

	private isSectionHidden(path: string): boolean {
		return isSectionHidden(path, this.foldContext);
	}

	/** True when the section shows a folded-heading stub: hidden AND its own
	 *  first heading is directly folded. Only these need foldHeadingHeight. */
	sectionNeedsFoldStub(path: string): boolean {
		return sectionNeedsFoldStub(path, this.foldContext);
	}

	toggleFold(id: string): void {
		this.host.captureAnchor();
		if (this.foldedHeadings.has(id)) {
			this.foldedHeadings.delete(id);
		} else {
			this.foldedHeadings.add(id);
			// Lazy fold-stub measurement: only sections whose own heading is now
			// folded need their stub height. Measuring every mounted section at
			// idle forces a synchronous layout of heavy subtrees.
			for (const [path, data] of this.host.sections) {
				if (data.foldHeadingHeight <= 0 && this.sectionNeedsFoldStub(path)) {
					this.scheduleFoldHeightMeasure(path);
				}
			}
		}
		// Re-apply DOM-level fold hiding for the section containing this heading
		// (low-level folds hide content inside the section, not whole sections).
		const info = this.host.headingIndexById.get(id);
		if (info && !this.pendingFoldRetag.includes(info.path)) {
			this.pendingFoldRetag.push(info.path);
		}
		this.host.scheduleUpdate();
	}

	/** Applies DOM-level fold hiding inside a rendered section. Section-level
	 *  modes handle whole sections ('full' hides it entirely, 'heading' keeps
	 *  only its first heading); for 'none' sections each folded heading hides
	 *  its own subtree — every block after it until the next heading of the
	 *  same or a higher level. Runs on every (re)mount and after fold toggles. */
	private applyFoldVisibility(path: string, container: HTMLElement): void {
		// Fast path: with no folded headings there is nothing to hide, so
		// heading-dense sections mount without a DOM scan. The one exception is
		// right after a toggle removed the last fold — pendingFoldRetag must
		// still run to clear stale classes.
		if (this.foldedHeadings.size === 0 && !this.pendingFoldRetag.includes(path)) return;
		const mode = this.getFoldMode(path);
		const rendered = container.querySelector('.markdown-rendered');
		if (!rendered) {
			this.host.dbg('fold-norend', path, mode, this.foldedHeadings.size, this.pendingFoldRetag.includes(path) ? 1 : 0);
			return;
		}
		const blocks = Array.from(rendered.children) as HTMLElement[];
		const taggedCount = container.querySelectorAll('[data-fold-id]').length;
		this.host.dbg('fold-run', path, mode, blocks.length, taggedCount, this.foldedHeadings.size);
		for (const block of blocks) {
			block.classList.remove('book-fold-hidden');
		}
		if (mode === 'full') return;

		if (mode === 'heading') {
			// Keep the first heading block (and anything before it); hide every
			// block that follows it. The heading can be the block itself (a bare
			// h* direct child of .markdown-rendered) or wrapped (themed .el-hX
			// containers) — normalize like the 'none' branch below, because
			// block.querySelector alone misses the bare-heading case and then no
			// block is hidden, leaving the section text visible under the stub.
			let seenHeading = false;
			let hideCount = 0;
			for (const block of blocks) {
				if (!seenHeading) {
					const direct = block.matches('[data-fold-id]') ? block : null;
					if (direct ?? block.querySelector('[data-fold-id]')) seenHeading = true;
					continue;
				}
				block.classList.add('book-fold-hidden');
				hideCount++;
			}
			this.host.dbg('fold-heading', path, seenHeading ? 1 : 0, hideCount, blocks.length);
			this.updateFoldChevrons(container);
			return;
		}

		// mode === 'none': fold each heading's subtree independently. A block is
		// hidden while an ancestor fold is active; a folded heading starts a new
		// fold and stays visible itself.
		const headingBlocks: { block: HTMLElement; id: string; level: number }[] = [];
		for (const block of blocks) {
			// A heading can be the block itself (direct child of .markdown-rendered)
			// or wrapped (themed .el-hX containers). The [data-fold-id] hit can be
			// the heading, its wrapper, or the chevron span appended inside it —
			// normalize back to the actual heading element via closest().
			const direct = block.matches('[data-fold-id]') ? block : null;
			const found = direct ?? block.querySelector<HTMLElement>('[data-fold-id]');
			if (!found) continue;
			const heading = found.closest('h1, h2, h3, h4, h5, h6');
			if (!heading) continue;
			const id = (heading as HTMLElement).dataset.foldId;
			if (!id) continue;
			const level = Number.parseInt(heading.tagName.replace(/^H/i, ''), 10);
			if (!Number.isFinite(level)) continue;
			headingBlocks.push({ block, id, level });
		}

		// The fold-stack logic is pure (see utils/fold.ts); feed it the section's
		// heading levels and a predicate mapping them to folded-subtree state.
		const foldState = computeHeadingFoldState(
			headingBlocks.map((hb) => hb.level),
			(i) => this.isFoldedSubtree(headingBlocks[i]!.id),
		);

		const hideBlock: boolean[] = new Array<boolean>(blocks.length).fill(false);
		let hbIdx = 0;
		let active = false;
		for (let i = 0; i < blocks.length; i++) {
			const hb = headingBlocks[hbIdx];
			if (hb && hb.block === blocks[i]) {
				const st = foldState[hbIdx];
				if (st) {
					hideBlock[i] = st.hiddenByAncestor;
					active = st.active;
				}
				hbIdx++;
			} else {
				// Non-heading content between headings: hidden while a fold is
				// active (and after the last heading too).
				hideBlock[i] = active;
			}
		}
		for (let i = 0; i < blocks.length; i++) {
			if (hideBlock[i]) blocks[i]?.classList.add('book-fold-hidden');
		}
		this.updateFoldChevrons(container);
	}

	/** Rotate/expand labels for every fold chevron in the section to match the
	 *  current direct fold state of its heading; chevrons whose heading is
	 *  hidden by an ancestor fold are hidden so they don't float over content. */
	private updateFoldChevrons(container: HTMLElement): void {
		// The chevron is a CSS pseudo-element on the tagged heading; only the
		// fold classes/title live here.
		const headings = container.querySelectorAll<HTMLElement>('[data-fold-id]');
		for (const h of Array.from(headings)) {
			const id = h.dataset.foldId;
			if (!id) continue;
			const folded = this.foldedHeadings.has(id);
			h.classList.toggle('is-folded', folded);
			h.classList.toggle('book-fold-chevron-hidden', !folded && this.isFoldedSubtree(id));
			const title = folded ? 'Expand section' : 'Collapse section';
			if (h.title !== title) h.title = title;
		}
	}

	/** Tag every rendered heading in the section with its data-fold-id. The
	 *  chevron itself is drawn by CSS (a pseudo-element on the tagged heading),
	 *  so heading-dense notes mount with no per-heading DOM nodes. Runs on
	 *  every (re)mount. */
	tagFoldIds(path: string, container: HTMLElement): void {
		const pathHeadings = this.host.headingsByPath.get(path) ?? [];
		const bareHeadings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
		let idx = 0;
		for (let j = 0; j < bareHeadings.length; j++) {
			const el = bareHeadings[j];
			if (!el) continue;
			if (el.parentElement?.closest('[data-fold-id]')) continue;
			const match = pathHeadings[idx];
			if (!match) break;
			const h = el as HTMLElement;
			h.dataset.foldId = match.id;
			idx++;
		}
		this.applyFoldVisibility(path, container);
	}

	private measureFoldHeadingHeight(container: HTMLElement): number {
		const first = getFirstContentElement(container);
		if (!first) return 0;
		if (!getHeaderLevel(first)) return 0;
		const rect = first.getBoundingClientRect();
		const style = getComputedStyle(first);
		const marginTop = parseFloat(style.marginTop) || 0;
		const marginBottom = parseFloat(style.marginBottom) || 0;
		return rect.height + marginTop + marginBottom;
	}

	scheduleFoldHeightMeasure(path: string): void {
		if (!this.pendingFoldHeight.includes(path)) {
			this.pendingFoldHeight.push(path);
		}
		this.deferFoldHeightMeasure();
	}

	private deferFoldHeightMeasure(): void {
		if (this.foldHeightTimer) return;
		this.foldHeightTimer = window.setTimeout(() => {
			this.foldHeightTimer = 0;
			if (this.host.isDestroyed()) return;
			if (Date.now() - this.host.getLastUserScrollAt() < 250) {
				this.deferFoldHeightMeasure();
				return;
			}
			this.measurePendingFoldHeights();
		}, 60);
	}

	private measurePendingFoldHeights(): void {
		const paths = this.pendingFoldHeight;
		this.pendingFoldHeight = [];
		let changed = false;
		for (const path of paths) {
			const data = this.host.sections.get(path);
			if (!data || !data.component) continue;
			const h = this.measureFoldHeadingHeight(data.el);
			if (h !== data.foldHeadingHeight) {
				data.foldHeadingHeight = h;
				changed = true;
			}
		}
		if (changed) this.host.scheduleUpdate();
	}

	/** Re-apply DOM-level fold hiding for sections queued by toggleFold. */
	applyPendingRetags(): void {
		if (this.pendingFoldRetag.length === 0) return;
		this.host.dbg('fold-retag', '', this.pendingFoldRetag.length);
		for (const path of this.pendingFoldRetag) {
			const data = this.host.sections.get(path);
			this.host.dbg('fold-retag-one', path, data?.component ? 1 : 0, data?.el.querySelector('.markdown-rendered') ? 1 : 0);
			if (data?.component) {
				this.applyFoldVisibility(path, data.el);
			}
		}
		this.pendingFoldRetag.length = 0;
	}

	/** Chevron positions are pure CSS (inside their heading), so there is
	 *  nothing to invalidate when a section re-renders or the width changes. */

	destroy(): void {
		window.clearTimeout(this.foldHeightTimer);
		this.pendingFoldHeight.length = 0;
		this.pendingFoldRetag.length = 0;
	}
}
