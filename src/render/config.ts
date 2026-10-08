import type { Alignment, FlowColorMode, SankeyDocument } from "../model/schema";
import type { BlockOptions } from "../data/blockSyntax";
import { parsePalette } from "../model/colorValue";
import type { NodeBorder, SankeySettings, WheelBehaviour } from "../settings/settings";
import type { ColorContext } from "./colors";
import type { ValueFormat } from "./format";

/** Everything the renderer needs, resolved from plugin settings → diagram display → block options. */
export interface RenderConfig {
	colors: ColorContext;
	flowColorMode: FlowColorMode;
	defaultFlowColor: string;
	flowOpacity: number;
	flowHoverOpacity: number;
	nodeWidth: number;
	nodePadding: number;
	cornerRadius: number;
	border: NodeBorder;
	showLabels: boolean;
	showValues: boolean;
	format: ValueFormat;
	align: Alignment;
	iterations: number;
	animations: boolean;
	tooltips: boolean;
	highlight: boolean;
	wheel: WheelBehaviour;
	pan: boolean;
	largeThreshold: number;
}

export type RenderContext = "editor" | "embed";

export function resolveRenderConfig(
	settings: SankeySettings,
	doc: SankeyDocument,
	context: RenderContext,
	isDark: boolean,
	block: BlockOptions = {},
): RenderConfig {
	const d = doc.display;
	return {
		colors: {
			mode: block.colorMode ?? d.colorMode ?? settings.colorMode,
			isDark,
			accent: settings.accentColor,
			defaultNodeColor: settings.defaultNodeColor,
			customLight: parsePalette(settings.customPaletteLight),
			customDark: parsePalette(settings.customPaletteDark),
		},
		flowColorMode: d.flowColorMode ?? settings.flowColorMode,
		defaultFlowColor: settings.defaultFlowColor,
		flowOpacity: clamp(settings.flowOpacity, 0.05, 1),
		flowHoverOpacity: clamp(settings.flowHoverOpacity, 0.05, 1),
		nodeWidth: d.nodeWidth ?? settings.nodeWidth,
		nodePadding: d.nodePadding ?? settings.nodePadding,
		cornerRadius: settings.nodeCornerRadius,
		border: settings.nodeBorder,
		showLabels: d.showLabels ?? settings.showLabels,
		showValues: block.showValues ?? d.showValues ?? settings.showValues,
		format: {
			prefix: block.valuePrefix ?? d.valuePrefix ?? "",
			suffix: block.valueSuffix ?? d.valueSuffix ?? "",
			decimals: d.decimals ?? null,
		},
		align: block.align ?? doc.layout.align,
		iterations: doc.layout.iterations,
		animations: settings.animations,
		tooltips: settings.showTooltips,
		highlight: settings.highlightOnHover,
		wheel: context === "editor" ? settings.editorWheel : settings.embedWheel,
		pan: context === "editor" ? true : settings.embedPan,
		largeThreshold: settings.largeDiagramThreshold,
	};
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}
