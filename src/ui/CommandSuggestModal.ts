import { App, Command, FuzzySuggestModal, FuzzyMatch } from 'obsidian';

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

	renderSuggestion(item: FuzzyMatch<Command>, el: HTMLElement): void {
		el.createSpan({ text: item.item.name });
	}
}
