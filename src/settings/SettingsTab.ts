import { App, PluginSettingTab, Setting } from "obsidian";
import type SankeyFlowPlugin from "../main";
import { SCHEMA_VERSION } from "../model/schema";
import { isSafeColor, parsePalette } from "../model/colorValue";
import { getDataviewApi } from "../data/dataview";
import { DEFAULT_SETTINGS, type SankeySettings } from "./settings";

export class SankeySettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SankeyFlowPlugin,
	) {
		super(app, plugin);
	}

	private async set<K extends keyof SankeySettings>(key: K, value: SankeySettings[K]): Promise<void> {
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// ── General ──────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Diagram folder")
			.setDesc("Where new diagrams are created. Diagrams are ordinary notes and can be moved anywhere afterwards.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.diagramFolder)
					.setValue(s.diagramFolder)
					.onChange((v) => this.set("diagramFolder", v.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.diagramFolder)),
			);
		new Setting(containerEl)
			.setName("Open diagrams in the Sankey editor")
			.setDesc("Opening a diagram note shows the visual editor. Use “Open as Markdown” in the editor to see the note itself.")
			.addToggle((t) => t.setValue(s.openDiagramsInEditor).onChange((v) => this.set("openDiagramsInEditor", v)));
		new Setting(containerEl)
			.setName("Autosave")
			.setDesc("Save edits automatically. When off, edits are saved when you click the status indicator or close the diagram.")
			.addToggle((t) => t.setValue(s.autosave).onChange((v) => this.set("autosave", v)));
		new Setting(containerEl)
			.setName("Autosave delay")
			.setDesc("Milliseconds to wait after the last edit before writing to disk.")
			.addSlider((sl) =>
				sl
					.setLimits(250, 5000, 250)
					.setValue(s.autosaveDelay)
					.setDynamicTooltip()
					.onChange((v) => this.set("autosaveDelay", v)),
			);
		new Setting(containerEl)
			.setName("Default layout")
			.setDesc("Alignment for new diagrams.")
			.addDropdown((d) =>
				d
					.addOptions({ justify: "Justify", left: "Left", right: "Right", center: "Centre" })
					.setValue(s.defaultAlign)
					.onChange((v) => this.set("defaultAlign", v as SankeySettings["defaultAlign"])),
			);
		new Setting(containerEl)
			.setName("Default embed height")
			.setDesc("Height of diagrams embedded in notes, in pixels. Individual diagrams and code blocks can override it.")
			.addSlider((sl) =>
				sl
					.setLimits(160, 1000, 20)
					.setValue(s.embedHeight)
					.setDynamicTooltip()
					.onChange((v) => this.set("embedHeight", v)),
			);
		new Setting(containerEl)
			.setName("Insert diagrams as")
			.setDesc("Used by “Insert diagram into current note”.")
			.addDropdown((d) =>
				d
					.addOptions({ embed: "Embed link  ![[Diagram]]", codeblock: "Code block  ```sankey diagram: …```" })
					.setValue(s.insertStyle)
					.onChange((v) => this.set("insertStyle", v as SankeySettings["insertStyle"])),
			);
		new Setting(containerEl)
			.setName("Update links on rename")
			.setDesc("When a note linked from a diagram is renamed or moved, update the diagram's links. When a diagram is renamed, update `diagram:` references in code blocks.")
			.addToggle((t) => t.setValue(s.updateLinksOnRename).onChange((v) => this.set("updateLinksOnRename", v)));
		new Setting(containerEl)
			.setName("Show ribbon icon")
			.addToggle((t) =>
				t.setValue(s.showRibbonIcon).onChange(async (v) => {
					await this.set("showRibbonIcon", v);
					this.plugin.updateRibbon();
				}),
			);

		// ── Appearance ───────────────────────────────────────────────────
		new Setting(containerEl).setName("Appearance").setHeading();
		new Setting(containerEl)
			.setName("Node colours")
			.setDesc("Categorical: distinct theme colours per node (or per group). Accent: shades of your accent colour. Sequential: a gradient from left to right. Custom: your palettes below.")
			.addDropdown((d) =>
				d
					.addOptions({ categorical: "Categorical", accent: "Accent shades", sequential: "Sequential", custom: "Custom palette" })
					.setValue(s.colorMode)
					.onChange((v) => this.set("colorMode", v as SankeySettings["colorMode"])),
			);
		new Setting(containerEl)
			.setName("Flow colours")
			.addDropdown((d) =>
				d
					.addOptions({ source: "From source node", target: "From target node", gradient: "Gradient", neutral: "Neutral" })
					.setValue(s.flowColorMode)
					.onChange((v) => this.set("flowColorMode", v as SankeySettings["flowColorMode"])),
			);
		this.colorText(containerEl, "Accent colour", "Base for accent shades and the first categorical colour. Empty uses your theme's accent.", "accentColor");
		this.colorText(containerEl, "Default node colour", "Use one colour for every node that has no colour of its own. Empty means automatic.", "defaultNodeColor");
		this.colorText(containerEl, "Default flow colour", "Use one colour for all flows. Empty derives flow colours from nodes.", "defaultFlowColor");
		this.palette(containerEl, "Custom palette (light mode)", "customPaletteLight");
		this.palette(containerEl, "Custom palette (dark mode)", "customPaletteDark");
		new Setting(containerEl)
			.setName("Flow opacity")
			.addSlider((sl) =>
				sl
					.setLimits(0.1, 0.9, 0.02)
					.setValue(s.flowOpacity)
					.setDynamicTooltip()
					.onChange((v) => this.set("flowOpacity", v)),
			);
		new Setting(containerEl)
			.setName("Highlighted flow opacity")
			.setDesc("Opacity of flows connected to the hovered node.")
			.addSlider((sl) =>
				sl
					.setLimits(0.2, 1, 0.02)
					.setValue(s.flowHoverOpacity)
					.setDynamicTooltip()
					.onChange((v) => this.set("flowHoverOpacity", v)),
			);
		new Setting(containerEl)
			.setName("Node width")
			.addSlider((sl) =>
				sl
					.setLimits(4, 40, 1)
					.setValue(s.nodeWidth)
					.setDynamicTooltip()
					.onChange((v) => this.set("nodeWidth", v)),
			);
		new Setting(containerEl)
			.setName("Node spacing")
			.addSlider((sl) =>
				sl
					.setLimits(0, 60, 1)
					.setValue(s.nodePadding)
					.setDynamicTooltip()
					.onChange((v) => this.set("nodePadding", v)),
			);
		new Setting(containerEl)
			.setName("Node corner radius")
			.addSlider((sl) =>
				sl
					.setLimits(0, 10, 1)
					.setValue(s.nodeCornerRadius)
					.setDynamicTooltip()
					.onChange((v) => this.set("nodeCornerRadius", v)),
			);
		new Setting(containerEl).setName("Node borders").addDropdown((d) =>
			d
				.addOptions({ none: "None", subtle: "Subtle", strong: "Strong" })
				.setValue(s.nodeBorder)
				.onChange((v) => this.set("nodeBorder", v as SankeySettings["nodeBorder"])),
		);
		new Setting(containerEl).setName("Show labels").addToggle((t) => t.setValue(s.showLabels).onChange((v) => this.set("showLabels", v)));
		new Setting(containerEl).setName("Show values").addToggle((t) => t.setValue(s.showValues).onChange((v) => this.set("showValues", v)));
		new Setting(containerEl)
			.setName("Animations")
			.setDesc("Animate changes to the diagram. Always off when your system asks for reduced motion.")
			.addToggle((t) => t.setValue(s.animations).onChange((v) => this.set("animations", v)));

		// ── Interaction ──────────────────────────────────────────────────
		new Setting(containerEl).setName("Interaction").setHeading();
		const wheel = { "mod-zoom": "Ctrl/Cmd + scroll zooms", zoom: "Scroll zooms", off: "Off" };
		new Setting(containerEl)
			.setName("Zoom in the editor")
			.setDesc("With “Ctrl/Cmd + scroll”, plain scrolling pans the diagram, like Canvas.")
			.addDropdown((d) =>
				d
					.addOptions(wheel)
					.setValue(s.editorWheel)
					.onChange((v) => this.set("editorWheel", v as SankeySettings["editorWheel"])),
			);
		new Setting(containerEl)
			.setName("Zoom in embedded diagrams")
			.setDesc("“Ctrl/Cmd + scroll” keeps normal scrolling of the note working.")
			.addDropdown((d) =>
				d
					.addOptions(wheel)
					.setValue(s.embedWheel)
					.onChange((v) => this.set("embedWheel", v as SankeySettings["embedWheel"])),
			);
		new Setting(containerEl)
			.setName("Pan embedded diagrams")
			.setDesc("Drag the background of an embedded diagram to pan it (mouse and pen only, so touch scrolling still works).")
			.addToggle((t) => t.setValue(s.embedPan).onChange((v) => this.set("embedPan", v)));
		new Setting(containerEl).setName("Tooltips").addToggle((t) => t.setValue(s.showTooltips).onChange((v) => this.set("showTooltips", v)));
		new Setting(containerEl)
			.setName("Highlight on hover")
			.setDesc("Dim everything not connected to the hovered node or flow.")
			.addToggle((t) => t.setValue(s.highlightOnHover).onChange((v) => this.set("highlightOnHover", v)));
		new Setting(containerEl)
			.setName("Clicking a linked node in a note")
			.setDesc("In the editor, Ctrl/Cmd-click always opens the link.")
			.addDropdown((d) =>
				d
					.addOptions({ "open-link": "Opens the link", select: "Only highlights it (Ctrl/Cmd-click opens)" })
					.setValue(s.embedClick)
					.onChange((v) => this.set("embedClick", v as SankeySettings["embedClick"])),
			);

		// ── Import / export ──────────────────────────────────────────────
		new Setting(containerEl).setName("Import and export").setHeading();
		new Setting(containerEl).setName("CSV delimiter").addDropdown((d) =>
			d
				.addOptions({ auto: "Detect automatically", ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" })
				.setValue(s.csvDelimiter)
				.onChange((v) => this.set("csvDelimiter", v as SankeySettings["csvDelimiter"])),
		);
		new Setting(containerEl).setName("Number format").addDropdown((d) =>
			d
				.addOptions({ auto: "Detect automatically", dot: "1,234.5", comma: "1.234,5" })
				.setValue(s.decimalFormat)
				.onChange((v) => this.set("decimalFormat", v as SankeySettings["decimalFormat"])),
		);
		const names = (name: string, key: "sourceColumnNames" | "targetColumnNames" | "valueColumnNames") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc("Comma-separated column names recognised automatically when importing.")
				.addText((t) => t.setValue(s[key]).onChange((v) => this.set(key, v)));
		names("Source column names", "sourceColumnNames");
		names("Target column names", "targetColumnNames");
		names("Value column names", "valueColumnNames");
		new Setting(containerEl)
			.setName("Combine duplicate flows")
			.setDesc("When importing, rows with the same source and target are added together.")
			.addToggle((t) => t.setValue(s.mergeDuplicateFlows).onChange((v) => this.set("mergeDuplicateFlows", v)));
		new Setting(containerEl)
			.setName("Export folder")
			.setDesc("Where exported files are saved. Empty saves next to the diagram or note.")
			.addText((t) => t.setPlaceholder("Next to the diagram").setValue(s.exportFolder).onChange((v) => this.set("exportFolder", v.trim())));
		new Setting(containerEl)
			.setName("PNG resolution")
			.setDesc("Scale factor for PNG exports.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 4, 0.5)
					.setValue(s.pngScale)
					.setDynamicTooltip()
					.onChange((v) => this.set("pngScale", v)),
			);
		new Setting(containerEl).setName("Export background").addDropdown((d) =>
			d
				.addOptions({ theme: "Theme background", transparent: "Transparent" })
				.setValue(s.exportBackground)
				.onChange((v) => this.set("exportBackground", v as SankeySettings["exportBackground"])),
		);

		// ── Performance ──────────────────────────────────────────────────
		new Setting(containerEl).setName("Performance").setHeading();
		new Setting(containerEl)
			.setName("Large diagram threshold")
			.setDesc("Above this many flows, animations and gradients are turned off, layout uses fewer passes and labels of tiny nodes are hidden.")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(s.largeDiagramThreshold)).onChange((v) => {
					const n = Math.round(Number(v));
					if (n >= 50) void this.set("largeDiagramThreshold", n);
				});
			});
		new Setting(containerEl)
			.setName("Layout smoothing for new diagrams")
			.setDesc("Relaxation passes used by the automatic layout. Each diagram can change this in its Diagram tab.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 16, 1)
					.setValue(s.layoutIterations)
					.setDynamicTooltip()
					.onChange((v) => this.set("layoutIterations", v)),
			);

		// ── Advanced ─────────────────────────────────────────────────────
		new Setting(containerEl).setName("Advanced").setHeading();
		const dataview = getDataviewApi(this.app);
		new Setting(containerEl)
			.setName("Dataview queries (experimental)")
			.setDesc(
				dataview
					? "Allow `query:` in sankey code blocks to build diagrams from Dataview TABLE queries."
					: "Allow `query:` in sankey code blocks to build diagrams from Dataview TABLE queries. Dataview is not installed or enabled, so this has no effect right now.",
			)
			.addToggle((t) => t.setValue(s.enableDataview).onChange((v) => this.set("enableDataview", v)));
		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc("Write diagnostic messages to the developer console.")
			.addToggle((t) => t.setValue(s.debugLogging).onChange((v) => this.set("debugLogging", v)));
		new Setting(containerEl).setName("Diagram schema version").setDesc(`Diagrams are saved with schema version ${SCHEMA_VERSION}.`);
	}

	private colorText(el: HTMLElement, name: string, desc: string, key: "accentColor" | "defaultNodeColor" | "defaultFlowColor"): void {
		const setting = new Setting(el).setName(name).setDesc(desc);
		setting.addText((t) =>
			t
				.setPlaceholder("Automatic")
				.setValue(this.plugin.settings[key])
				.onChange((v) => {
					const value = v.trim();
					const valid = !value || isSafeColor(value);
					t.inputEl.toggleClass("is-invalid", !valid);
					if (valid) void this.set(key, value);
				}),
		);
		setting.addColorPicker((c) => {
			const current = this.plugin.settings[key];
			if (/^#[0-9a-f]{6}$/i.test(current)) c.setValue(current);
			c.onChange((v) => {
				void this.set(key, v);
				this.display();
			});
		});
	}

	private palette(el: HTMLElement, name: string, key: "customPaletteLight" | "customPaletteDark"): void {
		const setting = new Setting(el).setName(name).setDesc("Comma-separated colours used by the Custom palette mode.");
		const preview = setting.descEl.createDiv("sankey-flow-color-row");
		const draw = () => {
			preview.empty();
			for (const c of parsePalette(this.plugin.settings[key])) preview.createDiv("sankey-flow-color-chip").style.background = c;
		};
		draw();
		setting.addTextArea((t) =>
			t.setValue(this.plugin.settings[key]).onChange(async (v) => {
				await this.set(key, v);
				draw();
			}),
		);
	}
}
