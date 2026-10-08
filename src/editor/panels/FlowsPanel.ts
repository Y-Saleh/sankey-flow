import { ButtonComponent, setIcon } from "obsidian";
import type { ChangeEvent } from "../DiagramController";
import type { SankeyFlow } from "../../model/schema";
import { addFlow, ensureNode, setFlowEndpointByLabel, updateFlow } from "../../model/operations";
import { parseNumber } from "../../data/numbers";
import { formatValue } from "../../render/format";
import type { Panel, PanelHost } from "./types";

type SortKey = "order" | "source" | "target" | "value";

interface RowEls {
	el: HTMLElement;
	source: HTMLInputElement;
	target: HTMLInputElement;
	value: HTMLInputElement;
	flowId: string | null;
}

const ROW_HEIGHT = 32;
const OVERSCAN = 8;
let datalistCounter = 0;

/**
 * Spreadsheet-style flow editor. Rows are virtualised (only visible rows
 * exist in the DOM), so thousands of flows stay responsive. Sorting and
 * searching only affect the view, never the stored order.
 */
export class FlowsPanel implements Panel {
	readonly el: HTMLElement;
	private search = "";
	private sort: { key: SortKey; dir: 1 | -1 } = { key: "order", dir: 1 };
	private rows: SankeyFlow[] = [];
	private labels = new Map<string, string>();
	private readonly scroller: HTMLElement;
	private readonly body: HTMLElement;
	private readonly emptyEl: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly datalist: HTMLDataListElement;
	private readonly headButtons = new Map<SortKey, HTMLElement>();
	private pool: RowEls[] = [];
	private frame: number | null = null;
	private datalistKey = "";
	private readonly listId: string;

	constructor(
		parent: HTMLElement,
		private readonly host: PanelHost,
	) {
		this.el = parent.createDiv("sankey-flow-panel");
		const listId = `sankey-flow-nodes-${++datalistCounter}`;
		this.datalist = this.el.createEl("datalist", { attr: { id: listId } });

		const bar = this.el.createDiv("sankey-flow-panel-bar");
		const search = bar.createEl("input", { type: "search", attr: { placeholder: "Search flows…", "aria-label": "Search flows" } });
		search.addEventListener("input", () => {
			this.search = search.value.trim().toLowerCase();
			this.recompute();
		});
		this.countEl = bar.createDiv("sankey-flow-status");

		this.scroller = this.el.createDiv("sankey-flow-table");
		this.scroller.setAttr("role", "grid");
		this.scroller.setAttr("aria-label", "Flows");
		const head = this.scroller.createDiv("sankey-flow-table-head");
		head.setAttr("role", "row");
		for (const [key, label] of [
			["source", "Source"],
			["target", "Target"],
			["value", "Value"],
		] as const) {
			const btn = head.createEl("button", { text: label, cls: key === "value" ? "is-numeric" : "" });
			btn.setAttr("role", "columnheader");
			btn.addEventListener("click", () => this.toggleSort(key));
			this.headButtons.set(key, btn);
		}
		head.createDiv();
		this.body = this.scroller.createDiv("sankey-flow-table-body");
		this.emptyEl = this.scroller.createDiv({ cls: "sankey-flow-table-empty", text: "No flows yet. Add one below, or import a CSV file." });
		this.scroller.addEventListener("scroll", () => this.scheduleRows());

		this.buildAddRow(listId);

		const footer = this.el.createDiv("sankey-flow-panel-footer");
		new ButtonComponent(footer).setButtonText("Import CSV…").onClick(() => host.importData());
		new ButtonComponent(footer).setButtonText("Export CSV").onClick(() => host.exportCsv());

		this.listId = listId;
		this.recompute();
	}

	refresh(event: ChangeEvent): void {
		if (event.kind === "selection") {
			this.renderRows();
			if (event.origin !== "table" && this.host.controller.selection?.kind === "flow") this.scrollToFlow(this.host.controller.selection.id);
			return;
		}
		this.recompute();
	}

	onShow(): void {
		this.renderRows();
	}

	private toggleSort(key: SortKey): void {
		if (this.sort.key === key) {
			if (this.sort.dir === 1) this.sort = { key, dir: -1 };
			else this.sort = { key: "order", dir: 1 };
		} else {
			this.sort = { key, dir: key === "value" ? -1 : 1 };
		}
		for (const [k, btn] of this.headButtons) {
			const active = this.sort.key === k;
			const label = btn.textContent?.replace(/ [↑↓]$/, "") ?? "";
			btn.textContent = active ? `${label} ${this.sort.dir === 1 ? "↑" : "↓"}` : label;
			btn.setAttr("aria-sort", active ? (this.sort.dir === 1 ? "ascending" : "descending") : "none");
		}
		this.recompute();
	}

