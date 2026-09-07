/**
 * The ToC row styles, injected into the panel's shadow root so the rows are
 * isolated from document-level `:has()` rules (Obsidian's reading-enhancement
 * sheet — `div:has(:is(h1..h4)):has(...)` — re-scans every div ancestor of an
 * inserted `li`, which made every auto-expand crossing during a wheel glide
 * recalc the whole ~670-element panel subtree). Elements inside a shadow root
 * are invisible to document stylesheet matching, so row insertions/styling no
 * longer wake those selectors. `var(--...)` custom properties DO cross the
 * shadow boundary, so theme variables (--h1-color, --text-muted, ...) still
 * resolve here.
 *
 * This string is also appended to `styles.css` at build time (build task in
 * package.json copies it into the sheet) so the classes remain overridable via
 * CSS variables by snippets/themes and appear in style inspection.
 */
export const TOC_SHADOW_CSS = `
.bv-toc {
	padding: 0;
	overflow-anchor: none;
	position: relative;
	contain: layout;
}

.bv-toc-spacer {
	position: relative;
	contain: layout paint style;
}

.bv-toc-list {
	list-style: none;
	padding: 0;
	margin: 0;
	position: absolute;
	left: 0;
	right: 0;
	top: 0;
}

.bv-toc-file {
	position: absolute;
	left: 0;
	right: 0;
	height: 34px;
	box-sizing: border-box;
	contain: style;
}

.bv-toc-file-title {
	display: block;
	height: 100%;
	box-sizing: border-box;
	font-weight: 600;
	color: var(--text-normal);
	padding: 4px 0 8px;
	border-bottom: 1px solid var(--background-modifier-border);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.bv-toc-heading {
	position: absolute;
	left: 0;
	right: 0;
	height: 26px;
	box-sizing: border-box;
	opacity: 1;
	contain: style;
}

.bv-toc-heading-inner {
	display: flex;
	align-items: center;
	height: 100%;
}

.bv-toc-chevron {
	width: 16px;
	height: 100%;
	flex-shrink: 0;
	cursor: pointer;
	user-select: none;
	color: var(--text-muted);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	transform: translateY(-2px) rotate(90deg);
	transition: none;
}

.bv-toc-chevron svg {
	width: 12px;
	height: 12px;
	display: block;
}

.bv-toc-chevron:hover {
	color: var(--text-normal);
}

.bv-toc-heading.bv-toc-collapsed .bv-toc-chevron {
	transform: translateY(-2px) rotate(0deg);
}

.bv-toc-heading.bv-toc-leaf .bv-toc-chevron {
	visibility: hidden;
	cursor: default;
}

.bv-toc-item {
	display: block;
	height: 100%;
	box-sizing: border-box;
	padding: 2px 8px;
	line-height: 22px;
	color: var(--nav-item-color);
	cursor: pointer;
	text-decoration: none;
	border-radius: 4px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	flex: 1;
	min-width: 0;
}

.bv-toc-item:hover {
	background: var(--background-modifier-hover);
	color: var(--nav-item-color-hover);
}

.bv-toc-item[data-level="1"] { color: var(--h1-color); }
.bv-toc-item[data-level="2"] { color: var(--h2-color); }
.bv-toc-item[data-level="3"] { color: var(--h3-color); }
.bv-toc-item[data-level="4"] { color: var(--h4-color); }
.bv-toc-item[data-level="5"] { color: var(--h5-color); }
.bv-toc-item[data-level="6"] { color: var(--h6-color); }

.bv-toc-guides .bv-toc-heading {
	background-repeat: no-repeat;
	background-size: 1px 100%;
}

.bv-toc-item.is-active {
	font-weight: 600;
	color: var(--text-accent);
}

.bv-toc-highlight {
	position: absolute;
	top: 0;
	left: 0;
	height: 22px;
	width: calc(100% - 8px);
	background: var(--bv-toc-highlight-color, var(--interactive-accent));
	opacity: 0.15;
	border-radius: 4px;
	pointer-events: none;
	transition: opacity 0.4s ease-out;
	will-change: transform;
	z-index: 1;
}

.bv-toc-highlight-level-1 { width: calc(100% - 8px); }
.bv-toc-highlight-level-2 { width: calc(100% - 20px); }
.bv-toc-highlight-level-3 { width: calc(100% - 32px); }
.bv-toc-highlight-level-4 { width: calc(100% - 44px); }
.bv-toc-highlight-level-5 { width: calc(100% - 56px); }
.bv-toc-highlight-level-6 { width: calc(100% - 68px); }

.bv-toc-highlight.fading {
	opacity: 0;
}
`;