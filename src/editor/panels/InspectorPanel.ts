import { ButtonComponent, Notice, Setting } from "obsidian";
import type { ChangeEvent } from "../DiagramController";
import type { SankeyFlow, SankeyNode } from "../../model/schema";
import { addFlow, flowById, nodeById, nodeTotals, removeFlow, removeNode, updateFlow, updateNode } from "../../model/operations";
import { canonicalLink } from "../../model/linkValue";
import { normalizeHex } from "../../model/colorValue";
import { parseNumber } from "../../data/numbers";
import { formatValue } from "../../render/format";
import { LinkSuggest } from "../../obsidian/LinkSuggest";
import { openLink } from "../../obsidian/links";
import { hasFocusWithin, type Panel, type PanelHost } from "./types";

/** Theme colours offered as quick picks; stored as CSS variables so they follow the theme. */
const COLOR_CHIPS: [string, string][] = [
	["var(--color-red)", "Red"],
	["var(--color-orange)", "Orange"],
	["var(--color-yellow)", "Yellow"],
	["var(--color-green)", "Green"],
	["var(--color-cyan)", "Cyan"],
	["var(--color-blue)", "Blue"],
	["var(--color-purple)", "Purple"],
	["var(--color-pink)", "Pink"],
	["var(--text-muted)", "Grey"],
];

export class InspectorPanel implements Panel {
	readonly el: HTMLElement;
	private readonly scroll: HTMLElement;
	private pending = false;
	private shownKey = "";

	constructor(
		parent: HTMLElement,
		private readonly host: PanelHost,
	) {
		this.el = parent.createDiv("sankey-flow-panel");
		this.scroll = this.el.createDiv("sankey-flow-panel-scroll sankey-flow-inspector sankey-flow-stack");
		this.el.addEventListener("focusout", (e) => {
			if (this.pending && !this.el.contains(e.relatedTarget as Node | null)) {
				this.pending = false;
				window.setTimeout(() => this.render(), 0);
			}
		});
		this.render();
	}

	refresh(event: ChangeEvent): void {
		const sel = this.host.controller.selection;
		const key = sel ? `${sel.kind}:${sel.id}` : "";
		if (event.kind !== "selection" && key === this.shownKey && hasFocusWithin(this.el)) {
			this.pending = true;
			return;
		}
		this.render();
	}

	/** Focuses the first field (used after "Edit node" or adding a node). */
	focusFirstField(): void {
		const input = this.scroll.querySelector<HTMLInputElement>("input[type=text], textarea");
		input?.focus();
		input?.select();
	}

	private render(): void {
		const scrollTop = this.scroll.scrollTop;
		this.scroll.empty();
		const sel = this.host.controller.selection;
		const doc = this.host.controller.doc;
		this.shownKey = sel ? `${sel.kind}:${sel.id}` : "";
		if (sel?.kind === "node") {
			const node = nodeById(doc, sel.id);
			if (node) this.renderNode(node);
		} else if (sel?.kind === "flow") {
			const flow = flowById(doc, sel.id);
			if (flow) this.renderFlow(flow);
		}
		if (!this.scroll.hasChildNodes()) this.renderEmpty();
		this.scroll.scrollTop = scrollTop;
	}

	private renderEmpty(): void {
		const el = this.scroll;
		el.createDiv({ cls: "sankey-flow-inspector-heading", text: "Nothing selected" });
		el.createEl("p", { cls: "sankey-flow-hint", text: "Click a node or flow in the diagram to edit it here." });
		const tips = el.createEl("ul", { cls: "sankey-flow-hint" });
		for (const tip of [
			"Drag a node to move it; its position is remembered.",
			"Drag from the small circle on a node's right edge to create a flow. Drop on empty space to create a new node.",
			"Right-click a node or flow for more actions.",
			"Ctrl/Cmd-click a linked node to open its note.",
			"With the diagram focused: arrow keys select nodes, Enter edits, Delete removes, +/− zoom, 0 fits.",
		]) {
			tips.createEl("li", { text: tip });
		}
	}

	private heading(text: string, color?: string): void {
		const h = this.scroll.createDiv("sankey-flow-inspector-heading");
		if (color) h.createDiv("sankey-flow-swatch").style.background = color;
		h.createSpan({ text });
	}