	private recompute(): void {
		const doc = this.host.controller.doc;
		this.labels = new Map(doc.nodes.map((n) => [n.id, n.label]));
		const label = (id: string) => this.labels.get(id) ?? id;
		let rows = doc.flows;
		if (this.search) {
			const q = this.search;
			rows = rows.filter((f) => label(f.source).toLowerCase().includes(q) || label(f.target).toLowerCase().includes(q) || (f.label ?? "").toLowerCase().includes(q));
		}
		if (this.sort.key !== "order") {
			const { key, dir } = this.sort;
			const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
			rows = [...rows].sort((a, b) => {
				if (key === "value") return (a.value - b.value) * dir;
				return collator.compare(label(a[key]), label(b[key])) * dir;
			});
		}
		this.rows = rows;
		const total = doc.flows.length;
		this.countEl.setText(this.search ? `${rows.length} of ${total}` : `${total} flow${total === 1 ? "" : "s"}`);
		this.body.setCssProps({ "--sankey-flow-table-height": `${rows.length * ROW_HEIGHT}px` });
		this.emptyEl.toggle(!rows.length);
		this.emptyEl.setText(total ? "No flows match your search." : "No flows yet. Add one below, or import a CSV file.");
		this.updateDatalist();
		this.renderRows();
	}

	private updateDatalist(): void {
		const labels = [...new Set(this.labels.values())].sort((a, b) => a.localeCompare(b));
		const key = labels.join("\u0000");
		if (key === this.datalistKey) return;
		this.datalistKey = key;
		this.datalist.replaceChildren(...labels.map((l) => createEl("option", { attr: { value: l } })));
	}

