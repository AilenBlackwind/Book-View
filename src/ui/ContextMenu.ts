import { App, setIcon } from 'obsidian';
import { computePosition, flip, shift, offset, size } from '@floating-ui/dom';
import type { ScriptEntry } from '../settings';

export function dismissAllMenus(): void {
	const menus = document.querySelectorAll('[data-bv-menu]');
	Array.from(menus).forEach((el) => {
		const bvEl = el as HTMLElement;
		clearTimeouts(bvEl);
		const cleanup = (bvEl as unknown as { _bvCleanup?: () => void })._bvCleanup;
		if (cleanup) cleanup();
		bvEl.remove();
	});
}

function clearTimeouts(el: HTMLElement): void {
	const groups = el.querySelectorAll('[data-bv-timeouts]');
	Array.from(groups).forEach((g) => {
		const ids = (g as HTMLElement).dataset.bvTimeouts;
		if (ids) {
			ids.split(',').forEach((id) => {
				const n = parseInt(id, 10);
				if (!isNaN(n)) window.clearTimeout(n);
			});
		}
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

	void computePosition(virtualEl, menuEl, {
		placement: 'bottom-start',
		strategy: 'fixed',
		middleware: [
			offset(4),
			flip(),
			shift({ padding: 10 }),
			size({
				apply({ availableHeight, elements }) {
					elements.floating.style.maxHeight = `${Math.max(Math.min(availableHeight - 16, 600), 100)}px`;
					elements.floating.addClass('bv-menu-scrollable');
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
	const menu = createDiv({ cls: 'bv-menu' });

	const valid = scripts.filter((e) => e.commandId || e.isSeparator);

	if (valid.length === 0) {
		const empty = menu.createDiv({ cls: 'bv-menu-empty' });
		empty.setText('No commands configured');
		return menu;
	}

	for (const entry of valid) {
		menu.appendChild(createItem(entry, app, onExecute));
	}

	return menu;
}

function createItem(
	entry: ScriptEntry,
	app: App,
	onExecute: (entry: ScriptEntry) => void,
): HTMLElement {
	if (entry.isSeparator) return createSeparator();

	const item = createDiv({ cls: 'bv-menu-item' });

	if (entry.color) {
		item.style.color = entry.color;
	}

	if (entry.icon) {
		const iconEl = item.createSpan({ cls: 'bv-menu-item-icon' });
		if (entry.color) {
			iconEl.style.color = entry.color;
		}
		try { setIcon(iconEl, entry.icon); } catch { /* lucide icon not found */ }
	}

	item.createSpan({ cls: 'bv-menu-item-label', text: entry.label });

	item.addEventListener('click', (e) => {
		e.stopPropagation();
		dismissAllMenus();
		onExecute(entry);
	});

	return item;
}

function createSeparator(): HTMLElement {
	return createDiv({ cls: 'bv-menu-separator' });
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
