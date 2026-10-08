import { ButtonComponent, setIcon, setTooltip } from "obsidian";
import type { ChangeEvent } from "../DiagramController";
import { moveNode, nodeTotals, updateNode } from "../../model/operations";
import { linkDisplayText } from "../../model/linkValue";
import { formatValue } from "../../render/format";
import type { Panel, PanelHost } from "./types";

/**
 * Node list in document order (which is also the vertical stacking order
 * the layout starts from). Supports search, rename (double-click or F2),
 * reordering (buttons or Alt+↑/↓) and selection.
 */
export class NodesPanel implements Panel {
	readonly el: HTMLElement;
	private readonly list: HTMLElement;
	private readonly countEl: HTMLElement;
	private search = "";
	private renaming: string | null = null;

	constructor(
		parent: HTMLElement,
		private readonly host: PanelHost,
	) {
		this.el = parent.createDiv("sankey-flow-panel");
		const bar = this.el.createDiv("sankey-flow-panel-bar");
		const search = bar.createEl("input", { type: "search", attr: { placeholder: "Search nodes…", "aria-label": "Search nodes" } });
		search.addEventListener("input", () => {
			this.search = search.value.trim().toLowerCase();
			this.render();
		});
		this.countEl = bar.createDiv("sankey-flow-status");
		const scroll = this.el.createDiv("sankey-flow-panel-scroll");
		this.list = scroll.createDiv("sankey-flow-node-list");
		this.list.setAttr("role", "listbox");
		this.list.setAttr("aria-label", "Nodes");
		const footer = this.el.createDiv("sankey-flow-panel-footer");
		new ButtonComponent(footer).setButtonText("Add node").onClick(() => host.addNode());
		this.render();
	}

	refresh(event: ChangeEvent): void {
		if (this.renaming && event.kind !== "load") return;
		if (event.kind === "selection") {
			this.syncSelection();
			return;
		}
		this.render();
	}

	private syncSelection(): void {
		const sel = this.host.controller.selection;
		for (const item of Array.from(this.list.children) as HTMLElement[]) {
			const selected = sel?.kind === "node" && sel.id === item.dataset.id;
			item.toggleClass("is-selected", selected);
			item.setAttr("aria-selected", String(selected));
			if (selected) item.scrollIntoView({ block: "nearest" });
		}
	}

	private render(): void {
		const doc = this.host.controller.doc;
		const totals = nodeTotals(doc);
		const sel = this.host.controller.selection;
		const config = this.host.plugin.renderConfig(doc, "editor");
		const nodes = this.search
			? doc.nodes.filter((n) => n.label.toLowerCase().includes(this.search) || (n.group ?? "").toLowerCase().includes(this.search))
			: doc.nodes;
		this.countEl.setText(this.search ? `${nodes.length} of ${doc.nodes.length}` : `${doc.nodes.length} node${doc.nodes.length === 1 ? "" : "s"}`);
		this.list.empty();
		if (!nodes.length) {
			this.list.createDiv({ cls: "sankey-flow-table-empty", text: doc.nodes.length ? "No nodes match your search." : "No nodes yet." });
			return;
		}
		nodes.forEach((node) => {
			const index = doc.nodes.indexOf(node);
			const item = this.list.createDiv("sankey-flow-node-item");
			item.dataset.id = node.id;
			item.tabIndex = 0;
			item.setAttr("role", "option");
			const selected = sel?.kind === "node" && sel.id === node.id;
			item.toggleClass("is-selected", selected);
			item.setAttr("aria-selected", String(selected));

			const swatch = item.createDiv("sankey-flow-swatch");
			swatch.setCssProps({ "--sankey-flow-swatch": this.host.nodeColor(node.id) });
			const label = item.createDiv({ cls: "sankey-flow-node-item-label", text: node.label });
			const icons = item.createDiv("sankey-flow-node-item-icons");
			if (node.link) {
				const i = icons.createSpan();
				setIcon(i, "link");
				setTooltip(i, linkDisplayText(node.link));
			}
			if (node.position) {
				const i = icons.createSpan();
				setIcon(i, "pin");
				setTooltip(i, "Position pinned");
			}
			const t = totals.get(node.id);
			const value = Math.max(t?.incoming ?? 0, t?.outgoing ?? 0);
			item.createDiv({ cls: "sankey-flow-node-item-value", text: formatValue(value, config.format) });

			const move = item.createDiv("sankey-flow-node-item-move");
			if (!this.search) {
				const up = move.createDiv("clickable-icon");
				setIcon(up, "chevron-up");
				up.setAttr("aria-label", "Move up");
				up.toggleClass("is-disabled", index === 0);
				up.addEventListener("click", (e) => {
					e.stopPropagation();
					this.move(node.id, index - 1);
				});
				const down = move.createDiv("clickable-icon");
				setIcon(down, "chevron-down");
				down.setAttr("aria-label", "Move down");
				down.toggleClass("is-disabled", index === doc.nodes.length - 1);
				down.addEventListener("click", (e) => {
					e.stopPropagation();
					this.move(node.id, index + 1);
				});
			}

			item.addEventListener("click", () => this.host.select({ kind: "node", id: node.id }, { origin: "nodes" }));
			item.addEventListener("dblclick", () => this.startRename(label, node.id, node.label));
			item.addEventListener("mouseenter", () => this.host.hover({ kind: "node", id: node.id }));
			item.addEventListener("mouseleave", () => this.host.hover(null));
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.host.select({ kind: "node", id: node.id }, { origin: "nodes" });
				this.host.openNodeMenu(node.id, e);
			});
			item.addEventListener("keydown", (e) => {
				if (e.target !== item) return;
				if (e.key === "Enter") this.host.select({ kind: "node", id: node.id }, { inspect: true, origin: "nodes" });
				else if (e.key === "F2") this.startRename(label, node.id, node.label);
				else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
					this.move(node.id, index + (e.key === "ArrowUp" ? -1 : 1));
					window.requestAnimationFrame(() => this.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(node.id)}"]`)?.focus());
				} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					const sibling = (e.key === "ArrowDown" ? item.nextElementSibling : item.previousElementSibling) as HTMLElement | null;
					sibling?.focus();
				} else return;
				e.preventDefault();
			});
		});
	}

	private move(id: string, to: number): void {
		this.host.controller.update("Reorder node", (d) => moveNode(d, id, to));
	}

	private startRename(label: HTMLElement, id: string, current: string): void {
		this.renaming = id;
		const input = createEl("input", { type: "text", value: current, attr: { "aria-label": "Node name" } });
		label.replaceWith(input);
		input.focus();
		input.select();
		let done = false;
		const finish = (commit: boolean) => {
			if (done) return;
			done = true;
			this.renaming = null;
			const value = input.value.trim();
			if (commit && value && value !== current) {
				this.host.controller.update("Rename node", (d) => updateNode(d, id, { label: value }));
			} else {
				this.render();
			}
			this.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") finish(true);
			if (e.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
	}
}
