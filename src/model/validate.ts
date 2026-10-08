import {
	ALIGNMENTS,
	COLOR_MODES,
	DEFAULT_LAYOUT,
	FLOW_COLOR_MODES,
	FORMAT_ID,
	SCHEMA_VERSION,
	type Alignment,
	type DisplaySettings,
	type LayoutSettings,
	type NodePosition,
	type SankeyDocument,
	type SankeyFlow,
	type SankeyNode,
} from "./schema";
import { randomId, slugify, uniqueId } from "./ids";
import { isSafeColor } from "./colorValue";
import { isAllowedLink } from "./linkValue";

export type FormatErrorKind = "syntax" | "newer-version" | "invalid";

/** A diagram that cannot be loaded at all. The message is user-facing. */
export class SankeyFormatError extends Error {
	constructor(
		message: string,
		readonly kind: FormatErrorKind,
	) {
		super(message);
		this.name = "SankeyFormatError";
	}
}

export interface ValidationIssue {
	level: "warning" | "error";
	message: string;
}

export interface NormalizeResult {
	doc: SankeyDocument;
	issues: ValidationIssue[];
	/** Schema version the input was migrated from, or null when already current. */
	migratedFrom: number | null;
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return fallback;
}

function asFiniteNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value.trim());
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Copies every property of `raw` that is not listed in `known`. */
function extras(raw: Raw, known: readonly string[]): Raw {
	const out: Raw = {};
	for (const key of Object.keys(raw)) {
		if (!known.includes(key)) out[key] = raw[key];
	}
	return out;
}

/** Parses diagram JSON text. Throws {@link SankeyFormatError} when unusable. */
export function parseDocument(text: string): NormalizeResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		throw new SankeyFormatError(`The diagram data is not valid JSON (${detail}).`, "syntax");
	}
	return normalizeDocument(raw);
}

/**
 * Validates and normalises any JSON value into a current-version document.
 * Recoverable problems are fixed and reported as issues; data is never
 * silently discarded without an issue explaining what happened.
 */
export function normalizeDocument(input: unknown): NormalizeResult {
	if (!isRecord(input)) {
		throw new SankeyFormatError("The diagram data must be a JSON object.", "invalid");
	}
	const issues: ValidationIssue[] = [];
	let raw = input;
	let migratedFrom: number | null = null;

	const version = raw.version;
	if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 0)) {
		throw new SankeyFormatError(`Unrecognised schema version ${JSON.stringify(version)}.`, "invalid");
	}
	if (typeof version === "number" && version > SCHEMA_VERSION) {
		throw new SankeyFormatError(
			`This file uses a newer Sankey schema version (${version}) than this plugin supports (${SCHEMA_VERSION}). Update Sankey Flow to open it. The file has not been modified.`,
			"newer-version",
		);
	}
	if (version === undefined || version === 0) {
		raw = migrateV0(raw, issues);
		migratedFrom = 0;
	}

	const nodes = normalizeNodes(raw.nodes, issues);
	const nodeIds = new Set(nodes.map((n) => n.id));
	const flows = normalizeFlows(raw.flows, nodes, nodeIds, issues);

	const metaRaw = isRecord(raw.meta) ? raw.meta : {};
	const meta = {
		...extras(metaRaw, ["title", "description", "created", "modified"]),
		title: asString(metaRaw.title),
		description: asString(metaRaw.description),
		...(typeof metaRaw.created === "string" ? { created: metaRaw.created } : {}),
		...(typeof metaRaw.modified === "string" ? { modified: metaRaw.modified } : {}),
	};

	const doc: SankeyDocument = {
		...extras(raw, ["type", "version", "meta", "nodes", "flows", "display", "layout", "extensions"]),
		type: FORMAT_ID,
		version: SCHEMA_VERSION,
		meta,
		nodes,
		flows,
		display: normalizeDisplay(raw.display, issues),
		layout: normalizeLayout(raw.layout, issues),
		extensions: isRecord(raw.extensions) ? raw.extensions : {},
	};
	return { doc, issues, migratedFrom };
}

/**
 * Version 0 is any unversioned input. This covers the common D3 shape
 * `{ nodes: [{ name }], links: [{ source: 0, target: 1, value }] }` where
 * endpoints may be indices, ids or names.
 */
