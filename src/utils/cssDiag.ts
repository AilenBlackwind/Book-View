import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type BookViewPlugin from '../main';

export type HasSource = 'theme' | 'snippet' | 'plugin' | 'other';

export interface HasFinding {
	sheet: string;
	selector: string;
	severity: 'high' | 'medium';
	source: HasSource;
}

/**
 * Diagnostic for the class of stylesheet rules that caused real, measured
 * style-recalc freezes on every section mount:
 *
 *     div:has(:is(h1, h2, h3, h4)):has(+ div > .callout[data-callout*="list"])
 *
 * A `:has()` anchored to a broad element can increase selector work when
 * descendants change. The cost depends on the complete selector, DOM and browser;
 * this scan flags candidates, not measured slow rules. A pure sibling argument
 * is excluded by this heuristic, but that is not a performance guarantee.
 *
 * The scan is pure string parsing of selectorText. It never touches the live
 * DOM, never runs querySelectorAll with :has(), and never forces layout, so
 * running it cannot itself trigger the invalidation it is looking for.
 */

/** Tags that match a large number of unrelated nodes in a document. */
const BROAD_TAGS = new Set([
	'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'section', 'article', 'header',
	'footer', 'nav', 'main', 'aside', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'form', 'button',
	'input', 'body',
]);

/** Container classes every reading/notes view has one of per note. */
const BROAD_CLASSES = new Set(['markdown-rendered', 'markdown-preview-view']);

