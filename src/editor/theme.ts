import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Extension } from '@codemirror/state';

/**
 * Markdown highlighting for the popup editor that follows the active Obsidian
 * theme instead of CodeMirror's default scheme. Obsidian ships per-level
 * heading CSS variables (--h1-* … --h6-*: color, size, weight, font) plus
 * dedicated colors for emphasis, names/links, and inline code; mapping CM's
 * tag tokens onto those variables makes the popup read like the real note
 * editor. Falls back to --text-normal / sensible defaults if a theme omits
 * any of them.
 */

export const obsidianMarkdownStyle = HighlightStyle.define([
	{
		tag: [t.heading1],
		color: 'var(--h1-color, var(--text-normal))',
		fontSize: 'var(--h1-size, 1.6em)',
		fontWeight: 'var(--h1-weight, 700)',
		fontFamily: 'var(--h1-font, inherit)',
	},
	{
		tag: [t.heading2],
		color: 'var(--h2-color, var(--text-normal))',
		fontSize: 'var(--h2-size, 1.4em)',
		fontWeight: 'var(--h2-weight, 700)',
		fontFamily: 'var(--h2-font, inherit)',
	},
	{
		tag: [t.heading3],
		color: 'var(--h3-color, var(--text-normal))',
		fontSize: 'var(--h3-size, 1.25em)',
		fontWeight: 'var(--h3-weight, 600)',
		fontFamily: 'var(--h3-font, inherit)',
	},
	{
		tag: [t.heading4],
		color: 'var(--h4-color, var(--text-normal))',
		fontSize: 'var(--h4-size, 1.1em)',
		fontWeight: 'var(--h4-weight, 600)',
		fontFamily: 'var(--h4-font, inherit)',
	},
	{
		tag: [t.heading5],
		color: 'var(--h5-color, var(--text-normal))',
		fontSize: 'var(--h5-size, 1.05em)',
		fontWeight: 'var(--h5-weight, 600)',
		fontFamily: 'var(--h5-font, inherit)',
	},
	{
		tag: [t.heading6],
		color: 'var(--h6-color, var(--text-normal))',
		fontSize: 'var(--h6-size, 1em)',
		fontWeight: 'var(--h6-weight, 600)',
		fontFamily: 'var(--h6-font, inherit)',
	},
	{
		tag: [t.strong],
		color: 'var(--bold-color, var(--text-normal))',
		fontWeight: 'bold',
	},
	{
		tag: [t.emphasis],
		color: 'var(--italic-color, var(--text-normal))',
		fontStyle: 'italic',
	},
	{
		tag: [t.strikethrough],
		color: 'var(--text-muted)',
		textDecoration: 'line-through',
	},
	{
		tag: [t.monospace],
		color: 'var(--text-code, var(--text-normal))',
		backgroundColor: 'var(--code-background, var(--background-secondary))',
		borderRadius: '3px',
		padding: '0 3px',
		fontFamily: 'var(--font-monospace)',
	},
	{
		tag: [t.link, t.url],
		color: 'var(--link-color, var(--text-accent))',
		textDecoration: 'underline',
	},
	{
		tag: [t.quote],
		color: 'var(--text-muted)',
		fontStyle: 'italic',
	},
	{
		tag: [t.comment],
		color: 'var(--text-faint, var(--text-muted))',
		fontStyle: 'italic',
	},
]);

/** CodeMirror syntax highlighting extension that maps onto Obsidian theme vars. */
export function markdownHighlight(): Extension[] {
	return [syntaxHighlighting(obsidianMarkdownStyle, { fallback: true })];
}
