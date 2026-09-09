import type { App } from 'obsidian';
import { ThemeSpacings } from './theme';

/** Identity of the stylesheet set a book was measured under: the active theme
 *  id plus the enabled snippet ids, both read from Obsidian's CustomCss API,
 *  combined with the measured vertical rhythm (see measureThemeSpacings).
 *
 *  Compared between saves and loads / css-change events. A mismatch means the
 *  persisted heights were measured under a different appearance, so they must
 *  be re-measured instead of trusted.
 *
 *  Deliberately NOT a hash of cssRules text: colors and other paint-only
 *  changes never alter heights, and a full-text hash would invalidate the
 *  cache over irrelevant edits. The three signals here are exactly the
 *  geometry-relevant ones we already know how to obtain cheaply. In-place
 *  edits inside the SAME theme/snippet file, which change neither themeId,
 *  snippet list nor the four spacer gaps, slip past this layer on purpose —
 *  the delta backstop (AbsoluteSectionManager, >15% height correction on a
 *  trusted persisted height) catches those. Colors are excluded by
 *  construction, so they never touch the cached geometry. */
export interface CssFingerprint {
	themeId: string;
	snippets: string[];
	spacings: ThemeSpacings;
}

/** The d.ts bundled with the obsidian npm package (1.12.3) does not type
 *  `app.customCss`; access goes through this local shape, matching the runtime
 *  method names, and degrades to an empty identity when the API is unavailable
 *  (then the fingerprint still carries the measured spacings). */
interface CustomCssLike {
	getTheme(): string;
	getSnippets(): string[];
}

function customCssOf(app: App): CustomCssLike | null {
	const css = (app as unknown as { customCss?: unknown }).customCss;
	if (!css || typeof css !== 'object') return null;
	const c = css as Partial<CustomCssLike>;
	if (typeof c.getTheme !== 'function' || typeof c.getSnippets !== 'function') return null;
	return c as CustomCssLike;
}

/** Current effective stylesheet identity + measured rhythm. */
export function makeCssFingerprint(app: App, spacings: ThemeSpacings): CssFingerprint {
	const css = customCssOf(app);
	let themeId = '';
	let snippets: string[] = [];
	if (css) {
		try {
			themeId = css.getTheme()?.trim() ?? '';
			const sn = css.getSnippets();
			if (Array.isArray(sn)) snippets = sn.filter((s): s is string => typeof s === 'string');
		} catch {
			// customCss API read failed — fall back to spacings-only identity.
		}
	}
	return {
		themeId,
		snippets: [...new Set(snippets)].sort(),
		spacings: { ...spacings },
	};
}

/** True when `a` (the stored fingerprint, may be null/undefined on first run)
 *  matches `b` (the current one). Spacings are integers (gapBetween rounds),
 *  so exact equality is safe. */
export function cssFingerprintsMatch(a: CssFingerprint | null | undefined, b: CssFingerprint): boolean {
	if (!a) return false;
	if (a.themeId !== b.themeId) return false;
	if (a.spacings.h1TopGap !== b.spacings.h1TopGap) return false;
	if (a.spacings.h2TopGap !== b.spacings.h2TopGap) return false;
	if (a.spacings.headerToHeaderGap !== b.spacings.headerToHeaderGap) return false;
	if (a.spacings.textGap !== b.spacings.textGap) return false;
	if (a.snippets.length !== b.snippets.length) return false;
	for (let i = 0; i < a.snippets.length; i++) {
		if (a.snippets[i] !== b.snippets[i]) return false;
	}
	return true;
}