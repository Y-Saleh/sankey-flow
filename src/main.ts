import { Events, MarkdownView, Notice, Plugin, TFile, addIcon, debounce, type Editor, type PaneType, type WorkspaceLeaf } from "obsidian";
import { ICON_ID, ICON_SVG, PLUGIN_NAME, VIEW_TYPE_EDITOR, VIEW_TYPE_MANAGER } from "./constants";
import { DEFAULT_SETTINGS, mergeSettings, type SankeySettings } from "./settings/settings";
import { SankeySettingsTab } from "./settings/SettingsTab";
import { createEmptyDocument, type SankeyDocument } from "./model/schema";
import { Logger, errorMessage } from "./util/logger";
import { DiagramStore } from "./storage/DiagramStore";
import { Exporter } from "./export/exporter";
import { SankeyEditorView } from "./editor/SankeyEditorView";
import { DiagramManagerView } from "./manager/ManagerView";
import { registerCodeBlocks } from "./embed/SankeyBlock";
import { registerCommands, tableAtCursor } from "./commands";
import { HOVER_SOURCE, copyText } from "./obsidian/links";
import { resolveRenderConfig, type RenderConfig, type RenderContext } from "./render/config";
import type { BlockOptions } from "./data/blockSyntax";
import { referenceBlock } from "./data/blockSyntax";
import { appendRows, type ImportRow } from "./data/tableImport";
import { findTableAt } from "./data/markdownTable";
import { ImportModal } from "./modals/ImportModal";
import { promptText } from "./modals/basic";

export default class SankeyFlowPlugin extends Plugin {
	settings: SankeySettings = { ...DEFAULT_SETTINGS };
	readonly logger = new Logger(() => this.settings.debugLogging);
	/** Plugin-wide events: "settings-changed", "dataview-changed", "refresh". */
	readonly events = new Events();
	store!: DiagramStore;
	exporter!: Exporter;
	private ribbonEl: HTMLElement | null = null;
	/** Leaves where the user chose to see a diagram note as Markdown (leaf → file path). */
	private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new DiagramStore(this.app, () => this.settings.diagramFolder, this.logger);
		this.exporter = new Exporter(this);

