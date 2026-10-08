import { ItemView, Menu, Notice, TFile, debounce, setIcon, type WorkspaceLeaf } from "obsidian";
import type SankeyFlowPlugin from "../main";
import { ICON_ID, VIEW_TYPE_MANAGER } from "../constants";
import { confirmAction, promptText } from "../modals/basic";
import { paneTypeFor } from "../obsidian/links";
import { sanitizeFileName } from "../storage/DiagramStore";

type SortKey = "name" | "modified" | "created";

/**
 * Lists every diagram in the vault. Uses only the metadata cache and file
 * stats, so it stays fast with hundreds of diagrams; references are computed
 * lazily per diagram on request.
 */
export class DiagramManagerView extends ItemView {
	private search = "";
	private sort: SortKey = "modified";
	private listEl!: HTMLElement;
	private expanded = new Set<string>();
	private readonly refresh = debounce(() => this.render(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: SankeyFlowPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_MANAGER;
	}

	getDisplayText(): string {
		return "Sankey diagrams";
	}

	getIcon(): string {
		return ICON_ID;
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("sankey-flow-manager");
		const bar = root.createDiv("sankey-flow-manager-bar");
		const search = bar.createEl("input", { type: "search", attr: { placeholder: "Search diagrams…", "aria-label": "Search diagrams" } });
		search.addEventListener("input", () => {
			this.search = search.value.trim().toLowerCase();
			this.render();
		});
		const sort = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Sort diagrams" } });
		for (const [value, label] of [
			["modified", "Recently modified"],
			["name", "Name"],
			["created", "Recently created"],
		] as const) {
			sort.createEl("option", { value, text: label });
		}
		sort.value = this.sort;
		sort.addEventListener("change", () => {
			this.sort = sort.value as SortKey;
			this.render();
		});
		const create = bar.createDiv({ cls: "clickable-icon", attr: { "aria-label": "New diagram", role: "button", tabindex: "0" } });
		setIcon(create, "plus");
		create.addEventListener("click", () => void this.plugin.createDiagramInteractive());

		this.listEl = root.createDiv("sankey-flow-manager-list");
		const { vault, metadataCache } = this.app;
		this.registerEvent(vault.on("create", () => this.refresh()));
		this.registerEvent(vault.on("delete", () => this.refresh()));
		this.registerEvent(vault.on("rename", () => this.refresh()));
		this.registerEvent(metadataCache.on("changed", () => this.refresh()));
		this.registerEvent(metadataCache.on("resolved", () => this.refresh()));
		this.render();
	}

	private render(): void {
		if (!this.listEl) return;
		const files = this.plugin.store
			.listDiagrams()
			.filter((f) => !this.search || f.path.toLowerCase().includes(this.search))
			.sort((a, b) => {
				if (this.sort === "name") return a.basename.localeCompare(b.basename, undefined, { numeric: true });
				if (this.sort === "created") return b.stat.ctime - a.stat.ctime;
				return b.stat.mtime - a.stat.mtime;
			});
		const top = this.listEl.scrollTop;
		this.listEl.empty();
		if (!files.length) {
			const empty = this.listEl.createDiv("sankey-flow-manager-empty");
			empty.createDiv({ text: this.search ? "No diagrams match your search." : "No Sankey diagrams yet." });
			if (!this.search) {
				const btn = empty.createEl("button", { text: "Create a diagram", cls: "mod-cta" });
				btn.style.marginTop = "var(--size-4-3)";
				btn.addEventListener("click", () => void this.plugin.createDiagramInteractive());
			}
			return;
		}
		const incoming = new Map<string, number>();
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			for (const target of Object.keys(targets)) if (target !== source) incoming.set(target, (incoming.get(target) ?? 0) + 1);
		}
		for (const file of files) this.renderItem(file, incoming.get(file.path) ?? 0);
		this.listEl.scrollTop = top;
	}

