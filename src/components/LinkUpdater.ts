import { App, TFile } from 'obsidian';
import { isBookManifest } from './ManifestParser';

function normalizeForCompare(path: string): string {
	return path.replace(/\.md$/, '').toLowerCase();
}

/** Vault-absolute path for a markdown link target, resolved against the
 *  manifest's directory.  Wikilink targets are already vault-absolute. */
function resolveLinkTarget(target: string, manifestPath: string): string {
	if (target.startsWith('/')) return target.substring(1);
	const baseDir = manifestPath.substring(0, manifestPath.lastIndexOf('/'));
	const parts = (baseDir + '/' + target).split('/');
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '' || part === '.') continue;
		if (part === '..') { resolved.pop(); } else { resolved.push(part); }
	}
	return resolved.join('/');
}

/** Recompute a relative markdown link target from the manifest's directory to
 *  `toPath`, preserving the original `./` / `../` prefix style. */
function relativeFromManifest(target: string, manifestPath: string, toPath: string): string {
	const baseDir = manifestPath.substring(0, manifestPath.lastIndexOf('/'));
	const from = baseDir ? baseDir.split('/') : [];
	const to = toPath.split('/');
	let i = 0;
	while (i < from.length && i < to.length && from[i] === to[i]) i++;
	const ups = from.length - i;
	const rel = [...new Array(ups).fill('..'), ...to.slice(i)].join('/');
	const relWasRelative = /^(\.\.?\/)/.test(target);
	return (relWasRelative ? './' : '') + rel;
}

/**
 * Replace link targets inside ```book-view fenced code blocks that resolve
 * to `oldPath` with `newPath`.  Returns the modified content, or `null` if
 * nothing changed.
 */
export function updateLinksInContent(
	content: string,
	oldPath: string,
	newPath: string,
	manifestPath: string,
): string | null {
	const normalizedOld = normalizeForCompare(oldPath);
	let modified = false;

	const result = content.replace(
		/```book-view\n([\s\S]*?)```/g,
		(fullMatch: string, blockContent: string) => {
			const newBlock = blockContent.replace(
				/\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g,
				(
					linkMatch: string,
					wikilinkInner: string | undefined,
					mdDisplay: string | undefined,
					mdTarget: string | undefined,
				): string => {
					let rawTarget: string;
					let rebuild: (newTarget: string) => string;

					if (wikilinkInner !== undefined) {
						const pipe = wikilinkInner.indexOf('|');
						rawTarget = (pipe === -1 ? wikilinkInner : wikilinkInner.substring(0, pipe)).trim();
						rebuild = (nt) =>
							pipe === -1 ? `[[${nt}]]` : `[[${nt}${wikilinkInner.substring(pipe)}]]`;
					} else if (mdDisplay !== undefined && mdTarget !== undefined) {
						rawTarget = mdTarget.trim();
						rebuild = (nt) => `[${mdDisplay}](${nt})`;
					} else {
						return linkMatch;
					}

					// Wikilinks are vault-absolute paths; markdown links may be
					// relative to the manifest and need resolution to compare.
					const effectiveTarget = wikilinkInner !== undefined
						? rawTarget.replace(/^\/+/, '')
						: resolveLinkTarget(rawTarget, manifestPath);
					if (normalizeForCompare(effectiveTarget) !== normalizedOld) {
						return linkMatch;
					}

					modified = true;
					const hadMd = rawTarget.endsWith('.md');
					const newTargetMd = hadMd ? newPath + '.md' : newPath.replace(/\.md$/, '');

					// Wikilinks are vault-absolute → just swap in newPath.
					if (wikilinkInner !== undefined) {
						return rebuild(newTargetMd);
					}

					// Markdown links: relative targets are recomputed against
					// the manifest directory (preserving `.md` and the `./`
					// prefix); absolute targets swap the path, keeping the
					// leading `/` when the original used it.
					if (rawTarget.startsWith('/')) {
						return rebuild('/' + newTargetMd);
					}
					if (/^(\.\.?\/)/.test(rawTarget)) {
						const rel = relativeFromManifest(rawTarget, manifestPath, newTargetMd);
						return rebuild(rel);
					}
					return rebuild(newTargetMd);
				},
			);
			return newBlock === blockContent ? fullMatch : `\`\`\`book-view\n${newBlock}\`\`\``;
		},
	);

	return modified ? result : null;
}

/**
 * Scan every manifest file for ```book-view code blocks and rewrite any
 * links that pointed to `oldPath` so they point to `newPath` instead.
 */
export async function updateManifestLinksOnRename(
	app: App,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (!isBookManifest(app, file)) continue;
		try {
			const content = await app.vault.cachedRead(file);
			const updated = updateLinksInContent(content, oldPath, newPath, file.path);
			if (updated !== null) {
				await app.vault.modify(file, updated);
			}
		} catch {
			// File may have been deleted between the check and the read.
		}
	}
}
