import {
	Keymap,
	MarkdownRenderChild,
	MarkdownPreviewRenderer,
	Menu,
	Notice,
	TFile,
	setIcon,
	setTooltip,
	type HoverPopover,
	type MarkdownPostProcessorContext,
} from "obsidian";
import type SankeyFlowPlugin from "../main";
import { parseBlock, type BlockOptions, type BlockSpec } from "../data/blockSyntax";
import { DataviewSource } from "../data/dataview";
import { StaticSource, type SankeyDataSource, type SankeyLoadResult } from "../data/sources";
import type { SankeyDocument } from "../model/schema";
import { parseDocument, SankeyFormatError, type ValidationIssue } from "../model/validate";
import { flowById, nodeById } from "../model/operations";
import { isDiagramFrontmatter } from "../storage/diagramFile";
import { SankeyRenderer, type HitTarget } from "../render/SankeyRenderer";
import { addLinkMenuItems, openLink, paneTypeFor, triggerHoverPreview } from "../obsidian/links";
import { promptText } from "../modals/basic";
import type { ExportFormat } from "../export/exporter";
import { errorMessage } from "../util/logger";

export const BLOCK_LANGUAGES = ["sankey", "sankey-flow"] as const;

/**
 * Registers the `sankey` code block (and the `sankey-flow` alias). If another
 * plugin already owns a language name, that name is skipped rather than
 * fighting over it.
 */
export function registerCodeBlocks(plugin: SankeyFlowPlugin): void {
	const registry = (MarkdownPreviewRenderer as unknown as { codeBlockPostProcessors?: Record<string, unknown> }).codeBlockPostProcessors;
	for (const language of BLOCK_LANGUAGES) {
		if (registry && Object.prototype.hasOwnProperty.call(registry, language)) {
			plugin.logger.error(`The "${language}" code block is already handled by another plugin; Sankey Flow will not register it.`);
			continue;
		}
		try {
			plugin.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
				ctx.addChild(new SankeyBlock(plugin, el, source, ctx));
			});
		} catch (e) {
			plugin.logger.error(`Could not register the "${language}" code block`, e);
		}
	}
}

/** Loads the diagram file a `diagram:` reference points at, and reloads when it changes. */
class DiagramFileSource implements SankeyDataSource {
	readonly label = "Diagram file";

	constructor(
		private readonly plugin: SankeyFlowPlugin,
		readonly file: TFile,
	) {}

	async load(): Promise<SankeyLoadResult> {
		return this.plugin.store.read(this.file);
	}

	watch(onChange: () => void): () => void {
		const { vault } = this.plugin.app;
		const refs = [
			vault.on("modify", (f) => f === this.file && onChange()),
			vault.on("delete", (f) => f === this.file && onChange()),
		];
		return () => refs.forEach((r) => vault.offref(r));
	}
}

/**
 * One rendered `sankey` code block. Lives as long as the rendered section and
 * cleans up its renderer and listeners when Obsidian unloads it.
 */
export class SankeyBlock extends MarkdownRenderChild {
	hoverPopover: HoverPopover | null = null;
	private spec: BlockSpec;
	private source: SankeyDataSource | null = null;
	private stopWatching: (() => void) | null = null;
	private renderer: SankeyRenderer | null = null;
	private doc: SankeyDocument | null = null;
	private issues: ValidationIssue[] = [];
	private file: TFile | null = null;
	/** True when this block is the data block of the diagram note being shown. */
	private isOwnData = false;
	private bodyEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private issuesEl: HTMLElement | null = null;
	private reloadTimer: number | null = null;

	constructor(
		private readonly plugin: SankeyFlowPlugin,
		containerEl: HTMLElement,
		text: string,
		private readonly ctx: MarkdownPostProcessorContext,
	) {
		super(containerEl);
		this.spec = parseBlock(text);
	}

