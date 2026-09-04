import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin, DecorationSet, EditorView } from '@codemirror/view';
import { RangeSetBuilder, Extension } from '@codemirror/state';

/**
 * Decorates Obsidian-style hashtags (#tag) with the theme's --tag-color.
 * lezer's markdown parser does not split tags into their own tokens, so we
 * walk the syntax tree ourselves and only decorate `#tag` snippets that sit
 * inside plain text (skipping headings, code fences/inline code, and links),
 * matching how Obsidian renders them in reading view.
 */
class TagDecorator {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.compute(view);
	}

	update(update: import('@codemirror/view').ViewUpdate): void {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.compute(update.view);
		}
	}

	private compute(view: EditorView): DecorationSet {
		const { state } = view;
		const tree = syntaxTree(state);
		const builder = new RangeSetBuilder<Decoration>();
		const tag = Decoration.mark({ class: 'cm-tag' });

		const regex = /(?:^|[\s(])(#[\p{L}\p{N}_/\\-]+)/gu;

		for (let pos = 0; pos < state.doc.length; ) {
			const line = state.doc.lineAt(pos);
			if (line.from > pos) pos = line.from;
			const text = state.doc.sliceString(line.from, line.to);
			regex.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = regex.exec(text)) !== null) {
				const start = line.from + m.index + (m[0].length - m[1]!.length);
				const end = start + m[1]!.length;
				if (this.inBlockedRange(tree, start, end)) continue;
				builder.add(start, end, tag);
			}
			pos = line.to + 1;
		}

		return builder.finish();
	}

	private inBlockedRange(tree: ReturnType<typeof syntaxTree>, from: number, to: number): boolean {
		let blocked = false;
		tree.iterate({
			enter(node) {
				if (node.from >= to || node.to <= from) return undefined;
				const type = node.type.name;
				if (
					type.startsWith('FencedCode') ||
					type.startsWith('InlineCode') ||
					type.startsWith('ATXHeading') ||
					type === 'CodeText' ||
					type === 'CodeMark' ||
					type === 'URL' ||
					type === 'Image' ||
					type.startsWith('Link')
				) {
					blocked = true;
					return false;
				}
				return undefined;
			},
		});
		return blocked;
	}
}

const tagDecoratorPlugin = ViewPlugin.fromClass<TagDecorator>(
	TagDecorator,
	{ decorations: (instance) => instance.decorations },
);

/** CodeMirror extension that decorates Obsidian hashtags (#tag). */
export function tagHighlight(): Extension[] {
	return [tagDecoratorPlugin];
}
