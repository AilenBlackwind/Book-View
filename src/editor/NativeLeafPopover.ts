import { App, Hotkey, MarkdownView, Modal, Platform, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { CommandSuggestModal } from '../ui/CommandSuggestModal';
import { DebugLog } from '../utils/debug';

/** Match a KeyboardEvent against an Obsidian hotkey ({modifiers, key}).
 *  Modifier semantics follow Obsidian: 'Mod' is Cmd on macOS, Ctrl elsewhere.
 *  Key matching tries `event.key` first (digits, symbols, arrows, F-keys),
 *  then falls back to `event.code` for letter keys, which stays correct on
 *  non-Latin layouts where `event.key` is localized. */
function matchesHotkey(evt: KeyboardEvent, hk: Hotkey): boolean {
	const want = hk.modifiers ?? [];
	const wantMod = want.includes('Mod');
	const wantCtrl = want.includes('Ctrl');
	const wantMeta = want.includes('Meta');
	if (evt.shiftKey !== want.includes('Shift')) return false;
	if (evt.altKey !== want.includes('Alt')) return false;
	const isMac = Platform.isMacOS;
	if (wantMod ? (isMac ? !evt.metaKey : !evt.ctrlKey) : ((evt.ctrlKey && !wantCtrl) || (evt.metaKey && !wantMeta))) return false;
	if (wantCtrl && !evt.ctrlKey) return false;
	if (wantMeta && !evt.metaKey) return false;
	const key = hk.key.toLowerCase();
	if (evt.key.toLowerCase() === key) return true;
	return evt.code === 'Key' + key.toUpperCase();
}

/** Shape of a command entry used by resolvePaletteHotkeys; the `commands`
 *  registry is omitted from the `App` typings. */
interface CommandLike {
	hotkeys?: Hotkey[];
	callback?: unknown;
	checkCallback?: unknown;
	editorCallback?: unknown;
	editorCheckCallback?: unknown;
}

/**
 * Popover editor that reuses Obsidian's real editor by embedding a fully
 * detached `WorkspaceLeaf` (created via the private constructor) inside the
 * modal. This gives us native Live Preview — themes, syntax highlighting,
 * callouts, key bindings, and Obsidian's own markdown marker hiding — with no
 * custom CodeMirror stack, no separate popout window, and no open note on
 * screen required.
 *
 * Caveats:
 * - `new (WorkspaceLeaf as any)(this.app)` uses a private constructor (the
 *   public API only exposes `getLeaf()`), so this may break on future Obsidian
 *   versions. If it throws, fall back to the manual `LiveEditModal` stack or
 *   to `openPopoutLeaf()`.
 * - Save semantics differ from the manual editor: the native leaf is backed by
 *   a real vault file, and Obsidian persists it itself (auto-save). On close we
 *   just notify the caller to re-render; we do not force a `vault.modify`.
 * - The detached leaf is invisible to the workspace's active-leaf tracking, so
 *   commands and plugins that resolve "the current editor" would see the book
 *   view instead of the note in the popover. While the modal is open we claim
 *   `workspace.activeLeaf` / `workspace.activeEditor` ourselves (both are
 *   public properties) and restore the previous values on close — then editor
 *   commands (Mod+B…), the command palette and plugins like QuickAdd target
 *   the popover note. The modal blocks interaction with everything else, so
 *   claim-on-open / restore-on-close is sufficient.
 */
export class NativeLeafPopover extends Modal {
	private file: TFile;
	private line: number;
	private hideFrontmatter: boolean;
	private onSaveCallback: () => void;
	/** Called instead of silently closing when the detached-leaf hack fails
	 *  (private constructor gone, view not mounting). The caller opens the
	 *  native popout window so the user always gets an editor. */
	private onFallback: (() => void) | null;
	private leaf: WorkspaceLeaf | null = null;
	/** True between claimWorkspaceActive() and restoreWorkspaceActive(). */
	private claimedActive = false;
	private prevActiveLeaf: WorkspaceLeaf | null = null;
	private prevActiveEditor: unknown = null;
	private openTabButton: HTMLElement | null = null;
	private openTabPositionObserver: ResizeObserver | null = null;
	private onWindowResize = (): void => this.positionOpenTabButton();

	constructor(app: App, file: TFile, line: number, hideFrontmatter: boolean, onSaveCallback: () => void, onFallback?: () => void) {
		super(app);
		this.file = file;
		this.line = line;
		this.hideFrontmatter = hideFrontmatter;
		this.onSaveCallback = onSaveCallback;
		this.onFallback = onFallback ?? null;
	}

	/** Surface a failure to the caller (fallback editor) and dismiss silently:
	 *  the user should never be left with a no-op click. */
	private failOver(): void {
		const fallback = this.onFallback;
		this.onFallback = null;
		fallback?.();
		this.close();
	}

	/** Point the workspace's active-leaf tracking at the popover editor while
	 *  the modal is open. A detached leaf never becomes "active" by itself, so
	 *  editor commands, the command palette and plugins resolving the current
	 *  editor (getActiveViewOfType / getActiveFile / activeEditor) would all
	 *  miss it. Both properties are public on Workspace; guarded writes keep
	 *  this safe even if they become accessors on a future version. */
	private claimWorkspaceActive(): void {
		const view = this.leaf?.view;
		if (!view) return;
		const ws = this.app.workspace as unknown as {
			activeLeaf: WorkspaceLeaf | null;
			activeEditor: unknown;
		};
		try {
			this.prevActiveLeaf = ws.activeLeaf;
			this.prevActiveEditor = ws.activeEditor;
			ws.activeLeaf = this.leaf;
			ws.activeEditor = view;
			this.claimedActive = true;
		} catch (err) {
			DebugLog.log('POPOVER', 'claim active leaf failed:', String(err instanceof Error ? err.message : err));
		}
	}

	private restoreWorkspaceActive(): void {
		if (!this.claimedActive) return;
		this.claimedActive = false;
		const ws = this.app.workspace as unknown as {
			activeLeaf: WorkspaceLeaf | null;
			activeEditor: unknown;
		};
		try {
			ws.activeLeaf = this.prevActiveLeaf;
			ws.activeEditor = this.prevActiveEditor;
		} catch (err) {
			DebugLog.log('POPOVER', 'restore active leaf failed:', String(err instanceof Error ? err.message : err));
		}
		this.prevActiveLeaf = null;
		this.prevActiveEditor = null;
	}

	/** Stock binding of the core palette, used until/unless the real one
	 *  resolves (and when every resolution step fails). */
	private static readonly FALLBACK_HOTKEYS: Hotkey[] = [{ modifiers: ['Mod'], key: 'p' }];

	/** Palette hotkeys the keydown interceptor matches against. Resolved
	 *  asynchronously in onOpen; starts as the stock Mod+P binding. */
	private paletteHotkeys: Hotkey[] = NativeLeafPopover.FALLBACK_HOTKEYS;

	/** Capture-phase palette-hotkey interception on the modal (see onOpen). */
	private onModalKeydown = (evt: KeyboardEvent): void => {
		for (const hk of this.paletteHotkeys) {
			if (!matchesHotkey(evt, hk)) continue;
			evt.preventDefault();
			evt.stopImmediatePropagation();
			this.openCommandPicker();
			return;
		}
	};

	/** Resolve the user's actual command-palette hotkeys. Obsidian exposes no
	 *  public "hotkeys of command X" API, so read them from the places they
	 *  live, most explicit first: user overrides in `<configDir>/hotkeys.json`
	 *  (created after the first manual customization), the live keymap
	 *  bindings bound to the palette command's callback, the command's
	 *  declared defaults, and finally the stock Mod+P binding. */
	private async resolvePaletteHotkeys(): Promise<Hotkey[]> {
		// 1. User overrides.
		try {
			const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/hotkeys.json`);
			const map = JSON.parse(raw) as Record<string, Hotkey[]>;
			if (Array.isArray(map['command-palette:open']) && map['command-palette:open'].length) {
				return map['command-palette:open'];
			}
		} catch {
			// No overrides file (or unreadable) — fall through.
		}

		// 2+3. The command object: its callback identifies its live keymap
		// bindings (what is bound right now), its `hotkeys` field holds the
		// declared defaults. `App` typings omit `commands`; same cast as in
		// openCommandPicker.
		let declared: Hotkey[] | undefined;
		let callbackRefs: unknown[] = [];
		try {
			const commands = (this.app as unknown as { commands: { commands: Record<string, CommandLike> } }).commands.commands;
			const cmd = commands['command-palette:open'];
			declared = cmd?.hotkeys;
			callbackRefs = [cmd?.callback, cmd?.checkCallback, cmd?.editorCallback, cmd?.editorCheckCallback]
				.filter((fn): fn is () => unknown => typeof fn === 'function');
		} catch {
			// Command id gone / API changed — fall through.
		}

		// 3. Live keymap bindings whose func is the palette command's own
		// callback: this is whatever is actually bound at this moment, user
		// remaps included. `Keymap#getKeymap` is not in the public typings;
		// if the internals changed, the identity match simply finds nothing.
		try {
			const bindings = (this.app.keymap as unknown as { getKeymap?: () => { modifiers?: string[]; key: string; func?: unknown }[] })
				.getKeymap?.() ?? [];
			const live = bindings
				.filter((b) => callbackRefs.includes(b.func))
				.map((b) => ({ modifiers: b.modifiers ?? [], key: b.key }) as Hotkey);
			if (live.length) return live;
		} catch {
			// Keymap internals changed — fall through.
		}

		// 4. Declared defaults on the command.
		if (declared?.length) return declared;
		// 5. Stock binding.
		return NativeLeafPopover.FALLBACK_HOTKEYS;
	}

	/** Command picker that works while this modal is open: Obsidian's own
	 *  command palette never opens on top of a modal, but a stacked
	 *  FuzzySuggestModal does. Executed commands resolve their editor through
	 *  the claimed active-leaf pointers, so editor commands hit this note. */
	private positionOpenTabButton(): void {
		if (!this.openTabButton) return;
		const rect = this.modalEl.getBoundingClientRect();
		this.openTabButton.style.setProperty('--book-popover-left', `${Math.round(rect.right - 30)}px`);
		this.openTabButton.style.setProperty('--book-popover-top', `${Math.round(rect.top + 6)}px`);
	}

	private createOpenTabButton(): void {
		// Own class only: Obsidian's stock `.markdown-embed-link { display: none }`
		// (show-on-embed-hover) would hide a body-level element carrying it.
		const openTabButton = document.body.createDiv({
			cls: 'book-popover-open-tab',
			attr: { 'aria-label': 'Open note in new tab' },
		});
		this.openTabButton = openTabButton;
		setIcon(openTabButton, 'maximize-2');
		openTabButton.addEventListener('click', () => {
			this.close();
			const leaf = this.app.workspace.getLeaf('tab');
			void leaf.openFile(this.file, { eState: { line: Math.max(0, this.line), ch: 0 } });
		});
		this.positionOpenTabButton();
		window.addEventListener('resize', this.onWindowResize);
	}

	private openCommandPicker(): void {
		new CommandSuggestModal(this.app, (command) => {
			// `App` typings omit `commands`; same cast as CommandSuggestModal.
			(this.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(command.id);
		}).open();
	}

	async onOpen(): Promise<void> {
		const { contentEl, modalEl } = this;

		modalEl.addClass('book-edit-modal');
		if (this.hideFrontmatter) {
			modalEl.addClass('hide-frontmatter');
		}

		// The close action is part of the modal header. Remove only the known
		// native controls from this modal; never touch sibling modal instances.
		this.modalEl.querySelectorAll('.modal-close-button, .modal-header-button').forEach((el) => {
			(el as HTMLElement).classList.add('bv-close-hidden');
		});
		this.titleEl.querySelectorAll('.modal-close-button, .modal-header-button').forEach((el) => {
			(el as HTMLElement).classList.add('bv-close-hidden');
		});

		this.contentEl.empty();

		contentEl.createEl('h3', {
			text: this.file.basename,
			cls: 'book-edit-modal-header',
		});

		this.createOpenTabButton();

		// Obsidian's own command palette never opens while a modal is up (its
		// hotkey goes to the topmost scope — this modal — and is swallowed), so
		// the palette hotkey opens our own command picker on top of the popover
		// instead. The keydown interception is a capture-phase DOM listener on
		// the modal, not a scope hotkey: scope matching uses `event.key`,
		// which fails for letters on non-Latin layouts (same issue as Ctrl+F
		// in main.ts), while `event.code` is layout-independent. Capture also
		// gets the key before the embedded CodeMirror editor and the global
		// keymap. The hotkey itself is resolved from the user's real palette
		// binding (resolvePaletteHotkeys), not hardcoded.
		this.paletteHotkeys = NativeLeafPopover.FALLBACK_HOTKEYS;
		void this.resolvePaletteHotkeys().then((hks) => {
			this.paletteHotkeys = hks;
		});
		modalEl.addEventListener('keydown', this.onModalKeydown, { capture: true });

		const editorContainer = contentEl.createDiv({ cls: 'book-native-leaf-editor' });

		// Private constructor: creates a leaf not attached to a workspace tab.
		// Wrap in `as any` to bypass the private accessor.
		let leaf: WorkspaceLeaf;
		try {
			leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(this.app);
		} catch {
			// Constructor unavailable on this Obsidian version — fall back to
			// the native popout window instead of a silent no-op.
			this.failOver();
			return;
		}

		this.leaf = leaf;

		try {
			await leaf.setViewState({
				type: 'markdown',
				state: {
					file: this.file.path,
					mode: 'source',
					cursor: { line: this.line, ch: 0 },
					// `frontmatter:false` hides the YAML block in the edit view.
					frontmatter: !this.hideFrontmatter,
				},
			});
		} catch (err) {
			DebugLog.log('POPOVER', 'setViewState failed, falling back:', String(err instanceof Error ? err.message : err));
			// Keep this.leaf: onClose still detaches a partially mounted leaf.
			this.failOver();
			return;
		}

		const viewEl = leaf.view?.containerEl;
		if (!viewEl) {
			this.failOver();
			return;
		}
		editorContainer.appendChild(viewEl);

		// Make the popover editor the workspace's "current editor" so commands
		// and plugins resolve it (see claimWorkspaceActive).
		this.claimWorkspaceActive();

		// Focus the native editor once laid out, and scroll to the line.
		window.requestAnimationFrame(() => {
			const view = leaf.view instanceof MarkdownView ? leaf.view : (leaf.view as MarkdownView | undefined);
			const editor = view?.editor;
			if (editor) {
				editor.setCursor({ line: Math.max(0, this.line), ch: 0 });
				editor.scrollIntoView({ from: editor.getCursor(), to: editor.getCursor() }, true);
				editor.focus();
			}
		});
	}

	onClose(): void {
		// Give the active-leaf pointers back before the editor DOM goes away.
		this.restoreWorkspaceActive();
		this.modalEl.removeEventListener('keydown', this.onModalKeydown, { capture: true });
		window.removeEventListener('resize', this.onWindowResize);
		this.openTabPositionObserver?.disconnect();
		this.openTabPositionObserver = null;
		this.openTabButton?.remove();
		this.openTabButton = null;
		this.modalEl.removeClass('book-edit-modal', 'hide-frontmatter');
		if (this.leaf) {
			try {
				this.leaf.detach();
			} catch (err) {
				// A leaf that never mounted may refuse to detach; ignore — the
				// fallback editor is already open at this point.
				DebugLog.log('POPOVER', 'detach failed on close:', String(err instanceof Error ? err.message : err));
			}
			this.leaf = null;
		}
		this.contentEl.empty();
		// The native leaf persists the file itself; just let the book re-render.
		this.onSaveCallback();
	}
}