	onload(): void {
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.draw(false)));
		this.registerEvent(this.plugin.app.workspace.on("css-change", () => this.draw(false)));
		void this.setup();
	}

	onunload(): void {
		this.stopWatching?.();
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.renderer?.destroy();
		this.renderer = null;
	}

	private get options(): BlockOptions {
		return this.spec.options;
	}

	private async setup(): Promise<void> {
		const spec = this.spec;
		const sourcePath = this.ctx.sourcePath;
		try {
			switch (spec.kind) {
				case "empty":
					this.showError("Empty Sankey diagram", spec.issues.map((i) => i.message).join(" ") || "Write flows like `Coal -> Electricity: 50`, or `diagram: [[My diagram]]`.");
					return;
				case "json": {
					const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
					this.isOwnData = isDiagramFrontmatter(this.ctx.frontmatter) || (sourceFile instanceof TFile && this.plugin.store.isDiagramFile(sourceFile));
					if (this.isOwnData && sourceFile instanceof TFile) this.file = sourceFile;
					const parsed = parseDocument(spec.json);
					this.source = new StaticSource("Diagram data", { doc: parsed.doc, issues: parsed.issues });
					break;
				}
				case "inline":
					this.source = new StaticSource("Inline flows", { doc: spec.doc, issues: spec.issues });
					break;
				case "reference": {
					const file = this.plugin.store.resolve(spec.target, sourcePath);
					if (!file) {
						this.showError("Diagram not found", `Could not find "${spec.target}". Check the name, or create the diagram first.`);
						return;
					}
					this.file = file;
					this.source = new DiagramFileSource(this.plugin, file);
					break;
				}
				case "dataview": {
					if (!this.plugin.settings.enableDataview) {
						this.showError("Dataview integration is off", "Turn on “Dataview queries” in Sankey Flow settings to use `query:` blocks.");
						return;
					}
					this.source = new DataviewSource(
						this.plugin.app,
						spec.query,
						spec.columns,
						sourcePath,
						this.plugin.settings.decimalFormat,
						(cb) => {
							const ref = this.plugin.events.on("dataview-changed", cb);
							return () => this.plugin.events.offref(ref);
						},
					);
					break;
				}
			}
		} catch (e) {
			this.showError(
				e instanceof SankeyFormatError && e.kind === "newer-version" ? "Newer diagram format" : "Could not read this diagram",
				errorMessage(e),
			);
			return;
		}
		this.stopWatching = this.source?.watch?.(() => this.scheduleReload()) ?? null;
		await this.reload();
	}

	private scheduleReload(): void {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, 150);
	}

	private async reload(): Promise<void> {
		if (!this.source) return;
		try {
			if (this.file && !this.plugin.app.vault.getAbstractFileByPath(this.file.path)) {
				this.showError("Diagram not found", `"${this.file.path}" was deleted or moved.`);
				return;
			}
			const result = await this.source.load();
			this.doc = result.doc;
			this.issues = [...this.spec.issues, ...result.issues];
			this.draw(true);
		} catch (e) {
			this.plugin.logger.debug("Embed failed to load", e);
			this.showError("Could not load this diagram", errorMessage(e));
		}
	}

	private title(): string {
		if (this.options.title === false) return "";
		if (typeof this.options.title === "string" && this.options.title) return this.options.title;
		return this.doc?.meta.title || (this.file ? this.file.basename : "");
	}

	private height(): number {
		return this.options.height ?? this.doc?.display.height ?? this.plugin.settings.embedHeight;
	}

	/** Builds the frame once, then only feeds new data to the renderer. */
	private draw(animate: boolean): void {
		const doc = this.doc;
		if (!doc) return;
		if (!this.renderer) this.buildFrame();
		if (this.titleEl) {
			const title = this.title();
			this.titleEl.setText(title);
			this.titleEl.toggle(!!title);
		}
		this.bodyEl?.setCssProps({ "--sankey-flow-embed-height": `${this.height()}px` });
		this.renderer?.setData(doc, this.plugin.renderConfig(doc, "embed", this.options), animate);
		this.renderIssues();
	}

	private buildFrame(): void {
		const el = this.containerEl;
		el.empty();
		const frame = el.createDiv("sankey-flow-embed");
		const header = frame.createDiv("sankey-flow-embed-header");
		this.titleEl = header.createDiv("sankey-flow-embed-title");
		const actions = header.createDiv("sankey-flow-embed-actions");
		const action = (icon: string, label: string, onClick: (evt: MouseEvent) => void) => {
			const btn = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": label, role: "button", tabindex: "0" } });
			setIcon(btn, icon);
			setTooltip(btn, label);
			btn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				onClick(evt);
			});
			btn.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					const r = btn.getBoundingClientRect();
					onClick(new MouseEvent("click", { clientX: r.left, clientY: r.bottom }));
				}
			});
		};
		if (this.file) action("pencil", "Edit diagram", (evt) => this.openEditor(evt));
		else if (this.spec.kind === "inline" || this.spec.kind === "json") action("file-plus", "Save as diagram file", () => void this.convertToFile());
		action("scan", "Fit to view", () => this.renderer?.fitView());
		action("more-horizontal", "More", (evt) => this.backgroundMenu(evt));

		this.bodyEl = frame.createDiv("sankey-flow-embed-body");
		this.issuesEl = frame.createDiv();
		this.renderer = new SankeyRenderer(
			this.bodyEl,
			{
				onClick: (target, evt) => this.onClick(target, evt),
				onDoubleClick: (target, evt) => {
					if (target.kind !== "background" && this.file) this.openEditor(evt);
				},
				onContextMenu: (target, evt) => (target.kind === "background" ? this.backgroundMenu(evt) : this.itemMenu(target, evt)),
				onHoverLink: (target, evt, targetEl) => {
					const link = this.linkOf(target);
					if (link) triggerHoverPreview(this.plugin.app, evt, targetEl as HTMLElement, link, this.ctx.sourcePath, this);
				},
				onActivate: (target, evt) => {
					const link = this.linkOf(target);
					if (link) void openLink(this.plugin.app, link, this.ctx.sourcePath, paneTypeFor(evt));
				},
			},
			{
				editable: false,
				ariaLabel: "Sankey diagram",
				linkHint: this.plugin.settings.embedClick === "open-link" ? "Click to open" : "Right-click for options",
			},
		);
		// Keep clicks inside the diagram from moving the Live Preview cursor into the code block.
		this.bodyEl.addEventListener("mousedown", (e) => e.stopPropagation());
	}

	private linkOf(target: HitTarget): string | null {
		const doc = this.doc;
		if (!doc || target.kind === "background") return null;
		const item = target.kind === "node" ? nodeById(doc, target.id) : flowById(doc, target.id);
		return item?.link ?? null;
	}

	private onClick(target: HitTarget, evt: MouseEvent): void {
		const link = this.linkOf(target);
		if (!link) return;
		if (this.plugin.settings.embedClick === "open-link" || Keymap.isModEvent(evt)) {
			void openLink(this.plugin.app, link, this.ctx.sourcePath, paneTypeFor(evt));
		}
	}

	private openEditor(evt: MouseEvent): void {
		if (!this.file) return;
		void this.plugin.openDiagram(this.file, this.isOwnData ? false : paneTypeFor(evt));
	}

	private itemMenu(target: HitTarget, evt: MouseEvent): void {
		const menu = new Menu();
		const link = this.linkOf(target);
		if (link) addLinkMenuItems(menu, this.plugin.app, link, this.ctx.sourcePath);
		if (this.file) menu.addItem((i) => i.setSection("diagram").setTitle("Edit diagram").setIcon("pencil").onClick(() => this.openEditor(evt)));
		if (!link && !this.file) return this.backgroundMenu(evt);
		menu.showAtMouseEvent(evt);
	}

	private backgroundMenu(evt: MouseEvent): void {
		const menu = new Menu();
		if (this.file) {
			const file = this.file;
			menu.addItem((i) => i.setSection("diagram").setTitle("Edit diagram").setIcon("pencil").onClick(() => this.openEditor(evt)));
			menu.addItem((i) => i.setSection("diagram").setTitle("Open in new tab").setIcon("file-plus-2").onClick(() => void this.plugin.openDiagram(file, "tab")));
		} else if (this.spec.kind === "inline" || this.spec.kind === "json") {
			menu.addItem((i) => i.setSection("diagram").setTitle("Save as diagram file…").setIcon("file-plus").onClick(() => void this.convertToFile()));
		}
		menu.addItem((i) => i.setSection("view").setTitle("Fit to view").setIcon("scan").onClick(() => this.renderer?.fitView()));
		menu.addItem((i) => i.setSection("view").setTitle("Refresh").setIcon("refresh-cw").onClick(() => void this.reload()));
		const formats: [ExportFormat, string][] = [
			["svg", "Export as SVG"],
			["png", "Export as PNG"],
			["csv", "Export flows as CSV"],
			["json", "Export diagram data (JSON)"],
		];
		for (const [format, title] of formats) {
			menu.addItem((i) => i.setSection("export").setTitle(title).setIcon("download").onClick(() => void this.export(format)));
		}
		menu.showAtMouseEvent(evt);
	}

	async export(format: ExportFormat): Promise<void> {
		if (!this.doc || !this.renderer) return;
		await this.plugin.exporter.export(format, {
			renderer: this.renderer,
			doc: this.doc,
			name: this.title() || "Sankey diagram",
			sourcePath: this.ctx.sourcePath,
		});
	}

	/** Moves inline data into its own diagram note and replaces this block with an embed. */
	private async convertToFile(): Promise<void> {
		const doc = this.doc;
		const note = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!doc || !(note instanceof TFile)) return;
		const name = await promptText(this.plugin.app, {
			title: "Save as diagram file",
			value: this.title() || "Sankey diagram",
			cta: "Save",
			description: "The diagram gets its own note that you can edit visually, and this code block is replaced by an embed.",
		});
		if (!name) return;
		const section = this.ctx.getSectionInfo(this.containerEl);
		try {
			const copy = structuredClone(doc);
			copy.meta.title = name;
			const file = await this.plugin.store.create(name, copy);
			const embed = this.plugin.embedCode(file, note.path);
			let replaced = false;
			if (section) {
				const expected = section.text.split("\n").slice(section.lineStart, section.lineEnd + 1).join("\n");
				await this.plugin.app.vault.process(note, (text) => {
					const lines = text.split("\n");
					const current = lines.slice(section.lineStart, section.lineEnd + 1).join("\n");
					if (current !== expected) return text;
					lines.splice(section.lineStart, section.lineEnd - section.lineStart + 1, embed);
					replaced = true;
					return lines.join("\n");
				});
			}
			new Notice(replaced ? `Created ${file.path}.` : `Created ${file.path}. The note changed meanwhile, so the code block was left as is.`);
		} catch (e) {
			this.plugin.reportError("Could not create the diagram file", e);
		}
	}

	private renderIssues(): void {
		const el = this.issuesEl;
		if (!el) return;
		el.empty();
		el.removeClass("sankey-flow-issues");
		if (!this.issues.length) return;
		el.addClass("sankey-flow-issues");
		const details = el.createEl("details");
		details.createEl("summary", { text: `${this.issues.length} problem${this.issues.length === 1 ? "" : "s"} in this diagram's data` });
		const list = details.createEl("ul");
		for (const issue of this.issues.slice(0, 20)) list.createEl("li", { text: issue.message, cls: issue.level === "error" ? "is-error" : "" });
	}

	private showError(title: string, detail: string): void {
		this.renderer?.destroy();
		this.renderer = null;
		const el = this.containerEl;
		el.empty();
		const box = el.createDiv("sankey-flow-error");
		box.createDiv({ cls: "sankey-flow-error-title", text: title });
		box.createDiv({ cls: "sankey-flow-error-detail", text: detail });
	}
}
