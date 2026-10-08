import { ButtonComponent, Modal, Setting, type DropdownComponent, type ToggleComponent } from "obsidian";
import type SankeyFlowPlugin from "../main";
import { CsvError, parseCsv, type CsvDelimiter } from "../data/csv";
import type { DecimalFormat } from "../data/numbers";
import {
	DEFAULT_SYNONYMS,
	buildRows,
	documentFromRows,
	firstRowLooksLikeHeader,
	guessMapping,
	summarizeProblems,
	tableFromRows,
	type ColumnMapping,
	type ImportResult,
	type ImportRow,
	type RawTable,
} from "../data/tableImport";
import { splitNames } from "../settings/settings";
import { SankeyRenderer } from "../render/SankeyRenderer";
import { errorMessage } from "../util/logger";

export type ImportSource = { kind: "csv"; text: string; name: string } | { kind: "table"; table: RawTable; name: string };

export interface ImportResultChoice {
	rows: ImportRow[];
	name: string;
	merge: boolean;
	/** Only offered for tables: insert an embed below the source table. */
	insertEmbed: boolean;
	/** Only offered when importing into an existing diagram. */
	replace: boolean;
}

export interface ImportModalOptions {
	source: ImportSource;
	/** "new" creates a diagram; "into" adds to the open one. */
	target: "new" | "into";
	onSubmit: (choice: ImportResultChoice) => void | Promise<void>;
}

const PREVIEW_ROWS = 60;

/**
 * Preview → map columns → preview Sankey → confirm. Nothing is written until
 * the user confirms, and every skipped row is explained.
 */
export class ImportModal extends Modal {
	private source: ImportSource;
	private delimiter: CsvDelimiter;
	private decimal: DecimalFormat;
	private hasHeader = true;
	private merge: boolean;
	private insertEmbed = true;
	private replace = false;
	private name: string;
	private table: RawTable = { headers: [], rows: [] };
	private mapping: ColumnMapping = { source: -1, target: -1, value: -1, label: -1 };
	private result: ImportResult = { rows: [], problems: [] };
	private parseError: string | null = null;

	private mappingEl!: HTMLElement;
	private rawEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private submitButton!: ButtonComponent;
	private preview: SankeyRenderer | null = null;
	private headerToggle: ToggleComponent | null = null;

	constructor(
		private readonly plugin: SankeyFlowPlugin,
		private readonly options: ImportModalOptions,
	) {
		super(plugin.app);
		this.source = options.source;
		this.delimiter = plugin.settings.csvDelimiter;
		this.decimal = plugin.settings.decimalFormat;
		this.merge = plugin.settings.mergeDuplicateFlows;
		this.name = options.source.name;
	}

