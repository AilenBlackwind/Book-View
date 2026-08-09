/**
 * Pure fold-state logic for the section engine. Decides which sections and
 * which DOM blocks inside a rendered section are hidden by heading folding.
 * Free of DOM and Obsidian imports so it can be unit-tested in isolation;
 * the AbsoluteSectionManager feeds it the live heading/fold state and applies
 * the result to the DOM.
 */

/** A heading parsed from raw markdown, with precomputed document-order index
 *  and owning-file index for O(1) ancestor walks and file lookups. */
export interface HeadingNode {
	id: string;
	path: string;
	level: number;
	text: string;
	/** Index in the document-order heading array. */
	idx: number;
	/** Index of the owning file in the layout order. */
	fileIdx: number;
}

/** Live view of the manager's fold state. The collections are mutated in
 *  place and never reassigned, so a single cached bundle stays valid for the
 *  engine's lifetime. */
export interface FoldContext {
	/** Directly-folded heading ids (user toggles + defaults). */
	foldedHeadings: ReadonlySet<string>;
	/** All headings in document order. */
	headingIndex: readonly HeadingNode[];
	/** id → heading for O(1) ancestor walks. */
	headingIndexById: ReadonlyMap<string, HeadingNode>;
	/** First heading of each section path. */
	firstHeadingByPath: ReadonlyMap<string, HeadingNode>;
	/** Section paths in layout order. */
	fileOrder: readonly string[];
	/** Whether a section currently has layout data (used by getFoldMode). */
	hasSection: (path: string) => boolean;
}

/** True when a heading sits inside a folded subtree (itself or any ancestor
 *  heading is directly folded). */
export function isFoldedSubtree(headingId: string, ctx: FoldContext): boolean {
	if (ctx.foldedHeadings.has(headingId)) return true;

	const info = ctx.headingIndexById.get(headingId);
	if (!info) return false;

	let currentLevel = info.level;
	for (let i = info.idx - 1; i >= 0; i--) {
		const entry = ctx.headingIndex[i];
		if (!entry) continue;
		if (entry.level < currentLevel) {
			if (ctx.foldedHeadings.has(entry.id)) return true;
			currentLevel = entry.level;
			if (currentLevel <= 1) break;
		}
	}
	return false;
}

/** True when the section renders nothing at all: its own first heading (or
 *  the last heading before it, for text-only sections) sits inside a folded
 *  subtree. */
export function isSectionHidden(path: string, ctx: FoldContext): boolean {
	const first = ctx.firstHeadingByPath.get(path);
	if (first) {
		return isFoldedSubtree(first.id, ctx);
	}

	const fileIdx = ctx.fileOrder.indexOf(path);
	for (let i = ctx.headingIndex.length - 1; i >= 0; i--) {
		const h = ctx.headingIndex[i];
		if (!h) continue;
		if (h.fileIdx < fileIdx || (h.fileIdx === fileIdx && h.path === path)) {
			return isFoldedSubtree(h.id, ctx);
		}
	}

	return false;
}

export type FoldMode = 'none' | 'heading' | 'full';

/** How a hidden section should render:
 *  - 'none'    — not hidden at all;
 *  - 'heading' — keep only its first heading (fold stub) visible;
 *  - 'full'    — hide everything, including the heading. */
export function getFoldMode(path: string, ctx: FoldContext): FoldMode {
	if (!isSectionHidden(path, ctx)) return 'none';
	if (!ctx.hasSection(path)) return 'full';
	const ownHeading = ctx.firstHeadingByPath.get(path);
	if (!ownHeading) return 'full';
	// A section whose own first heading is folded always shows the heading
	// stub. Never degrade to 'full' just because the stub height is not
	// measured yet: 'full' unloads the DOM (heading + chevron vanish) and the
	// deferred measurement then skips the unloaded section, permanently
	// hiding the section with no way to expand it back.
	if (!ctx.foldedHeadings.has(ownHeading.id)) return 'full';
	return 'heading';
}

/** True when the section shows a folded-heading stub: hidden AND its own
 *  first heading is directly folded. Only these need foldHeadingHeight. */
export function sectionNeedsFoldStub(path: string, ctx: FoldContext): boolean {
	if (!isSectionHidden(path, ctx)) return false;
	const ownHeading = ctx.firstHeadingByPath.get(path);
	return !!ownHeading && ctx.foldedHeadings.has(ownHeading.id);
}

/** First file index strictly after `start` whose section is not fully hidden,
 *  or -1 when every following section is fully hidden. */
export function nextVisibleIndex(start: number, ctx: FoldContext): number {
	for (let i = start + 1; i < ctx.fileOrder.length; i++) {
		const path = ctx.fileOrder[i];
		if (!path) continue;
		if (getFoldMode(path, ctx) !== 'full') return i;
	}
	return -1;
}

export interface HeadingFoldState {
	/** Heading's own block is hidden by an ancestor fold. */
	hiddenByAncestor: boolean;
	/** Heading starts (or extends) a fold: it or an ancestor is folded. */
	startsFold: boolean;
	/** Whether a fold is active right after this heading — i.e. the content
	 *  between this heading and the next is hidden. */
	active: boolean;
}

/** Fold-stack walk over a section's headings in document order. Mirrors
 *  Obsidian folding: folding a heading hides every block after it until the
 *  next heading of the same or a higher level. `isFolded(i)` reports whether
 *  heading `i` sits in a folded subtree (itself or an ancestor folded). */
export function computeHeadingFoldState(
	levels: readonly number[],
	isFolded: (index: number) => boolean,
): HeadingFoldState[] {
	const stack: number[] = [];
	const result: HeadingFoldState[] = [];
	for (let i = 0; i < levels.length; i++) {
		const level = levels[i];
		if (level === undefined) continue;
		while (stack.length > 0 && (stack[stack.length - 1] ?? 0) >= level) {
			stack.pop();
		}
		const hiddenByAncestor = stack.length > 0;
		const startsFold = isFolded(i);
		if (startsFold) stack.push(level);
		result.push({ hiddenByAncestor, startsFold, active: stack.length > 0 });
	}
	return result;
}
