import { App } from 'obsidian';
import { computePosition, flip, shift, offset, size } from '@floating-ui/dom';
import type { ScriptEntry } from '../settings';

export function dismissAllMenus(): void {
	const menus = document.querySelectorAll('[data-bv-menu]');
	Array.from(menus).forEach((el) => {
		const bvEl = el as HTMLElement;
		const cleanup = (bvEl as unknown as { _bvCleanup?: () => void })._bvCleanup;
		if (cleanup) cleanup();
		bvEl.remove();
	});
}

export function showScriptMenu(
	ev: MouseEvent,
	scripts: ScriptEntry[],
	app: App,
	onExecute: (entry: ScriptEntry) => void,
): void {
	dismissAllMenus();

	const bodyZoom = parseFloat(document.body.style.zoom) || 1;
	const x = ev.clientX / bodyZoom;
	const y = ev.clientY / bodyZoom;

	const menuEl = buildMenu(scripts, app, onExecute);
	menuEl.setAttribute('data-bv-menu', '');
	document.body.appendChild(menuEl);

	let dismissed = false;
	(menuEl as unknown as { _bvDismissed?: () => void })._bvDismissed = () => { dismissed = true; };

	const virtualEl = {
		getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
	};

	computePosition(virtualEl, menuEl, {
		placement: 'bottom-start',
		strategy: 'fixed',
		middleware: [
			offset(4),
			flip(),
			shift({ padding: 10 }),
			size({
				apply({ availableHeight, elements }) {
					elements.floating.style.maxHeight = `${Math.max(Math.min(availableHeight - 16, 600), 100)}px`;
					elements.floating.style.overflowY = 'auto';
				},
				padding: 8,
			}),
		],
	}).then(({ x: fx, y: fy }) => {
		if (dismissed) return;
		menuEl.style.left = `${Math.floor(fx)}px`;
		menuEl.style.top = `${Math.floor(fy)}px`;
	});

	const cleanup = registerDismissHandlers(menuEl);
	(menuEl as unknown as { _bvCleanup?: () => void })._bvCleanup = cleanup;
}

function buildMenu(
	scripts: ScriptEntry[],
	app: App,
	onExecute: (entry: ScriptEntry) => void,
): HTMLElement {
	const menu = document.createElement('div');
	menu.className = 'bv-menu';

	if (scripts.length === 0) {
		const empty = menu.createDiv({ cls: 'bv-menu-empty', text: 'No scripts configured' });
		empty.style.cssText = 'padding: 12px 16px; color: var(--text-muted); font-size: 12px; text-align: center;';
		return menu;
	}

	for (const entry of scripts) {
		menu.appendChild(createItem(entry, app, onExecute));
	}

	return menu;
}

function createItem(
	entry: ScriptEntry,
	app: App,
	onExecute: (entry: ScriptEntry) => void,
): HTMLElement {
	const item = document.createElement('div');
	item.className = 'bv-menu-item';

	item.createSpan({ cls: 'bv-menu-item-label', text: entry.label });

	item.addEventListener('click', (e) => {
		e.stopPropagation();
		dismissAllMenus();
		onExecute(entry);
	});

	return item;
}

function registerDismissHandlers(menuEl: HTMLElement): () => void {
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') dismissAllMenus();
	};

	const onClick = (e: MouseEvent) => {
		if (!menuEl.contains(e.target as Node)) dismissAllMenus();
	};

	document.addEventListener('keydown', onKeyDown, true);
	document.addEventListener('click', onClick, true);

	return () => {
		document.removeEventListener('keydown', onKeyDown, true);
		document.removeEventListener('click', onClick, true);
	};
}
