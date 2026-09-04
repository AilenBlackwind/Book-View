import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin, DecorationSet, EditorView } from '@codemirror/view';
import { RangeSetBuilder, Extension } from '@codemirror/state';

/**
 * Hides markdown formatting markers (**, *, `, #, >, -, link/task brackets)
 * while the caret is away from them, revealing them again once the caret moves
 * onto or next to the formatted span — mimicking Obsidian's live preview.
 *
 * lezer already splits the markup out into leaf "Mark" nodes (EmphasisMark,
 * CodeMark, HeaderMark, QuoteMark, ListMark, LinkMark), so we only need to
 * locate those and swap them for an empty replacement when they aren't near
 * the selection. Formatted spans inside fenced/inline code never produce such
 * nodes, so code blocks are kept safe for free.
 */
class MarkerDecorator {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.compute(view);
	}

	update(update: import('@codemirror/view').ViewUpdate): void {
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
			this.decorations = this.compute(update.view);
		}
	}

	private compute(view: EditorView): DecorationSet {
		const { state } = view;
		const tree = syntaxTree(state);
		const builder = new RangeSetBuilder<Decoration>();

		// A mark is revealed while the caret sits anywhere inside the formatted
		// span it belongs to (e.g. the whole "**bold**"), matching Obsidian's
		// live preview — not just right at the marker itself. Expanding the
		// container check by a couple of characters either side avoids flicker
		// while typing at the very edges.
		const sel = state.selection.main;
		const focus = Math.min(Math.max(sel.head, 0), state.doc.length);

		type Mark = { from: number; to: number; reveal: boolean };
		const marks: Mark[] = [];
		const containerStack: { from: number; to: number; lineScoped: boolean }[] = [];

		tree.iterate({
			enter(node) {
				const name = node.type.name;
				if (
					name === 'StrongEmphasis' ||
					name === 'Emphasis' ||
					name === 'InlineCode' ||
					name.startsWith('ATXHeading') ||
					name === 'Blockquote' ||
					name === 'ListItem' ||
					name === 'Link'
				) {
					// Line-scoped containers (# heading, > quote, - item) only
					// reveal their marker while the caret is on the marker's own
					// line, not across the whole (possibly multi-line) span.
					const lineScoped =
						name.startsWith('ATXHeading') || name === 'Blockquote' || name === 'ListItem';
					containerStack.push({ from: node.from, to: node.to, lineScoped });
				} else if (
					name === 'EmphasisMark' ||
					name === 'CodeMark' ||
					name === 'HeaderMark' ||
					name === 'QuoteMark' ||
					name === 'ListMark' ||
					name === 'LinkMark'
				) {
					const container = containerStack[containerStack.length - 1];
					let reveal: boolean;
					if (container && container.lineScoped) {
						const line = state.doc.lineAt(node.from);
						// Reveal only while the caret sits on the marker's own line
						// (start..end), matching the inline spans — no "-2" step
						// back that would reach the previous line and toggle a
						// neighbouring heading's marker.
						reveal = focus >= line.from && focus <= line.to;
					} else if (container) {
						// Inline spans reveal their markers only while the caret
						// sits inside the span itself — never extending past its
						// far edge (no "+2" cushion), matching Obsidian.
						reveal = focus >= container.from && focus <= container.to;
					} else {
						reveal = focus >= node.from - 2 && focus <= node.to + 2;
					}
					// Structural markers (#, >, -) are followed by a separating
					// space; swallow it too so headings/quotes/list items don't
					// keep a leading indent when the marker is hidden.
					let to = node.to;
					if (
						(name === 'HeaderMark' || name === 'QuoteMark' || name === 'ListMark') &&
						state.doc.sliceString(node.to, node.to + 1) === ' '
					) {
						to = node.to + 1;
					}
					marks.push({ from: node.from, to, reveal });
				}
			},
			leave(node) {
				const name = node.type.name;
				if (
					name === 'StrongEmphasis' ||
					name === 'Emphasis' ||
					name === 'InlineCode' ||
					name.startsWith('ATXHeading') ||
					name === 'Blockquote' ||
					name === 'ListItem' ||
					name === 'Link'
				) {
					containerStack.pop();
				}
			},
		});

		for (const m of marks) {
			if (m.reveal) {
				continue;
			}
			builder.add(m.from, m.to, Decoration.replace({}));
		}

		return builder.finish();
	}
}

const markersPlugin = ViewPlugin.fromClass<MarkerDecorator>(
	MarkerDecorator,
	{ decorations: (instance) => instance.decorations },
);

/** CodeMirror extension that hides formatting markers outside the caret zone. */
export function markHide(): Extension[] {
	return [markersPlugin];
}
