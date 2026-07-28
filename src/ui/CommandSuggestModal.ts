import { App, Command, FuzzySuggestModal, FuzzyMatch, setIcon } from 'obsidian';
import { ICON_LIST } from '../generated/icon-list';

export class CommandSuggestModal extends FuzzySuggestModal<Command> {
	private onSelect: (command: Command) => void;

	constructor(app: App, onSelect: (command: Command) => void) {
		super(app);
		this.onSelect = onSelect;
		this.setPlaceholder('Type to search for a command...');
		this.setInstructions([
			{ command: '\u2191\u2193', purpose: 'Navigate' },
			{ command: '\u21B5', purpose: 'Select command' },
			{ command: 'esc', purpose: 'Close' },
		]);
	}

	getItems(): Command[] {
		return (this.app as unknown as { commands: { listCommands: () => Command[] } }).commands.listCommands();
	}

	getItemText(command: Command): string {
		return command.name;
	}

	onChooseItem(command: Command): void {
		this.onSelect(command);
	}
}

export class IconSuggestModal extends FuzzySuggestModal<string> {
	private onSelect: (icon: string) => void;

	constructor(app: App, onSelect: (icon: string) => void) {
		super(app);
		this.onSelect = onSelect;
		this.setPlaceholder('Type to search for an icon...');
		this.setInstructions([
			{ command: '\u2191\u2193', purpose: 'Navigate' },
			{ command: '\u21B5', purpose: 'Select icon' },
			{ command: 'esc', purpose: 'Close' },
		]);
	}

	getItems(): string[] {
		return ICON_LIST;
	}

	getItemText(icon: string): string {
		return icon;
	}

	renderSuggestion(item: FuzzyMatch<string>, el: HTMLElement): void {
		const icon = item.item;
		const wrapper = el.createSpan({ cls: 'bv-icon-suggestion' });
		const iconEl = wrapper.createSpan({ cls: 'bv-icon-suggestion-icon' });
		try { setIcon(iconEl, icon); } catch { /* lucide icon not found */ }
		wrapper.createSpan({ text: icon });
	}

	onChooseItem(icon: string): void {
		this.onSelect(icon);
	}
}
