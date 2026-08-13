/**
 * Portable contracts for the ToC module. This file is the only seam the module
 * exposes to its host: it must not import the host's types (BookViewSettings,
 * AbsoluteSectionManager), so the whole `src/toc/` directory can be embedded
 * in any plugin — Book-View, or a standalone outline — by providing a
 * `HeadingPositionSource` and a `TocSettings` object.
 */

export type AutoExpandMode = 'expand-collapse-default' | 'only-expand' | 'expand-collapse-level' | 'disabled';

/** The ToC settings this module reads. A narrow subset of the host plugin's
 *  settings; any object with these fields (e.g. the full BookViewSettings)
 *  is assignable. */
export interface TocSettings {
	tocShowFileNames: boolean;
	tocGuides: boolean;
	tocRenderMarkdown: boolean;
	tocActiveColor: string;
	tocCollapsedLevel: number;
	autoExpandMode: AutoExpandMode;
}

/** Line-based fallback height for the heading-position estimate, used before
 *  the host's measured offsets land. Host-specific: Book-View's sections are
 *  ~25px per source line; a reading-view adapter would tune its own value. */
export const HEIGHT_PER_LINE = 25;

/** The scroll-position provider the spy and measurer run against. Book-View
 *  adapts its AbsoluteSectionManager; a standalone outline plugin would adapt
 *  the reading view. Kept to the minimal surface the ToC actually touches so
 *  any host can implement it cheaply. */
export interface HeadingPositionSource {
	/** Request a coalesced frame; frame callbacks run after the host applied
	 *  its layout writes for the frame. */
	requestFrame(): void;
	addFrameCallback(cb: () => void): void;
	removeFrameCallback(cb: () => void): void;
	/** The frame-cached scrollTop (reading it here avoids a layout flush). */
	getScrollTop(): number;
	/** Top offset of the content block for `path`, in scroll-content
	 *  coordinates (document top = 0). Undefined when unknown. */
	getOffset(path: string): number | undefined;
	/** Bumped whenever content offsets change; the spy skips recomputing
	 *  entry positions on plain scroll frames. */
	getLayoutVersion(): number;
	/** True while the user's scroll is recent enough that layout-flush-heavy
	 *  work (rect reads) should be deferred. A short window answers "has the
	 *  book actually stopped moving". */
	isGestureActive(withinMs?: number): boolean;
	/** Debug counters for the deferred heading-rect measurement (optional —
	 *  hosts without the debug harness may omit them). */
	dbgTagRects?: number;
	dbgTagMs?: number;
}
