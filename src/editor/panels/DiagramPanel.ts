import { Setting } from "obsidian";
import type { ChangeEvent } from "../DiagramController";
import type { DisplaySettings, SankeyDocument } from "../../model/schema";
import { clearPositions } from "../../model/operations";
import { hasFocusWithin, type Panel, type PanelHost } from "./types";

const INHERIT = "inherit";

/**
 * Per-diagram options. Anything left at "Default" follows the plugin
 * settings, so changing a global preference updates every such diagram.
 */
export class DiagramPanel implements Panel {
	readonly el: HTMLElement;
	private readonly scroll: HTMLElement;
	private pending = false;

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
		if (event.kind === "selection") return;
		if (hasFocusWithin(this.el)) {
			this.pending = true;
			return;
		}
		this.render();
	}

	private setDisplay<K extends keyof DisplaySettings>(label: string, key: K, value: DisplaySettings[K] | undefined, coalesce?: string): void {
		this.host.controller.update(
			label,
			(d) => {
				if (value === undefined) delete d.display[key];
				else d.display[key] = value;
			},
			coalesce ? { coalesce } : {},
		);
	}

	private update(label: string, mutate: (d: SankeyDocument) => void, coalesce?: string): void {
		this.host.controller.update(label, mutate, coalesce ? { coalesce } : {});
	}

	private render(): void {
		const top = this.scroll.scrollTop;
		this.scroll.empty();
		const doc = this.host.controller.doc;
		const settings = this.host.plugin.settings;
		const el = this.scroll;
		const d = doc.display;

		new Setting(el).setName("Title").addText((t) =>
			t
				.setPlaceholder("Untitled diagram")
				.setValue(doc.meta.title)
				.onChange((v) => this.update("Rename diagram", (x) => (x.meta.title = v), "title")),
		);
		new Setting(el).setName("Description").addTextArea((t) =>
			t.setValue(doc.meta.description).onChange((v) => this.update("Edit description", (x) => (x.meta.description = v), "meta-desc")),
		);

		new Setting(el).setName("Layout").setHeading();
		new Setting(el)
			.setName("Alignment")
			.setDesc("Where nodes without outgoing or incoming flows are placed.")
			.addDropdown((dd) =>
				dd
					.addOptions({ justify: "Justify (sinks on the right)", left: "Left", right: "Right", center: "Centre" })
					.setValue(doc.layout.align)
					.onChange((v) => this.update("Change alignment", (x) => (x.layout.align = v as SankeyDocument["layout"]["align"]))),
			);
		new Setting(el)
			.setName("Smoothing")
			.setDesc("Layout passes that straighten flows. Higher is smoother but slower on large diagrams.")
			.addSlider((s) =>
				s
					.setLimits(0, 16, 1)
					.setValue(doc.layout.iterations)
					.setDynamicTooltip()
					.onChange((v) => this.update("Change smoothing", (x) => (x.layout.iterations = v), "iterations")),
			);
		new Setting(el)
			.setName("Node width")
			.addSlider((s) =>
				s
					.setLimits(4, 40, 1)
					.setValue(d.nodeWidth ?? settings.nodeWidth)
					.setDynamicTooltip()
					.onChange((v) => this.setDisplay("Change node width", "nodeWidth", v, "nodeWidth")),
			);
		new Setting(el)
			.setName("Node spacing")
			.addSlider((s) =>
				s
					.setLimits(0, 60, 1)
					.setValue(d.nodePadding ?? settings.nodePadding)
					.setDynamicTooltip()
					.onChange((v) => this.setDisplay("Change node spacing", "nodePadding", v, "nodePadding")),
			);
		const pinned = doc.nodes.filter((n) => n.position).length;
		new Setting(el)
			.setName("Manual positions")
			.setDesc(pinned ? `${pinned} node${pinned === 1 ? " is" : "s are"} pinned where you dragged them.` : "No nodes are pinned.")
			.addButton((b) =>
				b
					.setButtonText("Reset layout")
					.setDisabled(!pinned)
					.onClick(() => this.update("Reset layout", clearPositions)),
			);

		new Setting(el).setName("Appearance").setHeading();
		new Setting(el).setName("Node colours").addDropdown((dd) =>
			dd
				.addOptions({
					[INHERIT]: `Default (${settings.colorMode})`,
					categorical: "Categorical",
					accent: "Accent shades",
					sequential: "Sequential",
					custom: "Custom palette",
				})
				.setValue(d.colorMode ?? INHERIT)
				.onChange((v) => this.setDisplay("Change colour mode", "colorMode", v === INHERIT ? undefined : (v as DisplaySettings["colorMode"]))),
		);
		new Setting(el).setName("Flow colours").addDropdown((dd) =>
			dd
				.addOptions({
					[INHERIT]: `Default (${settings.flowColorMode})`,
					source: "From source node",
					target: "From target node",
					gradient: "Gradient",
					neutral: "Neutral",
				})
				.setValue(d.flowColorMode ?? INHERIT)
				.onChange((v) => this.setDisplay("Change flow colours", "flowColorMode", v === INHERIT ? undefined : (v as DisplaySettings["flowColorMode"]))),
		);
		const tri = (name: string, key: "showLabels" | "showValues", fallback: boolean) =>
			new Setting(el).setName(name).addDropdown((dd) =>
				dd
					.addOptions({ [INHERIT]: `Default (${fallback ? "show" : "hide"})`, show: "Show", hide: "Hide" })
					.setValue(d[key] === undefined ? INHERIT : d[key] ? "show" : "hide")
					.onChange((v) => this.setDisplay(`Toggle ${name.toLowerCase()}`, key, v === INHERIT ? undefined : v === "show")),
			);
		tri("Labels", "showLabels", settings.showLabels);
		tri("Values", "showValues", settings.showValues);

		new Setting(el).setName("Value format").setHeading();
		new Setting(el)
			.setName("Prefix and suffix")
			.setDesc("For example “$” or “ TWh”.")
			.addText((t) =>
				t
					.setPlaceholder("Prefix")
					.setValue(d.valuePrefix ?? "")
					.onChange((v) => this.setDisplay("Change value prefix", "valuePrefix", v || undefined, "prefix")),
			)
			.addText((t) =>
				t
					.setPlaceholder("Suffix")
					.setValue(d.valueSuffix ?? "")
					.onChange((v) => this.setDisplay("Change value suffix", "valueSuffix", v || undefined, "suffix")),
			);
		new Setting(el).setName("Decimals").addDropdown((dd) =>
			dd
				.addOptions({ auto: "Automatic", "0": "0", "1": "1", "2": "2", "3": "3" })
				.setValue(d.decimals === undefined ? "auto" : String(d.decimals))
				.onChange((v) => this.setDisplay("Change decimals", "decimals", v === "auto" ? undefined : Number(v))),
		);

		new Setting(el).setName("Embedding").setHeading();
		new Setting(el)
			.setName("Embed height")
			.setDesc(`Height in notes, in pixels. Empty uses the default (${settings.embedHeight}).`)
			.addText((t) => {
				t.inputEl.type = "number";
				t.setPlaceholder(String(settings.embedHeight))
					.setValue(d.height ? String(d.height) : "")
					.onChange((v) => {
						const n = Number(v);
						this.setDisplay("Change embed height", "height", v && n >= 120 && n <= 4000 ? n : undefined, "height");
					});
			});
		this.scroll.scrollTop = top;
	}
}