function migrateV0(raw: Raw, issues: ValidationIssue[]): Raw {
	const rawNodes: unknown[] = Array.isArray(raw.nodes) ? raw.nodes : [];
	const rawFlows: unknown[] = Array.isArray(raw.flows) ? raw.flows : Array.isArray(raw.links) ? raw.links : [];

	const taken = new Set<string>();
	const nodes: Raw[] = rawNodes.map((n, index) => {
		const node: Raw = isRecord(n) ? { ...n } : { label: asString(n) };
		const label = asString(node.label, asString(node.name, asString(node.id, `Node ${index + 1}`)));
		const id = uniqueId(asString(node.id) || slugify(label), taken);
		taken.add(id);
		delete node.name;
		return { ...node, id, label };
	});

	const resolveEndpoint = (value: unknown): unknown => {
		if (typeof value === "number" && Number.isInteger(value) && nodes[value]) return nodes[value].id;
		if (typeof value === "string") {
			const byId = nodes.find((n) => n.id === value);
			if (byId) return byId.id;
			const byLabel = nodes.find((n) => n.label === value);
			if (byLabel) return byLabel.id;
		}
		if (isRecord(value)) return resolveEndpoint(value.id ?? value.name ?? value.index);
		return value;
	};

	const flows = rawFlows.map((f) => {
		if (!isRecord(f)) return f;
		return { ...f, source: resolveEndpoint(f.source), target: resolveEndpoint(f.target) };
	});

	if (rawNodes.length || rawFlows.length) {
		issues.push({ level: "warning", message: "Converted unversioned diagram data to schema version 1." });
	}
	const { links: _links, ...rest } = raw;
	return { ...rest, nodes, flows, meta: raw.meta ?? { title: asString(raw.name ?? raw.title) } };
}

const NODE_KEYS = ["id", "label", "color", "group", "description", "link", "position"] as const;

function normalizeNodes(value: unknown, issues: ValidationIssue[]): SankeyNode[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push({ level: "error", message: "\"nodes\" is not a list; it was ignored." });
		return [];
	}
	const taken = new Set<string>();
	const out: SankeyNode[] = [];
	value.forEach((entry, index) => {
		if (!isRecord(entry)) {
			issues.push({ level: "warning", message: `Node #${index + 1} is not an object and was skipped.` });
			return;
		}
		const label = asString(entry.label, asString(entry.id, `Node ${index + 1}`));
		let id = asString(entry.id).trim() || slugify(label);
		if (taken.has(id)) {
			const fresh = uniqueId(id, taken);
			issues.push({
				level: "warning",
				message: `Duplicate node id "${id}" — the second node ("${label}") was renamed to "${fresh}". Flows using "${id}" point at the first node.`,
			});
			id = fresh;
		}
		taken.add(id);
		const node: SankeyNode = { ...extras(entry, NODE_KEYS), id, label };
		const color = normalizeColor(entry.color, `node "${label}"`, issues);
		if (color) node.color = color;
		if (typeof entry.group === "string" && entry.group.trim()) node.group = entry.group.trim();
		if (typeof entry.description === "string" && entry.description) node.description = entry.description;
		const link = normalizeLink(entry.link, `node "${label}"`, issues);
		if (link) node.link = link;
		const position = normalizePosition(entry.position);
		if (position) node.position = position;
		out.push(node);
	});
	return out;
}

const FLOW_KEYS = ["id", "source", "target", "value", "label", "color", "description", "link"] as const;

function normalizeFlows(
	value: unknown,
	nodes: SankeyNode[],
	nodeIds: Set<string>,
	issues: ValidationIssue[],
): SankeyFlow[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push({ level: "error", message: "\"flows\" is not a list; it was ignored." });
		return [];
	}
	const taken = new Set<string>();
	const out: SankeyFlow[] = [];
	value.forEach((entry, index) => {
		if (!isRecord(entry)) {
			issues.push({ level: "warning", message: `Flow #${index + 1} is not an object and was skipped.` });
			return;
		}
		const source = asString(entry.source).trim();
		const target = asString(entry.target).trim();
		if (!source || !target) {
			issues.push({ level: "warning", message: `Flow #${index + 1} has no source or target and was skipped.` });
			return;
		}
		for (const endpoint of [source, target]) {
			if (!nodeIds.has(endpoint)) {
				nodes.push({ id: endpoint, label: endpoint });
				nodeIds.add(endpoint);
				issues.push({ level: "warning", message: `Flow #${index + 1} referenced missing node "${endpoint}"; the node was created.` });
			}
		}
		let numeric = asFiniteNumber(entry.value);
		if (numeric === null) {
			issues.push({
				level: "error",
				message: `Flow ${source} → ${target} has a non-numeric value (${JSON.stringify(entry.value ?? null)}); it was set to 0.`,
			});
			numeric = 0;
		} else if (numeric < 0) {
			issues.push({ level: "warning", message: `Flow ${source} → ${target} has a negative value (${numeric}) and will not be drawn.` });
		}
		if (source === target) {
			issues.push({ level: "warning", message: `Flow ${source} → ${target} connects a node to itself and will not be drawn.` });
		}
		let id = asString(entry.id).trim();
		if (!id || taken.has(id)) id = randomId("f-", taken);
		taken.add(id);

		const flow: SankeyFlow = { ...extras(entry, FLOW_KEYS), id, source, target, value: numeric };
		if (typeof entry.label === "string" && entry.label) flow.label = entry.label;
		if (typeof entry.description === "string" && entry.description) flow.description = entry.description;
		const color = normalizeColor(entry.color, `flow ${source} → ${target}`, issues);
		if (color) flow.color = color;
		const link = normalizeLink(entry.link, `flow ${source} → ${target}`, issues);
		if (link) flow.link = link;
		out.push(flow);
	});
	return out;
}

