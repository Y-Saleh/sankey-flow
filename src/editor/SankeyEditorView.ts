import {
	ButtonComponent,
	Keymap,
	Menu,
	Notice,
	Platform,
	Scope,
	TextFileView,
	TFile,
	setIcon,
	setTooltip,
	type HoverPopover,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import type SankeyFlowPlugin from "../main";
import { ICON_ID, VIEW_TYPE_EDITOR } from "../constants";
import { createEmptyDocument, type Alignment, type SankeyDocument } from "../model/schema";
import { SankeyFormatError, type ValidationIssue } from "../model/validate";
import { addFlow, addNode, clearPositions, duplicateFlow, flowById, nextNodeLabel, nodeById, nodeTotals, removeFlow, removeNode, updateFlow, updateNode } from "../model/operations";
import { appendRows } from "../data/tableImport";
import { locateDataBlock, readDiagramFile, writeDiagramFile } from "../storage/diagramFile";
import { SankeyRenderer, type HitTarget, type Selection } from "../render/SankeyRenderer";
import { DiagramController, type ChangeEvent } from "./DiagramController";
import { addLinkMenuItems, openLink, paneTypeFor, triggerHoverPreview, wikilinkTo } from "../obsidian/links";
import { CsvSourceModal, FilePickerModal } from "../modals/basic";
import { ImportModal } from "../modals/ImportModal";
import { errorMessage } from "../util/logger";
import { FlowsPanel } from "./panels/FlowsPanel";
import { NodesPanel } from "./panels/NodesPanel";
import { InspectorPanel } from "./panels/InspectorPanel";
import { DiagramPanel } from "./panels/DiagramPanel";
import type { Panel, PanelHost } from "./panels/types";
import type { ExportFormat } from "../export/exporter";

type TabId = "flows" | "nodes" | "inspect" | "diagram";
type SaveState = "saved" | "dirty" | "saving" | "error" | "paused";

const TABS: [TabId, string][] = [
	["flows", "Flows"],
	["nodes", "Nodes"],
	["inspect", "Inspect"],
	["diagram", "Diagram"],
];

/**
 * The Sankey editor. It is a TextFileView over the diagram's Markdown note,
 * so it participates in Obsidian's normal file lifecycle: tabs, history,
 * rename, "Open in new window", and save-on-close.
 *
 * Saving is driven by our own debounce (not `requestSave`) so that Obsidian
 * never attempts a plain-text three-way merge on the JSON; external changes
 * reach {@link setViewData} intact and real conflicts are shown to the user.
 */
export class SankeyEditorView extends TextFileView implements PanelHost {
	readonly controller = new DiagramController(createEmptyDocument(""));
	hoverPopover: HoverPopover | null = null;
	renderer!: SankeyRenderer;

	/** File text the current baseline was read from (or last written). */
	private baseText = "";
	/** The document object corresponding to `baseText`. Identity marks "no unsaved edits". */
	private baseDoc: SankeyDocument | null = null;
	private loaded = false;
	private loadError: Error | null = null;
	private issues: ValidationIssue[] = [];
	private conflict: { text: string; doc: SankeyDocument | null } | null = null;
	private saveTimer: number | null = null;
	private saveState: SaveState = "saved";

	private toolbarEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private stageEl!: HTMLElement;
	private sidebarEl!: HTMLElement;
	private errorEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private undoBtn!: HTMLElement;
	private redoBtn!: HTMLElement;
	private tabButtons = new Map<TabId, HTMLElement>();
	private panels = new Map<TabId, Panel>();
	private activeTab: TabId = "flows";
	private sidebarOpen = !Platform.isPhone;
	private resizeObserver: ResizeObserver | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: SankeyFlowPlugin,
	) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		const editingText = () => {
			const el = document.activeElement;
			return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
		};
		this.scope.register(["Mod"], "z", () => (editingText() ? true : (this.undo(), false)));
		this.scope.register(["Mod", "Shift"], "z", () => (editingText() ? true : (this.redo(), false)));
		this.scope.register(["Mod"], "y", () => (editingText() ? true : (this.redo(), false)));
	}

	getViewType(): string {
		return VIEW_TYPE_EDITOR;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Sankey diagram";
	}

	getIcon(): string {
		return ICON_ID;
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "md";
	}

	sourcePath(): string {
		return this.file?.path ?? "";
	}

	// ── State persisted with the workspace layout ────────────────────────

	getState(): Record<string, unknown> {
		return { ...super.getState(), tab: this.activeTab, sidebar: this.sidebarOpen };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { tab?: TabId; sidebar?: boolean };
		if (s.tab && TABS.some(([id]) => id === s.tab)) this.activeTab = s.tab;
		if (typeof s.sidebar === "boolean") this.sidebarOpen = s.sidebar;
		await super.setState(state, result);
		if (this.panels.size) {
			this.showTab(this.activeTab);
			this.applySidebar();
		}
	}

	// ── Layout ───────────────────────────────────────────────────────────

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("sankey-flow-editor");
		this.toolbarEl = root.createDiv("sankey-flow-toolbar");
		this.bannerEl = root.createDiv();
		this.bodyEl = root.createDiv("sankey-flow-body");
		this.stageEl = this.bodyEl.createDiv("sankey-flow-stage");
		this.errorEl = this.stageEl.createDiv("sankey-flow-load-error");
		this.errorEl.hide();
		this.sidebarEl = this.bodyEl.createDiv("sankey-flow-sidebar");

		this.renderer = new SankeyRenderer(
			this.stageEl,
			{
				onSelectionChange: (sel) => this.select(sel, { inspect: !!sel, origin: "diagram" }),
				onClick: (target, evt) => this.onDiagramClick(target, evt),
				onDoubleClick: (target) => this.select(target.kind === "background" ? null : target, { inspect: true, focus: true }),
				onContextMenu: (target, evt) => this.openMenu(target, evt),
				onHoverLink: (target, evt, el) => this.onHoverLink(target, evt, el),
				onActivate: (target) => this.select(target.kind === "background" ? null : target, { inspect: true, focus: true }),
				onDeleteRequest: (sel) => this.deleteSelection(sel),
				onNodeMoved: (id, position) => this.controller.update("Move node", (d) => updateNode(d, id, { position })),
				onConnect: (source, target, position) => this.connect(source, target, position),
				onRender: () => this.panels.get("nodes")?.refresh({ kind: "selection" }),
			},
			{ editable: true, ariaLabel: "Sankey diagram editor", linkHint: "Ctrl/Cmd-click to open" },
		);
		this.buildStageControls();
		this.buildToolbar();
		this.buildSidebar();

		this.addAction("file-text", "Open as Markdown", () => void this.plugin.openAsMarkdown(this.leaf));

		this.unsubscribe = this.controller.on((e) => this.onModelChange(e));
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.rerender(false)));
		this.registerEvent(this.app.workspace.on("css-change", () => this.rerender(false)));

		this.resizeObserver = new ResizeObserver(() => {
			const narrow = this.contentEl.clientWidth < 640;
			this.contentEl.toggleClass("is-narrow", narrow);
		});
		this.resizeObserver.observe(this.contentEl);
		this.applySidebar();
		this.showTab(this.activeTab);
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.resizeObserver?.disconnect();
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		for (const panel of this.panels.values()) panel.destroy?.();
		this.renderer?.destroy();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
		const btn = parent.createDiv({ cls: "clickable-icon", attr: { role: "button", tabindex: "0", "aria-label": label } });
		setIcon(btn, icon);
		setTooltip(btn, label);
		btn.addEventListener("click", onClick);
		btn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				const r = btn.getBoundingClientRect();
				onClick(new MouseEvent("click", { clientX: r.left, clientY: r.bottom }));
			}
		});
		return btn;
	}

	private buildToolbar(): void {
		const bar = this.toolbarEl;
		const history = bar.createDiv("sankey-flow-toolbar-group");
		this.undoBtn = this.iconButton(history, "undo-2", "Undo", () => this.undo());
		this.redoBtn = this.iconButton(history, "redo-2", "Redo", () => this.redo());
		bar.createDiv("sankey-flow-toolbar-sep");
		const edit = bar.createDiv("sankey-flow-toolbar-group");
		this.iconButton(edit, "circle-plus", "Add node", () => this.addNode());
		this.iconButton(edit, "file-input", "Import CSV…", () => this.importData());
		bar.createDiv("sankey-flow-toolbar-sep");
		const layout = bar.createDiv("sankey-flow-toolbar-group");
		this.iconButton(layout, "align-horizontal-space-between", "Auto layout", (evt) => this.layoutMenu(evt));
		this.iconButton(layout, "rotate-ccw", "Reset layout", () => this.resetLayout());
		bar.createDiv("sankey-flow-toolbar-spacer");
		this.statusEl = bar.createDiv({ cls: "sankey-flow-status", attr: { "aria-live": "polite" } });
		this.statusEl.addEventListener("click", () => {
			if (this.issues.length) this.showIssues();
			else if (this.saveState === "dirty" || this.saveState === "error") void this.saveNow();
		});
		const end = bar.createDiv("sankey-flow-toolbar-group");
		this.iconButton(end, "download", "Export", (evt) => this.exportMenu(evt));
		this.iconButton(end, "panel-right", "Toggle sidebar", () => {
			this.sidebarOpen = !this.sidebarOpen;
			this.applySidebar();
			this.app.workspace.requestSaveLayout();
		});
		this.updateToolbar();
	}

	private buildStageControls(): void {
		const controls = this.stageEl.createDiv("sankey-flow-stage-controls");
		this.iconButton(controls, "zoom-out", "Zoom out", () => this.renderer.zoomBy(0.8));
		this.iconButton(controls, "scan", "Fit to view", () => this.renderer.fitView());
		this.iconButton(controls, "zoom-in", "Zoom in", () => this.renderer.zoomBy(1.25));
	}

	private buildSidebar(): void {
		const tabs = this.sidebarEl.createDiv({ cls: "sankey-flow-tabs", attr: { role: "tablist" } });
		const panelsEl = this.sidebarEl.createDiv({ cls: "sankey-flow-panel" });
		for (const [id, label] of TABS) {
			const btn = tabs.createEl("button", { cls: "sankey-flow-tab", attr: { role: "tab" } });
			btn.createSpan({ text: label });
			if (id === "flows" || id === "nodes") btn.createSpan({ cls: "sankey-flow-tab-count" });
			btn.addEventListener("click", () => this.showTab(id));
			this.tabButtons.set(id, btn);
		}
		this.panels.set("flows", new FlowsPanel(panelsEl, this));
		this.panels.set("nodes", new NodesPanel(panelsEl, this));
		this.panels.set("inspect", new InspectorPanel(panelsEl, this));
		this.panels.set("diagram", new DiagramPanel(panelsEl, this));
	}

	private showTab(id: TabId): void {
		this.activeTab = id;
		for (const [tab, btn] of this.tabButtons) {
			btn.toggleClass("is-active", tab === id);
			btn.setAttr("aria-selected", String(tab === id));
		}
		for (const [tab, panel] of this.panels) panel.el.toggle(tab === id);
		this.panels.get(id)?.onShow?.();
	}

	private applySidebar(): void {
		this.sidebarEl.toggleClass("is-collapsed", !this.sidebarOpen);
	}

	// ── Loading and saving ───────────────────────────────────────────────

	setViewData(data: string, clear: boolean): void {
		if (clear || !this.loaded) this.loadText(data);
		else this.onExternalText(data);
	}

	getViewData(): string {
		if (this.loadError || !this.loaded) return this.baseText;
		// Unresolved conflict: never overwrite the other version implicitly.
		if (this.conflict) return this.conflict.text;
		if (this.controller.doc === this.baseDoc) return this.baseText;
		return writeDiagramFile(this.controller.doc, this.baseText);
	}

	clear(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		this.loaded = false;
		this.loadError = null;
		this.conflict = null;
		this.issues = [];
		this.baseText = "";
		this.baseDoc = null;
		this.controller.selection = null;
	}

	async onUnloadFile(file: TFile): Promise<void> {
		if (this.conflict && this.controller.doc !== this.baseDoc) {
			// Keep the local edits without touching the file someone else changed.
			try {
				const copy = await this.plugin.store.create(`${file.basename} (conflicted copy)`, this.controller.doc, file.parent?.path ?? "/");
				new Notice(`Your unsaved changes were kept in "${copy.path}".`, 8000);
			} catch (e) {
				this.plugin.reportError("Could not keep your unsaved changes", e);
			}
		}
		await super.onUnloadFile(file);
	}

	private loadText(text: string): void {
		this.baseText = text;
		this.conflict = null;
		this.loaded = true;
		try {
			const result = readDiagramFile(text);
			this.loadError = null;
			this.issues = result.issues;
			this.baseDoc = result.doc;
			this.controller.load(result.doc);
			this.bannerEl.empty();
			if (result.migratedFrom !== null) {
				this.banner("info", "This diagram was converted from an older format. It will be saved in the current format after your next edit.");
			}
		} catch (e) {
			this.loadError = e instanceof Error ? e : new Error(String(e));
			this.issues = [];
			this.baseDoc = null;
			this.plugin.logger.debug("Failed to load diagram", e);
		}
		this.setSaveState("saved");
		this.showLoadState();
	}

	private onExternalText(text: string): void {
		if (text === this.baseText) return;
		const dirty = this.controller.doc !== this.baseDoc;
		if (locateDataBlock(text)?.content === locateDataBlock(this.baseText)?.content && !this.loadError) {
			// Only text around the diagram changed (e.g. Obsidian updated a link in the frontmatter).
			this.baseText = text;
			return;
		}
		let doc: SankeyDocument | null = null;
		try {
			doc = readDiagramFile(text).doc;
		} catch (e) {
			if (!dirty) {
				this.loadText(text);
				return;
			}
			this.plugin.logger.debug("External change is not valid diagram data", e);
		}
		if (!dirty || this.loadError) {
			if (this.loadError) {
				this.loadText(text);
				return;
			}
			this.baseText = text;
			this.baseDoc = doc;
			if (doc) this.controller.replace(doc, "External change", "external");
			this.setSaveState("saved");
			return;
		}
		this.conflict = { text, doc };
		this.setSaveState("paused");
		this.showConflict();
	}

	private showConflict(): void {
		this.bannerEl.empty();
		const banner = this.bannerEl.createDiv("sankey-flow-banner is-warning");
		banner.createDiv({
			cls: "sankey-flow-banner-text",
			text: "This diagram was changed outside the editor while you had unsaved changes. Autosave is paused until you choose a version.",
		});
		new ButtonComponent(banner).setButtonText("Keep my version").setCta().onClick(() => {
			const conflict = this.conflict;
			if (!conflict) return;
			this.conflict = null;
			this.baseText = conflict.text;
			this.bannerEl.empty();
			void this.saveNow();
		});
		new ButtonComponent(banner)
			.setButtonText(this.conflictDocUsable() ? "Load the other version" : "Discard my changes")
			.onClick(() => {
				const conflict = this.conflict;
				if (!conflict) return;
				this.conflict = null;
				this.bannerEl.empty();
				if (conflict.doc) {
					this.baseText = conflict.text;
					this.baseDoc = conflict.doc;
					this.controller.replace(conflict.doc, "Load external version", "external");
					this.setSaveState("saved");
				} else {
					this.loadText(conflict.text);
				}
			});
	}

	private conflictDocUsable(): boolean {
		return !!this.conflict?.doc;
	}

	private showLoadState(): void {
		const error = this.loadError;
		this.errorEl.toggle(!!error);
		this.renderer.el.toggle(!error);
		this.sidebarEl.toggle(!error);
		this.toolbarEl.toggleClass("is-disabled", !!error);
		if (error) {
			this.errorEl.empty();
			const newer = error instanceof SankeyFormatError && error.kind === "newer-version";
			this.errorEl.createEl("h3", { text: newer ? "Newer diagram format" : "This diagram could not be opened" });
			this.errorEl.createEl("p", {
				text: error instanceof SankeyFormatError ? error.message : `Unexpected error: ${errorMessage(error)}`,
			});
			this.errorEl.createEl("p", { text: "The file has not been changed. You can fix the data in the Markdown note and it will reload automatically." });
			new ButtonComponent(this.errorEl).setButtonText("Open as Markdown").setCta().onClick(() => void this.plugin.openAsMarkdown(this.leaf));
			return;
		}
		this.rerender(false);
		this.updateToolbar();
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (this.conflict || this.loadError) return;
		if (!this.plugin.settings.autosave) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, Math.max(200, this.plugin.settings.autosaveDelay));
	}

	/** Writes pending changes now. */
	async saveNow(): Promise<void> {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (this.conflict || this.loadError || !this.file) return;
		await this.save();
	}

	async save(clear?: boolean): Promise<void> {
		const doc = this.controller.doc;
		const text = this.getViewData();
		const changed = text !== this.baseText;
		if (changed && !clear) this.setSaveState("saving");
		try {
			await super.save(clear);
			if (clear) return;
			if (changed && !this.conflict) {
				this.baseText = text;
				this.baseDoc = doc;
			}
			this.setSaveState(this.controller.doc === this.baseDoc ? "saved" : "dirty");
		} catch (e) {
			// Obsidian already showed a notice and stored a backup of the text.
			this.setSaveState("error");
			this.plugin.logger.error("Saving the diagram failed", e);
		}
	}

	private setSaveState(state: SaveState): void {
		this.saveState = state;
		this.updateToolbar();
	}

	// ── Model changes ────────────────────────────────────────────────────

	private onModelChange(event: ChangeEvent): void {
		if (event.kind !== "selection") {
			this.rerender(event.kind !== "load");
			if (event.kind !== "load" && event.kind !== "external") {
				this.setSaveState(this.controller.doc === this.baseDoc ? "saved" : "dirty");
				this.scheduleSave();
			}
		} else {
			this.renderer.setSelection(this.controller.selection, true);
		}
		for (const panel of this.panels.values()) panel.refresh(event);
		this.updateToolbar();
	}

	private rerender(animate: boolean): void {
		if (!this.renderer || this.loadError || !this.loaded) return;
		const doc = this.controller.doc;
		this.renderer.setData(doc, this.plugin.renderConfig(doc, "editor"), animate);
	}

	private updateToolbar(): void {
		if (!this.statusEl) return;
		const c = this.controller;
		this.undoBtn.toggleClass("is-disabled", !c.canUndo);
		this.redoBtn.toggleClass("is-disabled", !c.canRedo);
		setTooltip(this.undoBtn, c.undoLabel ? `Undo ${c.undoLabel.toLowerCase()}` : "Undo");
		setTooltip(this.redoBtn, c.redoLabel ? `Redo ${c.redoLabel.toLowerCase()}` : "Redo");
		const doc = c.doc;
		const flowsTab = this.tabButtons.get("flows")?.querySelector(".sankey-flow-tab-count");
		const nodesTab = this.tabButtons.get("nodes")?.querySelector(".sankey-flow-tab-count");
		flowsTab?.setText(String(doc.flows.length));
		nodesTab?.setText(String(doc.nodes.length));

		this.statusEl.removeClass("is-warning");
		if (this.issues.length) {
			this.statusEl.addClass("is-warning");
			this.statusEl.setText(`${this.issues.length} issue${this.issues.length === 1 ? "" : "s"}`);
			setTooltip(this.statusEl, "Problems found while loading. Click for details.");
			return;
		}
		const labels: Record<SaveState, string> = {
			saved: "Saved",
			dirty: this.plugin.settings.autosave ? "Unsaved" : "Unsaved — click to save",
			saving: "Saving…",
			error: "Save failed — click to retry",
			paused: "Autosave paused",
		};
		this.statusEl.setText(labels[this.saveState]);
		this.statusEl.toggleClass("is-warning", this.saveState === "error" || this.saveState === "paused");
		setTooltip(this.statusEl, this.plugin.settings.autosave ? "Changes are saved automatically." : "Autosave is off in settings.");
	}

	private banner(kind: "info" | "warning" | "error", text: string): void {
		const banner = this.bannerEl.createDiv(`sankey-flow-banner is-${kind}`);
		banner.createDiv({ cls: "sankey-flow-banner-text", text });
		const close = banner.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Dismiss" } });
		setIcon(close, "x");
		close.addEventListener("click", () => banner.remove());
	}

	private showIssues(): void {
		this.bannerEl.empty();
		const banner = this.bannerEl.createDiv("sankey-flow-banner is-warning");
		const text = banner.createDiv("sankey-flow-banner-text");
		text.createDiv({ text: "These problems were found and fixed in memory when the diagram was loaded. They are written to the file on your next edit." });
		const list = text.createEl("ul");
		for (const issue of this.issues.slice(0, 20)) list.createEl("li", { text: issue.message });
		if (this.issues.length > 20) list.createEl("li", { text: `… and ${this.issues.length - 20} more` });
		new ButtonComponent(banner).setButtonText("Dismiss").onClick(() => {
			this.issues = [];
			this.bannerEl.empty();
			this.updateToolbar();
		});
	}

	// ── PanelHost ────────────────────────────────────────────────────────

	hover(target: HitTarget | null): void {
		this.renderer.setExternalHover(target);
	}

	nodeColor(nodeId: string): string {
		return this.renderer.colorOf(nodeId);
	}

	select(selection: Selection, options: { inspect?: boolean; origin?: string; focus?: boolean } = {}): void {
		this.controller.select(selection, options.origin);
		this.renderer.setSelection(selection, true);
		if (options.inspect && selection) {
			if (!this.sidebarOpen && options.focus) {
				this.sidebarOpen = true;
				this.applySidebar();
			}
			this.showTab("inspect");
		}
		if (options.focus) window.setTimeout(() => (this.panels.get("inspect") as InspectorPanel | undefined)?.focusFirstField(), 0);
	}

	addNode(): void {
		let id = "";
		this.controller.update("Add node", (d) => (id = addNode(d, { label: nextNodeLabel(d) }).id));
		this.select({ kind: "node", id }, { inspect: true, focus: true });
	}

	importData(): void {
		new CsvSourceModal(this.app, (text, name) => {
			new ImportModal(this.plugin, {
				source: { kind: "csv", text, name },
				target: "into",
				onSubmit: ({ rows, merge, replace }) => {
					this.controller.update(replace ? "Replace data from CSV" : "Import CSV", (d) => {
						if (replace) {
							d.nodes = [];
							d.flows = [];
						}
						appendRows(d, rows, merge);
					});
					new Notice(`Imported ${rows.length} flow${rows.length === 1 ? "" : "s"}.`);
				},
			}).open();
		}).open();
	}

	exportCsv(): void {
		void this.export("csv");
	}

	openNodeMenu(nodeId: string, evt: MouseEvent): void {
		this.openMenu({ kind: "node", id: nodeId }, evt);
	}

	openFlowMenu(flowId: string, evt: MouseEvent): void {
		this.openMenu({ kind: "flow", id: flowId }, evt);
	}

	// ── Diagram interactions ─────────────────────────────────────────────

	private onDiagramClick(target: HitTarget, evt: MouseEvent): void {
		if (target.kind === "background" || !Keymap.isModEvent(evt)) return;
		const doc = this.controller.doc;
		const item = target.kind === "node" ? nodeById(doc, target.id) : flowById(doc, target.id);
		if (item?.link) void openLink(this.app, item.link, this.sourcePath(), paneTypeFor(evt));
	}

	private onHoverLink(target: HitTarget, evt: MouseEvent, el: Element): void {
		if (target.kind === "background") return;
		const doc = this.controller.doc;
		const item = target.kind === "node" ? nodeById(doc, target.id) : flowById(doc, target.id);
		if (item?.link) triggerHoverPreview(this.app, evt, el as HTMLElement, item.link, this.sourcePath(), this);
	}

	private connect(source: string, target: string | null, position: { x: number; y: number } | null): void {
		const doc = this.controller.doc;
		const totals = nodeTotals(doc).get(source);
		const remaining = totals ? totals.incoming - totals.outgoing : 0;
		const values = doc.flows.map((f) => f.value).filter((v) => v > 0).sort((a, b) => a - b);
		const value = remaining > 0 ? remaining : values.length ? values[Math.floor(values.length / 2)] : 10;
		let flowId = "";
		let nodeId = "";
		this.controller.update(target ? "Connect nodes" : "Add connected node", (d) => {
			let to = target;
			if (!to) {
				const created = addNode(d, { label: nextNodeLabel(d), ...(position ? { position } : {}) });
				to = created.id;
				nodeId = created.id;
			}
			flowId = addFlow(d, source, to, value).id;
		});
		if (nodeId) this.select({ kind: "node", id: nodeId }, { inspect: true, focus: true });
		else if (flowId) this.select({ kind: "flow", id: flowId }, { inspect: true });
	}

	private deleteSelection(sel: NonNullable<Selection>): void {
		if (sel.kind === "node") this.controller.update("Delete node", (d) => removeNode(d, sel.id));
		else this.controller.update("Delete flow", (d) => removeFlow(d, sel.id));
		this.select(null);
	}

	private openMenu(target: HitTarget, evt: MouseEvent): void {
		const menu = new Menu();
		const doc = this.controller.doc;
		const path = this.sourcePath();
		if (target.kind === "node") {
			const node = nodeById(doc, target.id);
			if (!node) return;
			if (node.link) addLinkMenuItems(menu, this.app, node.link, path);
			menu.addItem((i) => i.setSection("edit").setTitle("Edit node").setIcon("pencil").onClick(() => this.select(target, { inspect: true, focus: true })));
			menu.addItem((i) =>
				i
					.setSection("edit")
					.setTitle(node.link ? "Change linked note…" : "Link to note…")
					.setIcon("link")
					.onClick(() => this.pickLink((link) => this.controller.update("Set node link", (d) => updateNode(d, node.id, { link })))),
			);
			if (node.link) {
				menu.addItem((i) =>
					i.setSection("edit").setTitle("Remove link").setIcon("unlink").onClick(() => this.controller.update("Remove node link", (d) => updateNode(d, node.id, { link: null }))),
				);
			}
			if (node.position) {
				menu.addItem((i) =>
					i.setSection("edit").setTitle("Unpin position").setIcon("pin-off").onClick(() => this.controller.update("Unpin node", (d) => updateNode(d, node.id, { position: null }))),
				);
			}
			menu.addItem((i) =>
				i
					.setSection("danger")
					.setTitle("Delete node")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => this.deleteSelection(target)),
			);
		} else if (target.kind === "flow") {
			const flow = flowById(doc, target.id);
			if (!flow) return;
			if (flow.link) addLinkMenuItems(menu, this.app, flow.link, path);
			menu.addItem((i) => i.setSection("edit").setTitle("Edit flow").setIcon("pencil").onClick(() => this.select(target, { inspect: true, focus: true })));
			menu.addItem((i) =>
				i
					.setSection("edit")
					.setTitle("Swap direction")
					.setIcon("arrow-left-right")
					.onClick(() => this.controller.update("Swap flow direction", (d) => updateFlow(d, flow.id, { source: flow.target, target: flow.source }))),
			);
			menu.addItem((i) =>
				i.setSection("edit").setTitle("Duplicate flow").setIcon("copy").onClick(() => this.controller.update("Duplicate flow", (d) => duplicateFlow(d, flow.id))),
			);
			menu.addItem((i) =>
				i
					.setSection("danger")
					.setTitle("Delete flow")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => this.deleteSelection(target)),
			);
		} else {
			menu.addItem((i) => i.setSection("edit").setTitle("Add node").setIcon("circle-plus").onClick(() => this.addNode()));
			menu.addItem((i) => i.setSection("view").setTitle("Fit to view").setIcon("scan").onClick(() => this.renderer.fitView()));
			menu.addItem((i) => i.setSection("view").setTitle("Reset layout").setIcon("rotate-ccw").onClick(() => this.resetLayout()));
			menu.addItem((i) => i.setSection("export").setTitle("Export as SVG").setIcon("image").onClick(() => void this.export("svg")));
			menu.addItem((i) => i.setSection("export").setTitle("Export as PNG").setIcon("image").onClick(() => void this.export("png")));
		}
		menu.showAtMouseEvent(evt);
	}

	private pickLink(apply: (link: string) => void): void {
		const files = this.app.vault.getFiles().filter((f) => f !== this.file);
		new FilePickerModal(this.app, files, "Link to…", (file) => apply(wikilinkTo(this.app, file, this.sourcePath()))).open();
	}

	private layoutMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const current = this.controller.doc.layout.align;
		const options: [Alignment, string][] = [
			["justify", "Justify"],
			["left", "Align left"],
			["right", "Align right"],
			["center", "Centre"],
		];
		for (const [align, label] of options) {
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setChecked(current === align)
					.onClick(() => this.controller.update("Change alignment", (d) => (d.layout.align = align))),
			);
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Reset manual positions").setIcon("rotate-ccw").onClick(() => this.resetLayout()));
		menu.showAtMouseEvent(evt);
	}

	resetLayout(): void {
		if (!this.controller.update("Reset layout", clearPositions)) new Notice("No nodes have been moved manually.");
		this.renderer.fitView();
	}

	private exportMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const items: [ExportFormat, string, string][] = [
			["svg", "Export as SVG", "image"],
			["png", "Export as PNG", "image"],
			["csv", "Export flows as CSV", "table"],
			["json", "Export diagram data (JSON)", "braces"],
		];
		for (const [format, title, icon] of items) menu.addItem((i) => i.setSection("export").setTitle(title).setIcon(icon).onClick(() => void this.export(format)));
		if (this.file) {
			const file = this.file;
			menu.addItem((i) =>
				i
					.setSection("embed")
					.setTitle("Copy embed link")
					.setIcon("link")
					.onClick(() => void this.plugin.copyEmbedCode(file)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	async export(format: ExportFormat): Promise<void> {
		if (this.loadError) return;
		const doc = this.controller.doc;
		await this.plugin.exporter.export(format, {
			renderer: this.renderer,
			doc,
			name: doc.meta.title || this.file?.basename || "Sankey diagram",
			sourcePath: this.sourcePath(),
		});
	}

	// ── Commands ─────────────────────────────────────────────────────────

	undo(): void {
		if (!this.controller.undo()) new Notice("Nothing to undo.");
	}

	redo(): void {
		if (!this.controller.redo()) new Notice("Nothing to redo.");
	}

	focusDiagram(): void {
		this.renderer.focus();
	}

	fitView(): void {
		this.renderer.fitView();
	}

	zoom(factor: number): void {
		this.renderer.zoomBy(factor);
	}

	/** Applies an update coming from outside the editor (e.g. rename relinking). */
	applyExternalUpdate(label: string, doc: SankeyDocument): void {
		this.controller.update(label, (d) => {
			d.nodes = doc.nodes;
			d.flows = doc.flows;
		});
	}

	get hasLoadError(): boolean {
		return !!this.loadError;
	}

	get diagramFile(): TFile | null {
		return this.file;
	}
}
