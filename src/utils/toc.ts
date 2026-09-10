/**
 * Pure decision logic for the table of contents. Kept free of DOM and
 * Obsidian imports so it can be unit-tested in isolation; the TocController
 * only feeds it state and applies the result to the DOM.
 */

/** Index of the ToC entry that should be highlighted for a given scroll
 *  position. Returns the last entry whose heading top is above the trigger
 *  line (the viewport middle by default — the section becomes active when it
 *  covers more than half the screen, so a heading whose section no longer
 *  reaches the viewport loses the highlight instead of holding it until its
 *  successor crosses a high line), or -1 when scrolled above the first
 *  heading. Positions are monotonically non-decreasing (file offsets
 *  cascade in order and within-section offsets grow with document order), so
 *  the last match is found with a binary search instead of an O(n) scan —
 *  the scan ran over the whole array on every scroll frame.
 *
 *  `prevIndex` adds hysteresis: around the trigger line there is a dead band
 *  of ±`hysteresisPx` where the previous index is held. Parking a scroll
 *  right on the boundary would otherwise flip the highlight between two
 *  adjacent entries on every frame (a ±17px wiggle was enough). Scrolling
 *  down holds the previous entry until the new heading clears the line by
 *  the margin; scrolling up (or above the first heading) holds it until its
 *  heading has dropped below the line by the margin. Any decisive jump —
 *  a far teleport, several sections in one frame — still switches
 *  immediately because its position is far outside the band. */
export function pickActiveIndex(
	positions: readonly (number | undefined)[],
	scrollTop: number,
	viewportHeight: number,
	prevIndex = -1,
	triggerRatio = 0.5,
	hysteresisPx = 24,
): number {
	const triggerY = scrollTop + viewportHeight * triggerRatio;
	let lo = 0;
	let hi = positions.length - 1;
	let result = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((positions[mid] ?? 0) <= triggerY) {
			result = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	if (prevIndex < 0 || prevIndex >= positions.length || result === prevIndex) {
		return result;
	}
	if (result > prevIndex) {
		return (positions[result] ?? 0) <= triggerY - hysteresisPx ? result : prevIndex;
	}
	return (positions[prevIndex] ?? Number.POSITIVE_INFINITY) > triggerY + hysteresisPx
		? result
		: prevIndex;
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
