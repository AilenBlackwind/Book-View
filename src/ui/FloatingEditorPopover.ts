import { App, setIcon, TFile, WorkspaceLeaf } from 'obsidian';

export class FloatingEditorPopover {
	private app: App;
	private bookViewLeaf: WorkspaceLeaf;
	private popoverEl: HTMLElement | null = null;
	private leaf: WorkspaceLeaf | null = null;
	onClose: (() => void) | null = null;

	constructor(app: App, bookViewLeaf: WorkspaceLeaf) {
		this.app = app;
		this.bookViewLeaf = bookViewLeaf;
	}

	async open(file: TFile, x: number = 150, y: number = 100): Promise<void> {
		this.close();

		const clampX = Math.max(0, Math.min(x, window.innerWidth - 650));
		const clampY = Math.max(0, Math.min(y, window.innerHeight - 480));

		this.popoverEl = document.body.createDiv({ cls: 'book-popover' });
		this.popoverEl.style.left = `${clampX}px`;
		this.popoverEl.style.top = `${clampY}px`;

		const headerEl = this.popoverEl.createDiv({ cls: 'book-popover-header' });
		headerEl.createSpan({ text: file.basename, cls: 'book-popover-title' });

		const closeBtn = headerEl.createEl('button', { cls: 'book-popover-close' });
		setIcon(closeBtn, 'x');
		closeBtn.onclick = () => this.close();

		this.makeDraggable(headerEl, this.popoverEl);

		const editorContainer = this.popoverEl.createDiv({ cls: 'book-popover-editor-body' });

		// BookView's leaf.parent is a WorkspaceSplit — the real type that createLeafInParent expects
		const parentSplit = (this.bookViewLeaf as WorkspaceLeaf & { parent: unknown }).parent;
		if (!parentSplit) {
			this.close();
			return;
		}

		const ws = this.app.workspace as unknown as {
			createLeafInParent: (parent: unknown, index?: number) => WorkspaceLeaf;
		};

		const leaf = ws.createLeafInParent(parentSplit, -1);
		if (!leaf) {
			this.close();
			return;
		}

		const leafEl = leaf.view.containerEl;
		editorContainer.appendChild(leafEl);
		leafEl.addClass('book-popover-leaf');

		await leaf.openFile(file, { state: { mode: 'source' } });

		this.leaf = leaf;
	}

	close(): void {
		if (this.leaf) {
			this.leaf.detach();
			this.leaf = null;
		}
		if (this.popoverEl) {
			this.popoverEl.remove();
			this.popoverEl = null;
		}
		this.onClose?.();
	}

	private makeDraggable(handle: HTMLElement, target: HTMLElement): void {
		let isDragging = false;
		let startX = 0;
		let startY = 0;
		let initialLeft = 0;
		let initialTop = 0;

		handle.addEventListener('mousedown', (e: MouseEvent) => {
			if ((e.target as HTMLElement).closest('.book-popover-close')) return;

			isDragging = true;
			startX = e.clientX;
			startY = e.clientY;
			initialLeft = target.offsetLeft;
			initialTop = target.offsetTop;

			const onMouseMove = (moveEvent: MouseEvent) => {
				if (!isDragging) return;
				const dx = moveEvent.clientX - startX;
				const dy = moveEvent.clientY - startY;
				const maxLeft = window.innerWidth - target.offsetWidth;
				const maxTop = window.innerHeight - target.offsetHeight;
				target.style.left = `${Math.max(0, Math.min(initialLeft + dx, maxLeft))}px`;
				target.style.top = `${Math.max(0, Math.min(initialTop + dy, maxTop))}px`;
			};

			const onMouseUp = () => {
				isDragging = false;
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
			};

			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		});
	}
}