	private renderItem(file: TFile, backlinks: number): void {
		const item = this.listEl.createDiv({ cls: "sankey-flow-manager-item", attr: { tabindex: "0", role: "button" } });
		const row = item.createDiv("sankey-flow-manager-item-row");
		const icon = row.createSpan();
		setIcon(icon, ICON_ID);
		row.createDiv({ cls: "sankey-flow-manager-item-name", text: file.basename });
		const more = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Diagram actions" } });
		setIcon(more, "more-horizontal");
		const folder = file.parent && file.parent.path !== "/" ? `${file.parent.path} · ` : "";
		item.createDiv({
			cls: "sankey-flow-manager-item-meta",
			text: `${folder}${relativeTime(file.stat.mtime)}${backlinks ? ` · linked from ${backlinks} note${backlinks === 1 ? "" : "s"}` : ""}`,
		});
		if (this.expanded.has(file.path)) void this.renderReferences(item, file);

		item.addEventListener("click", (evt) => {
			if ((evt.target as HTMLElement).closest(".clickable-icon, .sankey-flow-manager-refs")) return;
			void this.plugin.openDiagram(file, paneTypeFor(evt));
		});
		item.addEventListener("keydown", (evt) => {
			if (evt.target === item && evt.key === "Enter") void this.plugin.openDiagram(file, paneTypeFor(evt));
		});
		const menu = (evt: MouseEvent) => this.itemMenu(file, evt);
		more.addEventListener("click", menu);
		item.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			menu(evt);
		});
	}

	private async renderReferences(item: HTMLElement, file: TFile): Promise<void> {
		const box = item.createDiv({ cls: "sankey-flow-manager-refs", text: "Looking for references…" });
		const refs = await this.plugin.store.findReferences(file);
		box.empty();
		if (!refs.length) {
			box.setText("Not referenced from any note.");
			return;
		}
		for (const ref of refs) {
			const a = box.createEl("a", { text: ref.path.replace(/\.md$/i, ""), cls: "internal-link", href: "#" });
			a.addEventListener("click", (evt) => {
				evt.preventDefault();
				void this.app.workspace.getLeaf(paneTypeFor(evt)).openFile(ref);
			});
		}
	}

	private itemMenu(file: TFile, evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) => i.setSection("open").setTitle("Open").setIcon(ICON_ID).onClick(() => void this.plugin.openDiagram(file, false)));
		menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("file-plus-2").onClick(() => void this.plugin.openDiagram(file, "tab")));
		menu.addItem((i) =>
			i
				.setSection("open")
				.setTitle(this.expanded.has(file.path) ? "Hide references" : "Show references")
				.setIcon("links-coming-in")
				.onClick(() => {
					if (!this.expanded.delete(file.path)) this.expanded.add(file.path);
					this.render();
				}),
		);
		menu.addItem((i) => i.setSection("embed").setTitle("Copy embed link").setIcon("link").onClick(() => void this.plugin.copyEmbedCode(file)));
		menu.addItem((i) => i.setSection("manage").setTitle("Rename…").setIcon("pencil").onClick(() => void this.rename(file)));
		menu.addItem((i) =>
			i
				.setSection("manage")
				.setTitle("Duplicate")
				.setIcon("copy")
				.onClick(async () => {
					try {
						const copy = await this.plugin.store.duplicate(file);
						new Notice(`Created ${copy.path}`);
					} catch (e) {
						this.plugin.reportError("Could not duplicate the diagram", e);
					}
				}),
		);
		menu.addItem((i) =>
			i
				.setSection("danger")
				.setTitle("Delete")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.remove(file)),
		);
		this.app.workspace.trigger("file-menu", menu, file, "sankey-flow-manager");
		menu.showAtMouseEvent(evt);
	}

	private async rename(file: TFile): Promise<void> {
		const name = await promptText(this.app, { title: "Rename diagram", value: file.basename, cta: "Rename" });
		if (!name || name === file.basename) return;
		const folder = file.parent?.path ?? "/";
		const target = this.plugin.store.availablePath(folder, sanitizeFileName(name), file.extension);
		try {
			// fileManager.renameFile updates links to the diagram across the vault, per the user's settings.
			await this.app.fileManager.renameFile(file, target);
		} catch (e) {
			this.plugin.reportError("Could not rename the diagram", e);
		}
	}

	private async remove(file: TFile): Promise<void> {
		const refs = await this.plugin.store.findReferences(file);
		const ok = await confirmAction(this.app, {
			title: "Delete diagram?",
			message: `“${file.basename}” will be moved to the trash according to your Files and links settings.${
				refs.length ? ` It is referenced from ${refs.length} note${refs.length === 1 ? "" : "s"}, which will show a missing diagram.` : ""
			}`,
			cta: "Delete",
			warning: true,
		});
		if (!ok) return;
		try {
			await this.app.fileManager.trashFile(file);
		} catch (e) {
			this.plugin.reportError("Could not delete the diagram", e);
		}
	}
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

/** "3 days ago", in the user's locale. */
function relativeTime(timestamp: number): string {
	const seconds = (timestamp - Date.now()) / 1000;
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	}
	return format.format(0, "minute");
}
