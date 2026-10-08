import { App, ButtonComponent, FuzzySuggestModal, Modal, Setting, TextComponent, TFile, type FuzzyMatch } from "obsidian";

interface PromptOptions {
	title: string;
	label?: string;
	placeholder?: string;
	value?: string;
	cta?: string;
	description?: string;
}

/** Asks for one line of text. Resolves to null when cancelled. */
export function promptText(app: App, options: PromptOptions): Promise<string | null> {
	return new Promise((resolve) => new PromptModal(app, options, resolve).open());
}

class PromptModal extends Modal {
	private result: string | null = null;

	constructor(
		app: App,
		private readonly options: PromptOptions,
		private readonly done: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		if (this.options.description) this.contentEl.createEl("p", { text: this.options.description, cls: "sankey-flow-hint" });
		let input!: TextComponent;
		const submit = () => {
			const value = input.getValue().trim();
			if (!value) return;
			this.result = value;
			this.close();
		};
		new Setting(this.contentEl).setName(this.options.label ?? "Name").addText((text) => {
			input = text;
			text.setPlaceholder(this.options.placeholder ?? "").setValue(this.options.value ?? "");
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
		});
		const buttons = this.contentEl.createDiv("sankey-flow-modal-buttons");
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons).setButtonText(this.options.cta ?? "Create").setCta().onClick(submit);
		window.setTimeout(() => {
			input.inputEl.focus();
			input.inputEl.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
		this.done(this.result);
	}
}

interface ConfirmOptions {
	title: string;
	message: string;
	cta: string;
	warning?: boolean;
}

export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, options, resolve).open());
}

class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly done: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", { text: this.options.message });
		const buttons = this.contentEl.createDiv("sankey-flow-modal-buttons");
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		const ok = new ButtonComponent(buttons).setButtonText(this.options.cta).onClick(() => {
			this.confirmed = true;
			this.close();
		});
		if (this.options.warning) ok.setWarning();
		else ok.setCta();
	}

	onClose(): void {
		this.contentEl.empty();
		this.done(this.confirmed);
	}
}

/** Fuzzy picker over a list of files. */
export class FilePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		placeholder: string,
		private readonly onPick: (file: TFile, evt: MouseEvent | KeyboardEvent) => void,
		empty = "No files found.",
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = empty;
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path.replace(/\.md$/i, "");
	}

	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		const folder = match.item.parent?.path;
		if (folder && folder !== "/") el.createDiv({ cls: "suggestion-note", text: folder });
	}

	onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
		this.onPick(file, evt);
	}
}

const FROM_COMPUTER = "\u0000computer";

/** Picks a CSV file from the vault, or from the computer via the system file dialog. */
export class CsvSourceModal extends FuzzySuggestModal<TFile | typeof FROM_COMPUTER> {
	constructor(
		app: App,
		private readonly onPick: (text: string, name: string) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a CSV file…");
		this.emptyStateText = "No CSV files in this vault.";
	}

	getItems(): (TFile | typeof FROM_COMPUTER)[] {
		const csv = this.app.vault.getFiles().filter((f) => ["csv", "tsv"].includes(f.extension.toLowerCase()));
		return [FROM_COMPUTER, ...csv.sort((a, b) => b.stat.mtime - a.stat.mtime)];
	}

	getItemText(item: TFile | typeof FROM_COMPUTER): string {
		return item === FROM_COMPUTER ? "Choose a file from your computer…" : item.path;
	}

	onChooseItem(item: TFile | typeof FROM_COMPUTER): void {
		if (item === FROM_COMPUTER) {
			pickLocalFile(".csv,.tsv,.txt,text/csv").then((picked) => {
				if (picked) this.onPick(picked.text, picked.name);
			});
			return;
		}
		void this.app.vault.cachedRead(item).then((text) => this.onPick(text, item.basename));
	}
}

/** Opens the system file dialog and reads the chosen text file. Nothing is written to disk. */
export function pickLocalFile(accept: string): Promise<{ text: string; name: string } | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = accept;
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) return resolve(null);
			void file.text().then((text) => resolve({ text, name: file.name.replace(/\.[^.]+$/, "") }));
		});
		input.click();
	});
}