		addIcon(ICON_ID, ICON_SVG);
		this.registerView(VIEW_TYPE_EDITOR, (leaf) => new SankeyEditorView(leaf, this));
		this.registerView(VIEW_TYPE_MANAGER, (leaf) => new DiagramManagerView(leaf, this));
		registerCodeBlocks(this);
		this.registerHoverLinkSource(HOVER_SOURCE, { display: PLUGIN_NAME, defaultMod: true });
		registerCommands(this);
		this.addSettingTab(new SankeySettingsTab(this.app, this));
		this.updateRibbon();
		this.registerWorkspaceEvents();
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			this.registerDataviewEvents();
		});
		this.logger.debug("Loaded");
	}

	// ── Settings ─────────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.events.trigger("settings-changed");
	}

	/** Settings changed on disk (e.g. by Obsidian Sync). */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.updateRibbon();
		this.events.trigger("settings-changed");
	}

	isDark(): boolean {
		return document.body.classList.contains("theme-dark");
	}

	renderConfig(doc: SankeyDocument, context: RenderContext, block?: BlockOptions): RenderConfig {
		return resolveRenderConfig(this.settings, doc, context, this.isDark(), block);
	}

	reportError(message: string, error: unknown): void {
		this.logger.error(message, error);
		new Notice(`${message}: ${errorMessage(error)}`, 8000);
	}

	updateRibbon(): void {
		if (this.settings.showRibbonIcon && !this.ribbonEl) {
			this.ribbonEl = this.addRibbonIcon(ICON_ID, "Sankey diagrams", () => void this.activateManager());
		} else if (!this.settings.showRibbonIcon && this.ribbonEl) {
			this.ribbonEl.detach();
			this.ribbonEl = null;
		}
	}

	// ── Event wiring ─────────────────────────────────────────────────────

	private registerWorkspaceEvents(): void {
		const { workspace } = this.app;

		// Diagram notes open in the Sankey editor, unless the user asked to see them as Markdown in that tab.
		// Checked when a file opens and when a tab becomes active (covers tabs opened in the background).
		const switchActiveToEditor = () => {
			if (!this.settings.openDiagramsInEditor) return;
			const view = workspace.getActiveViewOfType(MarkdownView);
			const file = view?.file;
			if (!view || !file) return;
			if (this.markdownLeaves.get(view.leaf) === file.path) return;
			if (!this.store.isDiagramFile(file)) return;
			void view.leaf.setViewState({ type: VIEW_TYPE_EDITOR, state: { file: file.path }, active: true });
		};
		this.registerEvent(workspace.on("file-open", switchActiveToEditor));
		this.registerEvent(workspace.on("active-leaf-change", switchActiveToEditor));

		this.registerEvent(
			workspace.on("file-menu", (menu, file, source) => {
				if (!(file instanceof TFile) || source === "sankey-flow-manager") return;
				if (this.store.isDiagramFile(file)) {
					menu.addItem((i) => i.setSection("open").setTitle("Open in diagram editor").setIcon(ICON_ID).onClick(() => void this.openDiagram(file, false)));
					menu.addItem((i) => i.setSection("action").setTitle("Copy diagram embed link").setIcon("link").onClick(() => void this.copyEmbedCode(file)));
				} else if (["csv", "tsv"].includes(file.extension.toLowerCase())) {
					menu.addItem((i) =>
						i
							.setSection("action")
							.setTitle("Create diagram from CSV")
							.setIcon(ICON_ID)
							.onClick(async () => this.createFromCsv(await this.app.vault.cachedRead(file), file.basename)),
					);
				}
			}),
		);

		this.registerEvent(
			workspace.on("editor-menu", (menu, editor) => {
				if (!findTableAt(editor.getValue().split("\n"), editor.getCursor().line)) return;
				menu.addItem((i) => i.setSection("insert").setTitle("Create diagram from table").setIcon(ICON_ID).onClick(() => this.createFromTable(editor)));
			}),
		);
	}

	private registerVaultEvents(): void {
		const { vault, metadataCache } = this.app;
		this.registerEvent(metadataCache.on("changed", (file, data, cache) => this.store.indexFile(file, data, cache)));
		this.registerEvent(vault.on("delete", (file) => this.store.forgetFile(file.path)));
		this.registerEvent(
			vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				this.store.onFileRenamed(file, oldPath);
				if (!this.settings.updateLinksOnRename) return;
				// Let Obsidian finish its own link updates first; ours only touch links that are still broken.
				window.setTimeout(() => void this.afterRename(file, oldPath), 1000);
			}),
		);
	}

	private registerDataviewEvents(): void {
		const notify = debounce(() => this.events.trigger("dataview-changed"), 1000, true);
		const cache = this.app.metadataCache as unknown as Events;
		this.registerEvent(cache.on("dataview:index-ready", notify));
		this.registerEvent(cache.on("dataview:metadata-change", notify));
	}

	private async afterRename(file: TFile, oldPath: string): Promise<void> {
		const oldNoExt = oldPath.replace(/\.md$/i, "");
		const oldBase = oldNoExt.split("/").pop() ?? oldNoExt;
		const { resolvedLinks, unresolvedLinks } = this.app.metadataCache;
		let relinked = 0;
		for (const diagram of this.store.listDiagrams()) {
			if (diagram === file) continue;
			const unresolved = unresolvedLinks[diagram.path] ?? {};
			const candidate = resolvedLinks[diagram.path]?.[file.path] || unresolved[oldNoExt] || unresolved[oldBase] || unresolved[oldPath];
			if (!candidate) continue;
			try {
				const open = this.app.workspace.getLeavesOfType(VIEW_TYPE_EDITOR).map((l) => l.view as SankeyEditorView).find((v) => v.diagramFile === diagram && !v.hasLoadError);
				const doc = open ? open.controller.doc : (await this.store.read(diagram)).doc;
				const next = this.store.relinkAfterRename(doc, diagram.path, file, oldPath);
				if (!next) continue;
				if (open) open.applyExternalUpdate("Update links after rename", next);
				else await this.store.write(diagram, next);
				relinked++;
			} catch (e) {
				this.logger.debug(`Could not update links in ${diagram.path}`, e);
			}
		}
		if (this.store.isDiagramFile(file)) {
			const updated = await this.store.updateBlockReferences(file, oldPath);
			if (updated) this.logger.debug(`Updated ${updated} code block reference(s) to ${file.path}`);
		}
		if (relinked) this.logger.debug(`Updated links in ${relinked} diagram(s) after renaming ${oldPath}`);
	}

	// ── Opening and creating diagrams ────────────────────────────────────

	async openDiagram(file: TFile, newLeaf: PaneType | boolean = false): Promise<void> {
		const { workspace } = this.app;
		if (!newLeaf) {
			const existing = workspace.getLeavesOfType(VIEW_TYPE_EDITOR).find((l) => (l.view as SankeyEditorView).diagramFile === file);
			if (existing) {
				workspace.setActiveLeaf(existing, { focus: true });
				return;
			}
		}
		const leaf = workspace.getLeaf(newLeaf);
		this.markdownLeaves.delete(leaf);
		await leaf.setViewState({ type: VIEW_TYPE_EDITOR, state: { file: file.path }, active: true });
	}

	async openAsMarkdown(leaf: WorkspaceLeaf): Promise<void> {
		const view = leaf.view;
		const file = view instanceof SankeyEditorView ? view.diagramFile : null;
		if (!file) return;
		if (view instanceof SankeyEditorView) await view.saveNow();
		this.markdownLeaves.set(leaf, file.path);
		await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source", source: false }, active: true });
	}

	async activateManager(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_MANAGER)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_MANAGER, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	newDocument(title: string): SankeyDocument {
		const doc = createEmptyDocument(title);
		doc.layout.align = this.settings.defaultAlign;
		doc.layout.iterations = this.settings.layoutIterations;
		return doc;
	}

	async createDiagramInteractive(): Promise<void> {
		const name = await promptText(this.app, {
			title: "New Sankey diagram",
			placeholder: "Energy flow",
			description: `The diagram is saved as a note in “${this.settings.diagramFolder}”.`,
		});
		if (!name) return;
		try {
			const file = await this.store.create(name, this.newDocument(name));
			await this.openDiagram(file, "tab");
		} catch (e) {
			this.reportError("Could not create the diagram", e);
		}
	}

	createFromCsv(text: string, name: string): void {
		new ImportModal(this, {
			source: { kind: "csv", text, name },
			target: "new",
			onSubmit: async ({ rows, name: title, merge }) => {
				const file = await this.createFromRows(title, rows, merge);
				await this.openDiagram(file, "tab");
			},
		}).open();
	}

	createFromTable(editor: Editor): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		let found;
		try {
			found = tableAtCursor(editor);
		} catch (e) {
			new Notice(`Could not read the table: ${errorMessage(e)}`);
			return;
		}
		if (!found) {
			new Notice("No table found here. Click inside a Markdown table, including the separator row below its header, and try again.");
			return;
		}
		const sourcePath = view?.file?.path ?? "";
		const headerLine = editor.getLine(found.loc.start);
		new ImportModal(this, {
			source: { kind: "table", table: found.table, name: this.suggestTableName(editor, found.loc.start) },
			target: "new",
			onSubmit: async ({ rows, name, merge, insertEmbed }) => {
				const file = await this.createFromRows(name, rows, merge);
				if (!insertEmbed) {
					await this.openDiagram(file, "tab");
					return;
				}
				// Re-locate the table: the note may have been edited while the dialog was open.
				const lines = editor.getValue().split("\n");
				let start = found.loc.start;
				if (lines[start] !== headerLine) start = lines.indexOf(headerLine);
				const loc = start >= 0 ? findTableAt(lines, start) : null;
				const embed = this.embedCode(file, sourcePath);
				if (loc) editor.replaceRange(`\n\n${embed}`, { line: loc.end, ch: lines[loc.end].length });
				else editor.replaceSelection(`${embed}\n`);
				new Notice(`Created ${file.path}`);
			},
		}).open();
	}

	private suggestTableName(editor: Editor, line: number): string {
		for (let i = line - 1; i >= 0; i--) {
			const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(editor.getLine(i));
			if (heading) return heading[1];
		}
		return `${this.app.workspace.getActiveFile()?.basename ?? "Table"} flows`;
	}

	private async createFromRows(name: string, rows: readonly ImportRow[], merge: boolean): Promise<TFile> {
		const doc = this.newDocument(name);
		appendRows(doc, rows, merge);
		return this.store.create(name, doc);
	}

	/** The text that embeds a diagram in a note, following the user's link format setting. */
	embedCode(file: TFile, sourcePath: string): string {
		if (this.settings.insertStyle === "codeblock") {
			return referenceBlock(this.app.metadataCache.fileToLinktext(file, sourcePath, true));
		}
		return `!${this.app.fileManager.generateMarkdownLink(file, sourcePath)}`;
	}

	async copyEmbedCode(file: TFile): Promise<void> {
		await copyText(this.embedCode(file, ""));
	}
}