	private renderNode(node: SankeyNode): void {
		const { controller, plugin } = this.host;
		const doc = controller.doc;
		const config = plugin.renderConfig(doc, "editor");
		const totals = nodeTotals(doc).get(node.id) ?? { incoming: 0, outgoing: 0 };
		const id = node.id;
		this.heading(node.label, this.host.nodeColor(id));
		this.scroll.createDiv({
			cls: "sankey-flow-inspector-sub",
			text: `In ${formatValue(totals.incoming, config.format)} · Out ${formatValue(totals.outgoing, config.format)}`,
		});

		new Setting(this.scroll).setName("Name").addText((t) => {
			t.setValue(node.label);
			t.inputEl.addEventListener("input", () => {
				const label = t.getValue().trim();
				if (label) controller.update("Rename node", (d) => updateNode(d, id, { label }), { coalesce: `label:${id}` });
			});
		});

		this.linkSetting(node.link ?? "", (link) => controller.update(link ? "Set node link" : "Remove node link", (d) => updateNode(d, id, { link })));

		const groups = [...new Set(doc.nodes.map((n) => n.group).filter((g): g is string => !!g))];
		new Setting(this.scroll)
			.setName("Group")
			.setDesc("Nodes in the same group share a colour in categorical mode.")
			.addText((t) => {
				const listId = `sankey-flow-groups-${id}`;
				const list = this.scroll.createEl("datalist", { attr: { id: listId } });
				for (const g of groups) list.createEl("option", { attr: { value: g } });
				t.inputEl.setAttr("list", listId);
				t.setPlaceholder("None").setValue(node.group ?? "");
				t.inputEl.addEventListener("change", () => controller.update("Set node group", (d) => updateNode(d, id, { group: t.getValue().trim() || null })));
			});

		new Setting(this.scroll).setName("Description").addTextArea((t) => {
			t.setPlaceholder("Shown in the tooltip").setValue(node.description ?? "");
			t.inputEl.addEventListener("input", () =>
				controller.update("Edit description", (d) => updateNode(d, id, { description: t.getValue() }), { coalesce: `desc:${id}` }),
			);
		});

		this.colorSetting(node.color ?? null, (color) => controller.update("Change node colour", (d) => updateNode(d, id, { color })));

		if (node.position) {
			new Setting(this.scroll)
				.setName("Position")
				.setDesc("Pinned where you dragged it.")
				.addButton((b) =>
					b.setButtonText("Unpin").onClick(() => controller.update("Unpin node", (d) => updateNode(d, id, { position: null }))),
				);
		}

		this.connections(node);
		this.addFlowControls(node);

		const danger = this.scroll.createDiv("sankey-flow-panel-footer");
		danger.style.borderTop = "none";
		danger.style.paddingLeft = "0";
		new ButtonComponent(danger)
			.setButtonText("Delete node")
			.setWarning()
			.onClick(() => {
				controller.update("Delete node", (d) => removeNode(d, id));
				this.host.select(null);
			});
	}

	private connections(node: SankeyNode): void {
		const doc = this.host.controller.doc;
		const config = this.host.plugin.renderConfig(doc, "editor");
		const label = (id: string) => nodeById(doc, id)?.label ?? id;
		const section = (title: string, flows: SankeyFlow[], other: (f: SankeyFlow) => string, arrow: string) => {
			if (!flows.length) return;
			this.scroll.createDiv({ cls: "sankey-flow-section-title", text: `${title} (${flows.length})` });
			const list = this.scroll.createDiv("sankey-flow-connection-list");
			for (const f of [...flows].sort((a, b) => b.value - a.value)) {
				const row = list.createDiv("sankey-flow-connection");
				row.tabIndex = 0;
				row.setAttr("role", "button");
				row.createDiv({ cls: "sankey-flow-connection-label", text: `${arrow} ${label(other(f))}` });
				row.createDiv({ cls: "sankey-flow-connection-value", text: formatValue(f.value, config.format) });
				const go = () => this.host.select({ kind: "flow", id: f.id }, { inspect: true });
				row.addEventListener("click", go);
				row.addEventListener("keydown", (e) => e.key === "Enter" && go());
				row.addEventListener("mouseenter", () => this.host.hover({ kind: "flow", id: f.id }));
				row.addEventListener("mouseleave", () => this.host.hover(null));
			}
		};
		section("Incoming", doc.flows.filter((f) => f.target === node.id), (f) => f.source, "←");
		section("Outgoing", doc.flows.filter((f) => f.source === node.id), (f) => f.target, "→");
	}

	private addFlowControls(node: SankeyNode): void {
		const doc = this.host.controller.doc;
		const others = doc.nodes.filter((n) => n.id !== node.id);
		if (!others.length) return;
		this.scroll.createDiv({ cls: "sankey-flow-section-title", text: "Add outgoing flow" });
		let target = others[0].id;
		let value = 10;
		new Setting(this.scroll)
			.addDropdown((d) => {
				for (const n of others) d.addOption(n.id, n.label);
				d.setValue(target).onChange((v) => (target = v));
			})
			.addText((t) => {
				t.inputEl.addClass("sankey-flow-cell-value");
				t.inputEl.style.width = "80px";
				t.setValue(String(value)).onChange((v) => (value = parseNumber(v) ?? NaN));
			})
			.addButton((b) =>
				b.setIcon("plus").setTooltip("Add flow").onClick(() => {
					if (!(value > 0)) {
						new Notice("Enter a value greater than zero.");
						return;
					}
					let id = "";
					this.host.controller.update("Add flow", (d) => (id = addFlow(d, node.id, target, value).id));
					this.host.select({ kind: "flow", id }, { inspect: true });
				}),
			);
	}

