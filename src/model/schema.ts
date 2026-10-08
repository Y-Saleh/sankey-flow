/**
 * The Sankey Flow document schema.
 *
 * A diagram is a plain JSON object. It lives inside a fenced `sankey` code
 * block of a Markdown note (see storage/diagramFile.ts), which keeps it
 * readable, diffable and fully portable. This module only describes the
 * shape; validation and migration live in ./validate.ts.
 *
 * Forward compatibility: unknown properties on the document, on nodes and on
 * flows are preserved verbatim when a file is loaded and saved again. Third
 * parties may store their own data under `extensions["their-id"]`.
 */

export const FORMAT_ID = "sankey-flow";
export const SCHEMA_VERSION = 1;

/** Node position in normalised layout space: 0..1 on both axes. */
export interface NodePosition {
	x: number;
	y: number;
}

export interface SankeyNode {
	/** Stable identifier, unique within the document. */
	id: string;
	/** Display label. */
	label: string;
	/** Explicit CSS colour (`#rrggbb` etc). Absent or null: automatic. */
	color?: string | null;
	/** Optional category, used by the "categorical" colour mode. */
	group?: string | null;
	/** Free-text description shown in tooltips. */
	description?: string;
	/** Obsidian wikilink (`[[Note#Heading]]`) or external URL. */
	link?: string | null;
	/** Manually pinned position. Absent or null: automatic layout. */
	position?: NodePosition | null;
	[extra: string]: unknown;
}

export interface SankeyFlow {
	/** Stable identifier, unique within the document. */
	id: string;
	/** Source node id. */
	source: string;
	/** Target node id. */
	target: string;
	/** Flow magnitude. Must be a finite number > 0 to be drawn. */
	value: number;
	label?: string;
	color?: string | null;
	description?: string;
	link?: string | null;
	[extra: string]: unknown;
}

export type Alignment = "justify" | "left" | "right" | "center";
export const ALIGNMENTS: readonly Alignment[] = ["justify", "left", "right", "center"];

export type ColorMode = "accent" | "categorical" | "sequential" | "custom";
export const COLOR_MODES: readonly ColorMode[] = ["accent", "categorical", "sequential", "custom"];

export type FlowColorMode = "source" | "target" | "gradient" | "neutral";
export const FLOW_COLOR_MODES: readonly FlowColorMode[] = ["source", "target", "gradient", "neutral"];

/**
 * Per-diagram display overrides. Every field is optional: when absent, the
 * plugin-wide setting is used, so diagrams follow the user's preferences
 * unless they were deliberately customised.
 */
export interface DisplaySettings {
	colorMode?: ColorMode;
	flowColorMode?: FlowColorMode;
	showLabels?: boolean;
	showValues?: boolean;
	valuePrefix?: string;
	valueSuffix?: string;
	/** Fixed number of decimals for values; absent = automatic. */
	decimals?: number;
	/** Node thickness in px. */
	nodeWidth?: number;
	/** Vertical gap between nodes in px. */
	nodePadding?: number;
	/** Height of embedded renderings in px. */
	height?: number;
	[extra: string]: unknown;
}

export interface LayoutSettings {
	align: Alignment;
	/** Relaxation passes; more = smoother but slower. */
	iterations: number;
	[extra: string]: unknown;
}

export interface DiagramMeta {
	title: string;
	description: string;
	/** ISO-8601 timestamps. */
	created?: string;
	modified?: string;
	[extra: string]: unknown;
}

export interface SankeyDocument {
	type: typeof FORMAT_ID;
	version: typeof SCHEMA_VERSION;
	meta: DiagramMeta;
	nodes: SankeyNode[];
	flows: SankeyFlow[];
	display: DisplaySettings;
	layout: LayoutSettings;
	/** Namespaced storage for integrations: `{ "plugin-id": {...} }`. */
	extensions: Record<string, unknown>;
	[extra: string]: unknown;
}

export const DEFAULT_LAYOUT: LayoutSettings = { align: "justify", iterations: 6 };

export function createEmptyDocument(title: string, now: Date = new Date()): SankeyDocument {
	const stamp = now.toISOString();
	return {
		type: FORMAT_ID,
		version: SCHEMA_VERSION,
		meta: { title, description: "", created: stamp, modified: stamp },
		nodes: [],
		flows: [],
		display: {},
		layout: { ...DEFAULT_LAYOUT },
		extensions: {},
	};
}

/** True when the flow can be drawn (finite, positive, between two distinct nodes). */
export function isDrawableFlow(flow: SankeyFlow): boolean {
	return Number.isFinite(flow.value) && flow.value > 0 && flow.source !== flow.target;
}
