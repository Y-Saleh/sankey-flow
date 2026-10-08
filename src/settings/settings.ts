import type { Alignment, ColorMode, FlowColorMode } from "../model/schema";
import type { CsvDelimiter } from "../data/csv";
import type { DecimalFormat } from "../data/numbers";

export type NodeBorder = "none" | "subtle" | "strong";
export type WheelBehaviour = "zoom" | "mod-zoom" | "off";
export type EmbedClick = "open-link" | "select";
export type InsertStyle = "embed" | "codeblock";
export type ExportBackground = "theme" | "transparent";

export interface SankeySettings {
	// General
	diagramFolder: string;
	openDiagramsInEditor: boolean;
	autosave: boolean;
	autosaveDelay: number;
	defaultAlign: Alignment;
	embedHeight: number;
	insertStyle: InsertStyle;
	showRibbonIcon: boolean;
	updateLinksOnRename: boolean;

	// Appearance
	colorMode: ColorMode;
	flowColorMode: FlowColorMode;
	accentColor: string;
	defaultNodeColor: string;
	defaultFlowColor: string;
	customPaletteLight: string;
	customPaletteDark: string;
	flowOpacity: number;
	flowHoverOpacity: number;
	nodeWidth: number;
	nodePadding: number;
	nodeCornerRadius: number;
	nodeBorder: NodeBorder;
	showLabels: boolean;
	showValues: boolean;
	animations: boolean;

	// Interaction
	editorWheel: WheelBehaviour;
	embedWheel: WheelBehaviour;
	embedPan: boolean;
	showTooltips: boolean;
	highlightOnHover: boolean;
	embedClick: EmbedClick;

	// Import / export
	csvDelimiter: CsvDelimiter;
	decimalFormat: DecimalFormat;
	sourceColumnNames: string;
	targetColumnNames: string;
	valueColumnNames: string;
	mergeDuplicateFlows: boolean;
	exportFolder: string;
	pngScale: number;
	exportBackground: ExportBackground;

	// Performance
	largeDiagramThreshold: number;
	layoutIterations: number;

	// Advanced
	debugLogging: boolean;
	enableDataview: boolean;
}

export const DEFAULT_SETTINGS: SankeySettings = {
	diagramFolder: "Sankey",
	openDiagramsInEditor: true,
	autosave: true,
	autosaveDelay: 1000,
	defaultAlign: "justify",
	embedHeight: 360,
	insertStyle: "embed",
	showRibbonIcon: true,
	updateLinksOnRename: true,

	colorMode: "categorical",
	flowColorMode: "source",
	accentColor: "",
	defaultNodeColor: "",
	defaultFlowColor: "",
	customPaletteLight: "#4c6ef5, #12b886, #f59f00, #e8590c, #ae3ec9, #1098ad",
	customPaletteDark: "#748ffc, #38d9a9, #ffc078, #ff8787, #da77f2, #66d9e8",
	flowOpacity: 0.32,
	flowHoverOpacity: 0.62,
	nodeWidth: 12,
	nodePadding: 16,
	nodeCornerRadius: 2,
	nodeBorder: "none",
	showLabels: true,
	showValues: true,
	animations: true,

	editorWheel: "mod-zoom",
	embedWheel: "mod-zoom",
	embedPan: true,
	showTooltips: true,
	highlightOnHover: true,
	embedClick: "open-link",

	csvDelimiter: "auto",
	decimalFormat: "auto",
	sourceColumnNames: "source, from, origin",
	targetColumnNames: "target, to, destination",
	valueColumnNames: "value, amount, weight, count, quantity",
	mergeDuplicateFlows: true,
	exportFolder: "",
	pngScale: 2,
	exportBackground: "theme",

	largeDiagramThreshold: 800,
	layoutIterations: 6,

	debugLogging: false,
	enableDataview: true,
};

/** Merges stored data over defaults, discarding values of the wrong type. */
export function mergeSettings(stored: unknown): SankeySettings {
	const out: SankeySettings = { ...DEFAULT_SETTINGS };
	if (!stored || typeof stored !== "object") return out;
	const record = stored as Record<string, unknown>;
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SankeySettings)[]) {
		const value = record[key];
		if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return out;
}

export function splitNames(text: string): string[] {
	return text
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