	private renderFlow(flow: SankeyFlow): void {
		const { controller } = this.host;
		const doc = controller.doc;
		const id = flow.id;
		const label = (nid: string) => nodeById(doc, nid)?.label ?? nid;
		this.heading(`${label(flow.source)} → ${label(flow.target)}`);
		if (!(flow.value > 0) || flow.source === flow.target) {
			this.scroll.createDiv({
				cls: "sankey-flow-inspector-sub mod-warning",
				text: "This flow is not drawn: the value must be greater than zero and the source and target must differ.",
			});
		}

		const endpoint = (name: string, key: "source" | "target") =>
			new Setting(this.scroll).setName(name).addDropdown((d) => {
				for (const n of doc.nodes) d.addOption(n.id, n.label);
				d.setValue(flow[key]).onChange((v) => controller.update(`Change flow ${key}`, (dd) => updateFlow(dd, id, { [key]: v })));
			});
		endpoint("Source", "source");
		endpoint("Target", "target");

		new Setting(this.scroll).setName("Value").addText((t) => {
			t.inputEl.setAttr("inputmode", "decimal");
			t.setValue(String(flow.value));
			t.inputEl.addEventListener("input", () => {
				const v = parseNumber(t.getValue(), this.host.plugin.settings.decimalFormat);
				t.inputEl.toggleClass("is-invalid", v === null);
				if (v !== null) controller.update("Change flow value", (d) => updateFlow(d, id, { value: v }), { coalesce: `value:${id}` });
			});
			t.inputEl.addEventListener("blur", () => controller.seal());
		});

		new Setting(this.scroll).setName("Label").addText((t) => {
			t.setPlaceholder("Optional").setValue(flow.label ?? "");
			t.inputEl.addEventListener("input", () =>
				controller.update("Edit flow label", (d) => updateFlow(d, id, { label: t.getValue() }), { coalesce: `flabel:${id}` }),
			);
		});
		new Setting(this.scroll).setName("Description").addTextArea((t) => {
			t.setPlaceholder("Shown in the tooltip").setValue(flow.description ?? "");
			t.inputEl.addEventListener("input", () =>
				controller.update("Edit description", (d) => updateFlow(d, id, { description: t.getValue() }), { coalesce: `fdesc:${id}` }),
			);
		});
		this.linkSetting(flow.link ?? "", (link) => controller.update(link ? "Set flow link" : "Remove flow link", (d) => updateFlow(d, id, { link })));
		this.colorSetting(flow.color ?? null, (color) => controller.update("Change flow colour", (d) => updateFlow(d, id, { color })));

		const actions = this.scroll.createDiv("sankey-flow-panel-footer");
		actions.style.borderTop = "none";
		actions.style.paddingLeft = "0";
		new ButtonComponent(actions)
			.setButtonText("Swap direction")
			.onClick(() => controller.update("Swap flow direction", (d) => updateFlow(d, id, { source: flow.target, target: flow.source })));
		new ButtonComponent(actions)
			.setButtonText("Delete flow")
			.setWarning()
			.onClick(() => {
				controller.update("Delete flow", (d) => removeFlow(d, id));
				this.host.select(null);
			});
	}

	/** Link field with note/heading/block suggestions and an "open" button. */
	private linkSetting(current: string, commit: (link: string | null) => void): void {
		const setting = new Setting(this.scroll).setName("Link").setDesc("A note, heading, block, canvas, attachment or URL.");
		setting.addText((t) => {
			t.setPlaceholder("[[Note]] or https://…").setValue(current);
			const apply = (value: string) => {
				const trimmed = value.trim();
				if (!trimmed) return commit(null);
				const link = canonicalLink(trimmed);
				if (!link) {
					new Notice("That link is not supported. Use a note name, [[wikilink]] or an http(s) URL.");
					t.setValue(current);
					return;
				}
				commit(link);
			};
			new LinkSuggest(this.host.plugin.app, t.inputEl, () => this.host.sourcePath(), apply);
			t.inputEl.addEventListener("change", () => apply(t.getValue()));
		});
		if (current) {
			setting.addExtraButton((b) =>
				b
					.setIcon("arrow-up-right")
					.setTooltip("Open link (Ctrl/Cmd-click for a new tab)")
					.onClick(() => void openLink(this.host.plugin.app, current, this.host.sourcePath(), false)),
			);
			setting.addExtraButton((b) => b.setIcon("x").setTooltip("Remove link").onClick(() => commit(null)));
		}
	}

	private colorSetting(current: string | null, commit: (color: string | null) => void): void {
		const setting = new Setting(this.scroll).setName("Colour");
		const row = setting.controlEl.createDiv("sankey-flow-color-row");
		const auto = row.createEl("button", { text: "Auto", cls: current ? "" : "mod-cta" });
		auto.setAttr("aria-pressed", String(!current));
		auto.addEventListener("click", () => commit(null));
		for (const [value, name] of COLOR_CHIPS) {
			const chip = row.createEl("button", { cls: "sankey-flow-color-chip", attr: { "aria-label": name, "aria-pressed": String(current === value) } });
			chip.style.background = value;
			chip.toggleClass("is-active", current === value);
			chip.addEventListener("click", () => commit(value));
		}
		const custom = row.createEl("input", { type: "color", attr: { "aria-label": "Custom colour" } });
		custom.value = (current && normalizeHex(current)) ?? "#808080";
		custom.addEventListener("change", () => commit(custom.value));
	}
}