	onOpen(): void {
		this.modalEl.addClass("sankey-flow-import-modal");
		const isCsv = this.source.kind === "csv";
		this.setTitle(
			this.options.target === "into" ? "Import data into diagram" : isCsv ? "Create diagram from CSV" : "Create diagram from table",
		);
		const el = this.contentEl;

		if (isCsv) {
			const drop = el.createDiv({ cls: "sankey-flow-dropzone", text: "Drop a different CSV file here to replace the data." });
			this.bindDrop(drop);
			new Setting(el)
				.setName("Delimiter")
				.addDropdown((d) =>
					d
						.addOptions({ auto: "Detect automatically", ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" })
						.setValue(this.delimiter)
						.onChange((v) => {
							this.delimiter = v as CsvDelimiter;
							this.reparse(true);
						}),
				);
			new Setting(el)
				.setName("First row contains column names")
				.addToggle((t) => {
					this.headerToggle = t;
					t.setValue(this.hasHeader).onChange((v) => {
						if (v === this.hasHeader) return;
						this.hasHeader = v;
						this.reparse(false);
					});
				});
		}

		this.mappingEl = el.createDiv();
		new Setting(el)
			.setName("Number format")
			.setDesc("How decimals are written in the Value column.")
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Detect automatically", dot: "1,234.5 (dot decimal)", comma: "1.234,5 (comma decimal)" })
					.setValue(this.decimal)
					.onChange((v) => {
						this.decimal = v as DecimalFormat;
						this.recompute();
					}),
			);
		new Setting(el)
			.setName("Combine duplicate flows")
			.setDesc("Rows with the same source and target are added together.")
			.addToggle((t) =>
				t.setValue(this.merge).onChange((v) => {
					this.merge = v;
					this.recompute();
				}),
			);

		const grid = el.createDiv("sankey-flow-import-grid");
		this.rawEl = grid.createDiv("sankey-flow-raw-table");
		this.previewEl = grid.createDiv("sankey-flow-import-preview");
		this.summaryEl = el.createDiv("sankey-flow-import-summary");

		if (this.options.target === "new") {
			new Setting(el).setName("Diagram name").addText((t) =>
				t.setValue(this.name).onChange((v) => {
					this.name = v;
					this.updateSubmit();
				}),
			);
			if (this.source.kind === "table") {
				new Setting(el)
					.setName("Embed below the table")
					.setDesc("Adds a link that embeds the new diagram right after the table in this note.")
					.addToggle((t) => t.setValue(this.insertEmbed).onChange((v) => (this.insertEmbed = v)));
			}
		} else {
			new Setting(el)
				.setName("Replace existing flows")
				.setDesc("Off: imported flows are added to the diagram. On: they replace all current nodes and flows.")
				.addToggle((t) => t.setValue(this.replace).onChange((v) => (this.replace = v)));
		}

		const buttons = el.createDiv("sankey-flow-modal-buttons");
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		this.submitButton = new ButtonComponent(buttons)
			.setButtonText(this.options.target === "into" ? "Import" : "Create diagram")
			.setCta()
			.onClick(() => void this.submit());

		this.preview = new SankeyRenderer(this.previewEl, {}, { editable: false, ariaLabel: "Import preview", linkHint: "" });
		this.reparse(true);
	}

	onClose(): void {
		this.preview?.destroy();
		this.preview = null;
		this.contentEl.empty();
	}

	private bindDrop(zone: HTMLElement): void {
		const over = (e: DragEvent) => {
			e.preventDefault();
			zone.addClass("is-over");
		};
		zone.addEventListener("dragenter", over);
		zone.addEventListener("dragover", over);
		zone.addEventListener("dragleave", () => zone.removeClass("is-over"));
		zone.addEventListener("drop", (e) => {
			e.preventDefault();
			zone.removeClass("is-over");
			const file = e.dataTransfer?.files?.[0];
			if (!file) return;
			void file.text().then((text) => {
				this.source = { kind: "csv", text, name: file.name.replace(/\.[^.]+$/, "") };
				this.reparse(true);
			});
		});
	}

	/** Re-reads the source. `guess` also re-detects header and column mapping. */
	private reparse(guess: boolean): void {
		this.parseError = null;
		try {
			if (this.source.kind === "csv") {
				const { rows } = parseCsv(this.source.text, this.delimiter);
				if (!rows.length) throw new CsvError("The file is empty.");
				if (guess) {
					this.hasHeader = firstRowLooksLikeHeader(rows);
					this.headerToggle?.setValue(this.hasHeader);
				}
				this.table = tableFromRows(rows, this.hasHeader);
			} else {
				this.table = this.source.table;
			}
			if (this.table.headers.length < 3) {
				throw new CsvError(`Found ${this.table.headers.length} column(s); a Sankey import needs at least three (source, target and value).`);
			}
		} catch (e) {
			this.parseError = `Could not read the data: ${errorMessage(e)}`;
			this.table = { headers: [], rows: [] };
		}
		if (guess || this.mapping.source >= this.table.headers.length) {
			const s = this.plugin.settings;
			this.mapping = guessMapping(this.table, {
				source: [...splitNames(s.sourceColumnNames), ...DEFAULT_SYNONYMS.source],
				target: [...splitNames(s.targetColumnNames), ...DEFAULT_SYNONYMS.target],
				value: [...splitNames(s.valueColumnNames), ...DEFAULT_SYNONYMS.value],
				label: DEFAULT_SYNONYMS.label,
			});
		}
		this.renderMapping();
		this.recompute();
	}

	private renderMapping(): void {
		this.mappingEl.empty();
		if (!this.table.headers.length) return;
		const options: Record<string, string> = {};
		this.table.headers.forEach((h, i) => (options[String(i)] = h));
		const role = (name: string, desc: string, key: keyof ColumnMapping, optional = false) => {
			new Setting(this.mappingEl)
				.setName(name)
				.setDesc(desc)
				.addDropdown((d: DropdownComponent) => {
					if (optional) d.addOption("-1", "None");
					else if (this.mapping[key] < 0) d.addOption("-1", "Choose a column…");
					d.addOptions(options)
						.setValue(String(this.mapping[key]))
						.onChange((v) => {
							this.mapping = { ...this.mapping, [key]: Number(v) };
							this.recompute();
						});
				});
		};
		role("Source column", "Where each flow starts.", "source");
		role("Target column", "Where each flow ends.", "target");
		role("Value column", "The size of each flow (numbers).", "value");
		role("Label column", "Optional text shown in flow tooltips.", "label", true);
	}

	private recompute(): void {
		this.result = this.table.headers.length ? buildRows(this.table, this.mapping, { decimal: this.decimal }) : { rows: [], problems: [] };
		this.renderRaw();
		this.renderSummary();
		this.renderPreview();
		this.updateSubmit();
	}

	private renderRaw(): void {
		this.rawEl.empty();
		if (!this.table.headers.length) return;
		const table = this.rawEl.createEl("table");
		const head = table.createTHead().insertRow();
		this.table.headers.forEach((h, i) => {
			const th = head.createEl("th", { text: h });
			if (i === this.mapping.source) th.addClass("is-source");
			if (i === this.mapping.target) th.addClass("is-target");
			if (i === this.mapping.value) th.addClass("is-value");
			const role = i === this.mapping.source ? "source" : i === this.mapping.target ? "target" : i === this.mapping.value ? "value" : "";
			if (role) th.setAttr("title", `Used as ${role}`);
		});
		const body = table.createTBody();
		for (const row of this.table.rows.slice(0, PREVIEW_ROWS)) {
			const tr = body.insertRow();
			row.forEach((cell) => tr.insertCell().setText(cell));
		}
		if (this.table.rows.length > PREVIEW_ROWS) {
			const tr = body.insertRow();
			const td = tr.insertCell();
			td.colSpan = this.table.headers.length;
			td.setText(`… ${this.table.rows.length - PREVIEW_ROWS} more rows`);
		}
	}

	private renderSummary(): void {
		const el = this.summaryEl;
		el.empty();
		el.removeClass("is-error");
		if (this.parseError) {
			el.addClass("is-error");
			el.setText(this.parseError);
			return;
		}
		const { rows, problems } = this.result;
		const nodes = new Set(rows.flatMap((r) => [r.source.label, r.target.label])).size;
		const problem = summarizeProblems(this.result, this.table, this.mapping);
		if (!rows.length) {
			el.addClass("is-error");
			el.setText(problem ? `Cannot import: ${problem}` : "No rows to import.");
		} else {
			el.setText(`${rows.length} flow${rows.length === 1 ? "" : "s"} between ${nodes} nodes from ${this.table.rows.length} rows.`);
			const skipped = problems.filter((p) => p.rowNumber > 0);
			if (skipped.length) {
				el.createDiv({ text: `${skipped.length} row${skipped.length === 1 ? "" : "s"} will be skipped:` });
				const ul = el.createEl("ul");
				for (const p of skipped.slice(0, 5)) ul.createEl("li", { text: p.message });
				if (skipped.length > 5) ul.createEl("li", { text: `… and ${skipped.length - 5} more` });
			}
		}
	}

	private renderPreview(): void {
		if (!this.preview) return;
		const doc = documentFromRows(this.name, this.result.rows, this.merge);
		this.preview.setData(doc, this.plugin.renderConfig(doc, "embed"), false);
	}

	private updateSubmit(): void {
		const ok = !this.parseError && this.result.rows.length > 0 && (this.options.target === "into" || this.name.trim().length > 0);
		this.submitButton.setDisabled(!ok);
	}

	private async submit(): Promise<void> {
		if (!this.result.rows.length) return;
		this.submitButton.setDisabled(true);
		try {
			await this.options.onSubmit({
				rows: this.result.rows,
				name: this.name.trim(),
				merge: this.merge,
				insertEmbed: this.insertEmbed,
				replace: this.replace,
			});
			this.close();
		} catch (e) {
			this.plugin.reportError("Import failed", e);
			this.submitButton.setDisabled(false);
		}
	}
}
