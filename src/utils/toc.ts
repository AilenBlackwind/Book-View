/**
 * Pure decision logic for the table of contents. Kept free of DOM and
 * Obsidian imports so it can be unit-tested in isolation; the TocController
 * only feeds it state and applies the result to the DOM.
 */

/** Index of the ToC entry that should be highlighted for a given scroll
 *  position. Returns the last entry whose heading top is above the trigger
 *  line (30% down the viewport by default), or -1 when scrolled above the
 *  first heading. */
export function pickActiveIndex(
	positions: readonly (number | undefined)[],
	scrollTop: number,
	viewportHeight: number,
	triggerRatio = 0.3,
): number {
	const triggerY = scrollTop + viewportHeight * triggerRatio;
	for (let i = positions.length - 1; i >= 0; i--) {
		if ((positions[i] ?? 0) <= triggerY) return i;
	}
	return -1;
}

/** Ancestors of entry `index` (plus the entry itself when it has children),
 *  as a set of entry indices. Used by auto-expand to keep the active path
 *  open while scrolling. */
export function computeActivePath(
	entries: readonly { level: number }[],
	index: number,
): Set<number> {
	const path = new Set<number>();
	const entry = entries[index];
	if (!entry) return path;

	// Add current heading if it has children (so its section expands as soon
	// as we arrive).
	const next = entries[index + 1];
	if (next && next.level > entry.level) {
		path.add(index);
	}

	let targetLevel = entry.level;
	for (let i = index - 1; i >= 0; i--) {
		const a = entries[i];
		if (!a) break;
		if (a.level < targetLevel) {
			path.add(i);
			targetLevel = a.level;
		}
	}
	return path;
}

/** Visibility for every entry in a single forward O(n) pass. An entry is
 *  hidden when an ancestor (or the entry itself, once it is on the stack) is
 *  collapsed. `isExpanded(index)` decides whether an entry shows its
 *  children. */
export function computeHiddenState(
	entries: readonly { level: number }[],
	isExpanded: (index: number) => boolean,
): boolean[] {
	const willHide: boolean[] = new Array<boolean>(entries.length).fill(false);
	const stack: { level: number; index: number; hidden: boolean }[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const level = entry.level;
		while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
			stack.pop();
		}
		const top = stack[stack.length - 1];
		let hidden = false;
		if (top) {
			hidden = top.hidden || !isExpanded(top.index);
		}
		willHide[i] = hidden;
		stack.push({ level, index: i, hidden });
	}
	return willHide;
}
