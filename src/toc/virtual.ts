/**
 * Pure virtual-list builders for the ToC panel. Kept free of DOM and Obsidian
 * imports so they can be unit-tested in isolation: given the flattened entry
 * list, the file list, and the per-entry hidden mask, they produce the flat
 * list of renderable rows (file titles + visible headings) and their
 * cumulative offsets. The window renderer (src/toc/window.ts) only touches DOM.
 */

export interface VirtualItem {
	type: 'file' | 'heading';
	/** For 'heading': the ToC entry index. For 'file': index into the files array. */
	index: number;
	/** Heading level (headings only). */
	level?: number;
}

/**
 * Flatten the collapsed tree into the ordered list of rows the panel can
 * render. Files that had headings keep a file row (tocShowFileNames) even when
 * all their headings are hidden, mirroring the pre-virtualization DOM; heading
 * rows are skipped when hidden (collapsed under an ancestor).
 *
 * Returns the item list and `entryToItem` (parallel to `entries`, the virtual
 * item index of each visible heading, -1 when hidden/absent).
 */
export function buildVirtualItems(
	entries: readonly { file: { path: string }; level: number }[],
	files: readonly { path: string }[],
	hidden: readonly boolean[],
	showFileNames: boolean,
): { items: VirtualItem[]; entryToItem: number[] } {
	const byFile = new Map<string, number[]>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const list = byFile.get(entry.file.path);
		if (list) {
			list.push(i);
		} else {
			byFile.set(entry.file.path, [i]);
		}
	}

	const items: VirtualItem[] = [];
	const entryToItem = new Array<number>(entries.length).fill(-1);
	for (let fi = 0; fi < files.length; fi++) {
		const file = files[fi];
		if (!file) continue;
		const entryIndexes = byFile.get(file.path);
		if (!entryIndexes) continue;

		if (showFileNames) items.push({ type: 'file', index: fi });

		for (const i of entryIndexes) {
			if (hidden[i]) continue;
			const entry = entries[i];
			if (!entry) continue;
			items.push({ type: 'heading', index: i, level: entry.level });
			entryToItem[i] = items.length - 1;
		}
	}
	return { items, entryToItem };
}

/** Cumulative top offset of each item; length = items.length + 1 (last entry
 *  is the total height). */
export function computeVirtualOffsets(
	items: readonly VirtualItem[],
	headingHeight: number,
	fileHeight: number,
): number[] {
	const offsets = new Array<number>(items.length + 1);
	let acc = 0;
	for (let i = 0; i < items.length; i++) {
		offsets[i] = acc;
		acc += items[i]?.type === 'file' ? fileHeight : headingHeight;
	}
	offsets[items.length] = acc;
	return offsets;
}

/** Index of the first item whose bottom edge is below `y` (the row covering
 *  `y`, or the first row after an empty gap). Binary search — the offsets are
 *  monotonically non-decreasing. */
export function firstItemAt(
	offsets: readonly number[],
	y: number,
	itemsLength: number,
): number {
	let lo = 0;
	let hi = itemsLength;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((offsets[mid + 1] ?? Infinity) > y) {
			hi = mid;
		} else {
			lo = mid + 1;
		}
	}
	return lo;
}

/** Index of the first item whose top is at or below `y` (exclusive end for the
 *  range [start, end)). */
export function firstItemAfter(
	offsets: readonly number[],
	y: number,
	itemsLength: number,
): number {
	let lo = 0;
	let hi = itemsLength;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((offsets[mid] ?? Infinity) >= y) {
			hi = mid;
		} else {
			lo = mid + 1;
		}
	}
	return lo;
}