	private scheduleRows(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.renderRows();
		});
	}

	private renderRows(): void {
		const height = this.scroller.clientHeight || 400;
		const start = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
		const end = Math.min(this.rows.length, Math.ceil((this.scroller.scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
		const needed = end - start;
		while (this.pool.length < needed) this.pool.push(this.createRow(this.listId));
		const sel = this.host.controller.selection;
		const format = { prefix: "", suffix: "", decimals: null };

		this.pool.forEach((row, i) => {
			const flow = this.rows[start + i];
			if (!flow || i >= needed) {
				if (row.el.isConnected && !row.el.contains(document.activeElement)) row.el.remove();
				row.flowId = null;
				return;
			}
			if (!row.el.isConnected) this.body.appendChild(row.el);
			const sameRow = row.flowId === flow.id;
			row.flowId = flow.id;
			row.el.setCssProps({ "--sankey-flow-row-top": `${(start + i) * ROW_HEIGHT}px` });
			row.el.setAttr("aria-rowindex", String(start + i + 2));
			row.el.toggleClass("is-selected", sel?.kind === "flow" && sel.id === flow.id);
			const invalid = !(Number.isFinite(flow.value) && flow.value > 0) || flow.source === flow.target;
			row.el.toggleClass("is-invalid", invalid);
			row.el.setAttr("title", invalid ? "This flow is not drawn: values must be positive and source and target must differ." : "");
			this.setInput(row.source, this.labels.get(flow.source) ?? flow.source, sameRow);
			this.setInput(row.target, this.labels.get(flow.target) ?? flow.target, sameRow);
			this.setInput(row.value, Number.isFinite(flow.value) ? String(flow.value) : "", sameRow);
			row.value.setAttr("aria-label", `Value, ${formatValue(flow.value, format)}`);
		});
	}

	/** Updates an input unless the user is typing in it. */
	private setInput(input: HTMLInputElement, value: string, sameRow: boolean): void {
		if (sameRow && document.activeElement === input) return;
		if (input.value !== value) input.value = value;
	}

	private createRow(listId: string): RowEls {
		const el = createDiv("sankey-flow-table-row");
		el.setAttr("role", "row");
		const row: RowEls = {
			el,
			source: el.createEl("input", { type: "text", attr: { list: listId, "aria-label": "Source", spellcheck: "false" } }),
			target: el.createEl("input", { type: "text", attr: { list: listId, "aria-label": "Target", spellcheck: "false" } }),
			value: el.createEl("input", { type: "text", cls: "sankey-flow-cell-value", attr: { inputmode: "decimal", "aria-label": "Value" } }),
			flowId: null,
		};
		const menu = el.createDiv("sankey-flow-row-menu clickable-icon");
		setIcon(menu, "more-vertical");
		menu.setAttr("aria-label", "Row actions");
		menu.setAttr("tabindex", "0");

		const controller = this.host.controller;
		const endpoint = (input: HTMLInputElement, end: "source" | "target") => {
			input.addEventListener("change", () => {
				const id = row.flowId;
				const label = input.value.trim();
				if (!id) return;
				if (!label) {
					this.renderRows();
					return;
				}
				controller.update(end === "source" ? "Change flow source" : "Change flow target", (d) => setFlowEndpointByLabel(d, id, end, label));
			});
		};
		endpoint(row.source, "source");
		endpoint(row.target, "target");

		row.value.addEventListener("input", () => {
			const id = row.flowId;
			if (!id) return;
			const value = parseNumber(row.value.value, this.host.plugin.settings.decimalFormat);
			row.el.toggleClass("is-invalid", value === null || value <= 0);
			if (value === null) return;
			controller.update("Change flow value", (d) => updateFlow(d, id, { value }), { coalesce: `value:${id}` });
		});
		row.value.addEventListener("blur", () => {
			controller.seal();
			this.renderRows();
		});

		el.addEventListener("focusin", () => {
			if (row.flowId) this.host.select({ kind: "flow", id: row.flowId }, { origin: "table" });
		});
		el.addEventListener("mouseenter", () => row.flowId && this.host.hover({ kind: "flow", id: row.flowId }));
		el.addEventListener("mouseleave", () => this.host.hover(null));
		el.addEventListener("keydown", (e) => this.onRowKey(e, row));
		const openMenu = (e: MouseEvent) => {
			if (row.flowId) this.host.openFlowMenu(row.flowId, e);
		};
		menu.addEventListener("click", openMenu);
		menu.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				const rect = menu.getBoundingClientRect();
				openMenu(new MouseEvent("click", { clientX: rect.left, clientY: rect.bottom }));
			}
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openMenu(e);
		});
		return row;
	}

	/** Up/down arrows move between rows in the same column, like a spreadsheet. */
	private onRowKey(e: KeyboardEvent, row: RowEls): void {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
		const target = e.target as HTMLInputElement;
		const column = target === row.source ? "source" : target === row.target ? "target" : target === row.value ? "value" : null;
		if (!column || !row.flowId) return;
		const index = this.rows.findIndex((f) => f.id === row.flowId);
		const next = this.rows[index + (e.key === "ArrowDown" ? 1 : -1)];
		if (!next) return;
		e.preventDefault();
		target.dispatchEvent(new Event("change"));
		this.scrollToFlow(next.id);
		window.requestAnimationFrame(() => {
			const els = this.pool.find((r) => r.flowId === next.id);
			els?.[column].focus();
			els?.[column].select();
		});
	}

	private scrollToFlow(id: string): void {
		const index = this.rows.findIndex((f) => f.id === id);
		if (index < 0) return;
		const top = index * ROW_HEIGHT;
		const view = this.scroller.clientHeight - 30;
		if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
		else if (top + ROW_HEIGHT > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_HEIGHT - view;
		this.renderRows();
	}

	/** The always-visible "new flow" row at the bottom of the table. */
	private buildAddRow(listId: string): void {
		const wrap = this.el.createDiv("sankey-flow-table-row sankey-flow-add-row");
		wrap.setAttr("aria-label", "Add a flow");
		const source = wrap.createEl("input", { type: "text", attr: { list: listId, placeholder: "Source", "aria-label": "New flow source" } });
		const target = wrap.createEl("input", { type: "text", attr: { list: listId, placeholder: "Target", "aria-label": "New flow target" } });
		const value = wrap.createEl("input", { type: "text", cls: "sankey-flow-cell-value", attr: { placeholder: "Value", inputmode: "decimal", "aria-label": "New flow value" } });
		const add = wrap.createDiv("clickable-icon");
		setIcon(add, "plus");
		add.setAttr("aria-label", "Add flow");
		add.setAttr("tabindex", "0");

		const submit = () => {
			const s = source.value.trim();
			const t = target.value.trim();
			const v = parseNumber(value.value || "1", this.host.plugin.settings.decimalFormat);
			if (!s || !t) {
				(s ? target : source).focus();
				return;
			}
			if (v === null || v <= 0) {
				value.focus();
				value.select();
				return;
			}
			let created: string | null = null;
			this.host.controller.update("Add flow", (d) => {
				const a = ensureNode(d, s);
				const b = ensureNode(d, t);
				created = addFlow(d, a.id, b.id, v).id;
			});
			target.value = "";
			value.value = "";
			target.focus();
			if (created) this.scrollToFlow(created);
		};
		for (const input of [source, target, value]) {
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
		}
		add.addEventListener("click", submit);
		add.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				submit();
			}
		});
	}

	destroy(): void {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
	}
}