function normalizeColor(value: unknown, owner: string, issues: ValidationIssue[]): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value === "string" && isSafeColor(value)) return value.trim();
	issues.push({ level: "warning", message: `Ignored unsupported colour ${JSON.stringify(value)} on ${owner}.` });
	return null;
}

function normalizeLink(value: unknown, owner: string, issues: ValidationIssue[]): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value === "string" && isAllowedLink(value)) return value.trim();
	issues.push({ level: "warning", message: `Ignored unsupported link ${JSON.stringify(value)} on ${owner}.` });
	return null;
}

function normalizePosition(value: unknown): NodePosition | null {
	if (!isRecord(value)) return null;
	const x = asFiniteNumber(value.x);
	const y = asFiniteNumber(value.y);
	if (x === null || y === null) return null;
	const clamp = (n: number) => Math.min(1, Math.max(0, n));
	return { x: clamp(x), y: clamp(y) };
}

const DISPLAY_KEYS = [
	"colorMode",
	"flowColorMode",
	"showLabels",
	"showValues",
	"valuePrefix",
	"valueSuffix",
	"decimals",
	"nodeWidth",
	"nodePadding",
	"height",
] as const;

function normalizeDisplay(value: unknown, issues: ValidationIssue[]): DisplaySettings {
	if (!isRecord(value)) return {};
	const out: DisplaySettings = { ...extras(value, DISPLAY_KEYS) };
	if (typeof value.colorMode === "string" && (COLOR_MODES as readonly string[]).includes(value.colorMode)) {
		out.colorMode = value.colorMode as DisplaySettings["colorMode"];
	}
	if (typeof value.flowColorMode === "string" && (FLOW_COLOR_MODES as readonly string[]).includes(value.flowColorMode)) {
		out.flowColorMode = value.flowColorMode as DisplaySettings["flowColorMode"];
	}
	if (typeof value.showLabels === "boolean") out.showLabels = value.showLabels;
	if (typeof value.showValues === "boolean") out.showValues = value.showValues;
	if (typeof value.valuePrefix === "string") out.valuePrefix = value.valuePrefix;
	if (typeof value.valueSuffix === "string") out.valueSuffix = value.valueSuffix;
	const decimals = asFiniteNumber(value.decimals);
	if (decimals !== null) out.decimals = Math.min(10, Math.max(0, Math.round(decimals)));
	const ranged = (key: "nodeWidth" | "nodePadding" | "height", min: number, max: number) => {
		const n = asFiniteNumber(value[key]);
		if (n === null) return;
		if (n < min || n > max) {
			issues.push({ level: "warning", message: `Display setting "${key}" (${n}) was clamped to ${min}–${max}.` });
		}
		out[key] = Math.min(max, Math.max(min, n));
	};
	ranged("nodeWidth", 2, 80);
	ranged("nodePadding", 0, 120);
	ranged("height", 120, 4000);
	return out;
}

function normalizeLayout(value: unknown, issues: ValidationIssue[]): LayoutSettings {
	if (!isRecord(value)) return { ...DEFAULT_LAYOUT };
	const out: LayoutSettings = { ...extras(value, ["align", "iterations"]), ...DEFAULT_LAYOUT };
	if (typeof value.align === "string") {
		if ((ALIGNMENTS as readonly string[]).includes(value.align)) out.align = value.align as Alignment;
		else issues.push({ level: "warning", message: `Unknown layout alignment "${value.align}"; using "justify".` });
	}
	const iterations = asFiniteNumber(value.iterations);
	if (iterations !== null) out.iterations = Math.min(32, Math.max(0, Math.round(iterations)));
	return out;
}