/** Split a selector on top-level commas, respecting () and [] nesting. */
function splitTopLevel(sel: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < sel.length; i++) {
		const c = sel[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (depth === 0 && c === ',') {
			parts.push(sel.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(sel.slice(start));
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Positions of `:has(` … `)` spans in one selector, with their argument text. */
function findHasCalls(part: string): Array<{ subjectStart: number; arg: string }> {
	const out: Array<{ subjectStart: number; arg: string }> = [];
	const needle = ':has(';
	let idx = part.indexOf(needle);
	while (idx !== -1) {
		let depth = 0;
		for (let i = idx + needle.length; i < part.length; i++) {
			const c = part[i];
			if (c === '(') depth++;
			else if (c === ')') {
				if (depth === 0) {
					out.push({ subjectStart: idx, arg: part.slice(idx + needle.length, i) });
					break;
				}
				depth--;
			}
		}
		idx = part.indexOf(needle, idx + needle.length);
	}
	return out;
}

/** The compound selector immediately before `:has(`, as one token. */
function subjectBefore(part: string, subjectStart: number): string {
	let depth = 0;
	let i = subjectStart - 1;
	while (i >= 0) {
		const c = part[i];
		if (c === ')' || c === ']') { depth++; i--; continue; }
		if (c === '(' || c === '[') {
			if (depth > 0) depth--;
			i--;
			continue;
		}
		if (depth === 0 && (c === ' ' || c === '+' || c === '~' || c === '>')) break;
		i--;
	}
	return part.slice(i + 1, subjectStart).trim();
}

/** Heuristic: does this subject match many unrelated nodes in any document? */
function isBroadSubject(subject: string): boolean {
	const s = subject;
	if (!s) return false;
	if (s === '*') return true;
	// Bare type selector, e.g. `div`, `section`, `h2`.
	if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) {
		return BROAD_TAGS.has(s.toLowerCase());
	}
	// Type selector with attribute filter, e.g. `div[data-x]`.
	const typeAttr = /^([a-zA-Z][a-zA-Z0-9-]*)\[/.exec(s);
	if (typeAttr && BROAD_TAGS.has(typeAttr[1]!.toLowerCase())) return true;
	// Element groups like `:is(h1, h2, h3, h4)` and `:where(...)`.
	const group = /^:(is|where)\((.*)\)$/.exec(s);
	if (group) {
		return splitTopLevel(group[2]!).some((arg) => {
			const tag = arg.trim().split('[')[0]!.toLowerCase();
			return BROAD_TAGS.has(tag) || tag === '*';
		});
	}
	// Global per-note container classes.
	if (/^\.([a-zA-Z][a-zA-Z0-9-]*)(\.[a-zA-Z][a-zA-Z0-9-]*)*$/.test(s)) {
		return BROAD_CLASSES.has(s.split('.')[1]!.toLowerCase());
	}
	return false;
}

/**
 * Cost class for a :has() argument:
 *  - null: only sibling-prefixed branches (+ / ~), excluded by the heuristic.
 *  - 'medium': child-prefixed branches (>), worth inspecting if profiling is slow.
 *  - 'high': at least one unrestricted descendant branch.
 * These are syntax categories, not browser timings or invalidation guarantees.
 */
function argSeverity(arg: string): 'high' | 'medium' | null {
	let severity: 'medium' | null = null;
	for (const branch of splitTopLevel(arg)) {
		const first = branch[0];
		if (first === '+' || first === '~') continue;
		if (first !== '>') return 'high';
		severity = 'medium';
	}
	return severity;
}

function sheetLabel(sheet: CSSStyleSheet): string {
	const node = sheet.ownerNode;
	if (!node) return '(adopted stylesheet)';
	if (node instanceof HTMLLinkElement) {
		const name = node.href?.split('/').pop() ?? '';
		return `link:${name}`;
	}
	if (node instanceof HTMLStyleElement) {
		const cls = (node as HTMLElement).className?.trim() ?? '';
		return `<style>${cls ? `.${cls.replace(/\s+/g, '.')}` : ''}`;
	}
	if (node instanceof HTMLElement) return node.tagName.toLowerCase();
	return 'unknown';
}

/** Runtime shape of Obsidian's CustomCss instance (`app.customCss`). The d.ts
 *  bundled with the obsidian npm package doesn't type it, and the documented
 *  `getTheme()` / `getSnippets()` methods don't exist on the runtime class —
 *  only these plain fields do. The theme CSS lives in the single `styleEl`;
 *  every enabled snippet gets its own `<style>` element in `extraStyleEls`
 *  (plugin `<style>` elements are siblings of these, inserted right before
 *  `styleEl`, with no distinguishing class). */
interface CustomCssRuntimeLike {
	styleEl: HTMLStyleElement | null;
	extraStyleEls: HTMLStyleElement[];
}

function customCssRuntimeOf(app: App): CustomCssRuntimeLike | null {
	const css = (app as unknown as { customCss?: unknown }).customCss;
	if (!css || typeof css !== 'object') return null;
	const c = css as Partial<CustomCssRuntimeLike>;
	return {
		styleEl: c.styleEl ?? null,
		extraStyleEls: Array.isArray(c.extraStyleEls) ? c.extraStyleEls : [],
	};
}

/** Classify a stylesheet's owner as user theme, user snippet, plugin, or other. */
function sheetSource(sheet: CSSStyleSheet, css: CustomCssRuntimeLike | null): HasSource {
	const node = sheet.ownerNode;
	if (css && node) {
		if (node === css.styleEl) return 'theme';
		if (node instanceof HTMLStyleElement && css.extraStyleEls.includes(node)) return 'snippet';
	}
	// A generic <style> may belong to Obsidian itself. Its tag alone cannot
	// identify a third-party plugin. Only classify a plugin when its URL does.
	if (sheet.href && /[/\\]plugins[/\\]/.test(sheet.href)) return 'plugin';
	return 'other';
}

/** Scan all readable stylesheets for expensive :has() selectors. */
export function scanHasPerformance(app?: App): HasFinding[] {
	const out: HasFinding[] = [];
	const seen = new Set<string>();
	const css = app ? customCssRuntimeOf(app) : null;

	const processSelector = (selector: string, sheetName: string, source: HasSource) => {
		for (const part of splitTopLevel(selector)) {
			for (const call of findHasCalls(part)) {
				const subject = subjectBefore(part, call.subjectStart);
				if (!isBroadSubject(subject)) continue;
				const severity = argSeverity(call.arg);
				if (!severity) continue;
				const key = `${sheetName}\u0000${part}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ sheet: sheetName, selector: part, severity, source });
			}
		}
	};

	const walk = (ruleList: CSSRuleList, sheetName: string, source: HasSource) => {
		for (const rule of Array.from(ruleList)) {
			const st = (rule as unknown as { selectorText?: string }).selectorText;
			if (typeof st === 'string' && st.includes(':has(')) {
				processSelector(st, sheetName, source);
			}
			const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules;
			if (nested) walk(nested, sheetName, source);
		}
	};

	for (const [index, sheet] of Array.from(document.styleSheets).entries()) {
		if (sheet.disabled) continue;
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			// Unreadable sheets cannot be evaluated by this diagnostic.
			continue;
		}
		// Anonymous style elements can have the same label. Keep their findings
		// separate instead of deduplicating unrelated sheets together.
		walk(rules, `${sheetLabel(sheet)} [sheet ${index + 1}]`, sheetSource(sheet, css));
	}

	return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

/** Pretty-print findings to the console for interactive inspection.
 *  Uses only debug/warn (allowed by the obsidian no-console rule). */
export function logHasFindings(findings: HasFinding[], force = false): void {
	if (findings.length === 0) {
		if (force) console.debug('[Book View] CSS :has() diagnostics: no heuristic matches found.');
		return;
	}
	for (const f of findings) {
		console.debug(`[Book View] ${f.severity} [${f.source}] ${f.sheet} :: ${f.selector}`);
	}
	const counts = (['snippet', 'theme', 'plugin', 'other'] as const)
		.map((source) => `${source}=${findings.filter((finding) => finding.source === source).length}`)
		.join(', ');
	const message = `[Book View] CSS :has() heuristic: ${findings.length} candidate selector(s) (${counts}). `
		+ 'This scans readable document stylesheets, not just snippets, and does not measure style or layout cost. '
		+ 'Rules may be scoped to unrelated views or inactive conditions. Confirm slow selectors with a Performance recording.';
	if (force || findings.some((finding) => finding.source === 'snippet' && finding.severity === 'high')) {
		console.warn(message);
	} else {
		console.debug(message);
	}
}

let warnedOnce = false;

/**
 * One-time-per-session auto-warning shown on the first opened book. Gated by
 * the `cssHasWarningEnabled` setting. Reads nothing from the live layout.
 *
 * Only selectors from the user's own CSS snippets trigger the notice; theme
 * and third-party plugin styles are still logged to the console so a theme can
 * be identified as the culprit without spamming a warning the user can't fix.
 */
export function maybeWarnHasSelectors(plugin: BookViewPlugin): void {
	if (warnedOnce) return;
	warnedOnce = true;
	if (!plugin.settings.cssHasWarningEnabled) return;
	const findings = scanHasPerformance(plugin.app);
	if (findings.length > 0) logHasFindings(findings, false);
	const snippetHigh = findings.filter((f) => f.source === 'snippet' && f.severity === 'high').length;
	// Child-scoped :has(> x) is bounded and rarely a real problem; only warn
	// automatically when a descendant-scoped rule (the freeze class) is found.
	if (snippetHigh === 0) return;
	const example = findings.find((f) => f.source === 'snippet' && f.severity === 'high')!.selector;
	new Notice(
		`Book View: ${snippetHigh} potentially costly :has() selector${snippetHigh > 1 ? 's' : ''} in your CSS snippets. This is a heuristic, not a measured slowdown (details in console). Example: ${example}`,
		15000,
	);
}
