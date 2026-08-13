import { App, FuzzySuggestModal, Notice, TFile } from 'obsidian';

function fnv1a(str: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseBufferSections(content: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = content.split('\n');

	let currentPath: string | null = null;
	const currentContent: string[] = [];

	for (const line of lines) {
		const startMatch = line.match(/^<!-- atom:(.+?) -->$/);
		if (startMatch) {
			currentPath = startMatch[1]!;
			currentContent.length = 0;
			continue;
		}

		if (line.trim() === '<!-- /atom -->' && currentPath) {
			sections.set(currentPath, currentContent.join('\n'));
			currentPath = null;
			currentContent.length = 0;
			continue;
		}

		if (currentPath) {
			currentContent.push(line);
		}
	}

	return sections;
}

function parseFrontmatter(content: string): { bufferMaster: string; atoms: Record<string, string> } | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const fm = match[1]!;
	let bufferMaster = '';
	const atoms: Record<string, string> = {};
	let inAtoms = false;

	for (const line of fm.split('\n')) {
		if (line.startsWith('buffer_master:')) {
			bufferMaster = line.substring(line.indexOf(':') + 1).trim().replace(/^"(.*)"$/, '$1');
		} else if (line.trim() === 'atoms:') {
			inAtoms = true;
		} else if (inAtoms && line.trim().startsWith('"')) {
			const atomMatch = line.trim().match(/^"(.+?)":\s*"(.+?)"$/);
			if (atomMatch) {
				atoms[atomMatch[1]!] = atomMatch[2]!;
			}
		}
	}

	if (!bufferMaster || Object.keys(atoms).length === 0) return null;
	return { bufferMaster, atoms };
}

class BufferPicker extends FuzzySuggestModal<TFile> {
	private onSelect: (file: TFile) => void;
	private files: TFile[];

	constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onSelect = onSelect;
		this.setPlaceholder('Select buffer to apply');
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.name;
	}

	onChooseItem(file: TFile): void {
		this.onSelect(file);
	}
}

export class BufferManager {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async applyBuffer(
		bufferPath: string,
		onApplied?: (paths: string[]) => void,
	): Promise<void> {
		const file = this.app.vault.getFileByPath(bufferPath);
		if (!(file instanceof TFile)) {
			new Notice('Buffer file not found');
			return;
		}

		const content = await this.app.vault.read(file);

		let parsed = parseFrontmatter(content);

		if (!parsed) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (fm?.buffer_master && fm?.atoms && typeof fm.atoms === 'object') {
				parsed = {
					bufferMaster: fm.buffer_master as string,
					atoms: fm.atoms as Record<string, string>,
				};
			}
		}

		if (!parsed) {
			new Notice('Invalid buffer: missing atoms mapping');
			return;
		}

		const sections = parseBufferSections(content);

		const appliedPaths: string[] = [];
		let skipped = 0;
		let notFound = 0;

		for (const [path, savedHash] of Object.entries(parsed.atoms)) {
			if (typeof savedHash !== 'string') continue;

			const atomFile = this.app.vault.getFileByPath(path);
			if (!(atomFile instanceof TFile)) {
				new Notice(`Atom not found: ${path}`);
				notFound++;
				continue;
			}

			const currentContent = await this.app.vault.cachedRead(atomFile);
			const currentHash = fnv1a(currentContent);

			if (currentHash !== savedHash) {
				new Notice(`Atom changed, skipping: ${atomFile.basename}`);
				skipped++;
				continue;
			}

			const newContent = sections.get(path);
			if (newContent === undefined) {
				new Notice(`No buffer content for: ${atomFile.basename}`);
				notFound++;
				continue;
			}

			await this.app.vault.modify(atomFile, newContent);
			appliedPaths.push(path);
		}

		await this.app.fileManager.trashFile(file);

		onApplied?.(appliedPaths);

		const parts: string[] = [];
		if (appliedPaths.length > 0) parts.push(`Applied: ${appliedPaths.length}`);
		if (skipped > 0) parts.push(`Skipped: ${skipped}`);
		if (notFound > 0) parts.push(`Not found: ${notFound}`);
		new Notice(parts.join(', ') || 'Done');
	}

	async findBuffers(): Promise<TFile[]> {
		return this.app.vault.getFiles().filter((f) => f.name.startsWith('_BUFFER_'));
	}

	async applyAnyBuffer(onApplied?: (paths: string[]) => void): Promise<void> {
		const buffers = await this.findBuffers();
		if (buffers.length === 0) {
			new Notice('No buffer files found');
			return;
		}
		if (buffers.length === 1) {
			const buffer = buffers[0];
			if (buffer) {
				await this.applyBuffer(buffer.path, onApplied);
			}
			return;
		}
		new BufferPicker(this.app, buffers, (f) => {
			void this.applyBuffer(f.path, onApplied);
		}).open();
	}
}
