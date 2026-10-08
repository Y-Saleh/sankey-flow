import { ALIGNMENTS, COLOR_MODES, createEmptyDocument, type Alignment, type ColorMode, type SankeyDocument } from "../model/schema";
import type { ValidationIssue } from "../model/validate";
import { isSafeColor } from "../model/colorValue";
import { findNodeByLabel } from "../model/operations";
import { parseNumber } from "./numbers";
import { appendRows, parseCell, type ImportRow } from "./tableImport";

/**
 * The `sankey` code block accepts four forms:
 *
 * 1. A reference to a diagram file, with optional display options:
 *        diagram: [[Sankey/Energy flow]]
 *        height: 420
 *
 * 2. Lightweight inline flows (two interchangeable notations):
 *        Coal -> Electricity: 50
 *        Gas [30] Electricity          (SankeyMATIC style)
 *        :Electricity #c08a3e          (node colour)
 *
 * 3. Full diagram JSON (this is how diagram files store their data).
 *
 * 4. A Dataview query (optional integration):
 *        query: TABLE from, to, amount FROM "Finance"
 *        source: from
 *        target: to
 *        value: amount
 */

export interface BlockOptions {
	height?: number;
	/** Text to show as a caption, or false to hide the diagram title. */
	title?: string | false;
	align?: Alignment;
	showValues?: boolean;
	valuePrefix?: string;
	valueSuffix?: string;
	colorMode?: ColorMode;
}

export interface DataviewColumns {
	source?: string;
	target?: string;
	value?: string;
	label?: string;
}

export type BlockSpec =
	| { kind: "empty"; options: BlockOptions; issues: ValidationIssue[] }
	| { kind: "reference"; target: string; options: BlockOptions; issues: ValidationIssue[] }
	| { kind: "json"; json: string; options: BlockOptions; issues: ValidationIssue[] }
	| { kind: "inline"; doc: SankeyDocument; options: BlockOptions; issues: ValidationIssue[] }
	| { kind: "dataview"; query: string; columns: DataviewColumns; options: BlockOptions; issues: ValidationIssue[] };

const OPTION_LINE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const ARROW = /\s*(?:->|→|=>)\s*/;
const SANKEYMATIC = /^(.*?)\s+\[([^[\]]+)\]\s+(.+)$/;
const NODE_COLOR = /^:(.+?)\s+(#[0-9a-fA-F]{3,8}|[a-z]+)\s*$/;

const OPTION_KEYS = new Set([
	"diagram",
	"file",
	"height",
	"title",
	"align",
	"values",
	"prefix",
	"suffix",
	"unit",
	"colors",
	"colours",
	"query",
	"source",
	"target",
	"value",
	"label",
]);

/** Removes one pair of surrounding quotes, so `suffix: " kWh"` can carry spaces. */
function unquote(v: string): string {
	const t = v.trim();
	return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

function parseBool(v: string): boolean | undefined {
	const t = v.trim().toLowerCase();
	if (["true", "yes", "on", "show", "1"].includes(t)) return true;
	if (["false", "no", "off", "hide", "0"].includes(t)) return false;
	return undefined;
}

export function parseBlock(source: string): BlockSpec {
	const trimmed = source.trim();
	const issues: ValidationIssue[] = [];
	if (!trimmed) return { kind: "empty", options: {}, issues };
	if (trimmed.startsWith("{")) return { kind: "json", json: trimmed, options: {}, issues };

	const options: BlockOptions = {};
	const raw = new Map<string, string>();
	const rows: ImportRow[] = [];
	const colors: { label: string; color: string; line: number }[] = [];
	const lines = source.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const line = lines[i].trim();
		if (!line || line.startsWith("//") || line.startsWith("%%")) continue;

		const option = OPTION_LINE.exec(line);
		if (option && OPTION_KEYS.has(option[1].toLowerCase()) && !ARROW.test(line)) {
			const key = option[1].toLowerCase();
			let value = option[2].trim();
			if (key === "query") {
				// Indented continuation lines belong to a multi-line query.
				while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += "\n" + lines[++i].trim();
			}
			raw.set(key, value);
			continue;
		}

		const color = NODE_COLOR.exec(line);
		if (color) {
			if (isSafeColor(color[2])) colors.push({ label: color[1].trim(), color: color[2], line: lineNo });
			else issues.push({ level: "warning", message: `Line ${lineNo}: "${color[2]}" is not a supported colour.` });
			continue;
		}

		const row = parseFlowLine(line, lineNo, issues);
		if (row) rows.push(row);
	}

	applyOptions(raw, options, issues);

	const target = raw.get("diagram") ?? raw.get("file");
	if (target) {
		if (rows.length) issues.push({ level: "warning", message: "Flows listed below a `diagram:` reference are ignored." });
		return { kind: "reference", target, options, issues };
	}
	const query = raw.get("query");
	if (query) {
		const columns: DataviewColumns = {};
		for (const key of ["source", "target", "value", "label"] as const) {
			const v = raw.get(key);
			if (v) columns[key] = v;
		}
		return { kind: "dataview", query, columns, options, issues };
	}
	if (!rows.length) {
		if (!issues.length) {
			issues.push({ level: "error", message: "No flows found. Write lines like `Coal -> Electricity: 50`." });
		}
		return { kind: "empty", options, issues };
	}

	const doc = createEmptyDocument(typeof options.title === "string" ? options.title : "");
	appendRows(doc, rows, true);
	for (const { label, color, line } of colors) {
		const node = findNodeByLabel(doc, parseCell(label).label);
		if (node) node.color = color;
		else issues.push({ level: "warning", message: `Line ${line}: no node called "${label}".` });
	}
	if (options.align) doc.layout.align = options.align;
	return { kind: "inline", doc, options, issues };
}

function parseFlowLine(line: string, lineNo: number, issues: ValidationIssue[]): ImportRow | null {
	let sourceText: string;
	let targetText: string;
	let valueText: string;

	const arrowMatch = ARROW.exec(line);
	if (arrowMatch) {
		sourceText = line.slice(0, arrowMatch.index);
		const rest = line.slice(arrowMatch.index + arrowMatch[0].length);
		const colon = rest.lastIndexOf(":");
		if (colon < 0) {
			issues.push({ level: "error", message: `Line ${lineNo}: missing value — write \`${line}: 10\`.` });
			return null;
		}
		targetText = rest.slice(0, colon);
		valueText = rest.slice(colon + 1);
	} else {
		const m = SANKEYMATIC.exec(line);
		if (!m) {
			issues.push({ level: "error", message: `Line ${lineNo}: could not understand "${line}".` });
			return null;
		}
		[, sourceText, valueText, targetText] = m;
	}

	const source = parseCell(sourceText);
	const target = parseCell(targetText);
	const value = parseNumber(valueText);
	if (!source.label || !target.label) {
		issues.push({ level: "error", message: `Line ${lineNo}: missing source or target.` });
		return null;
	}
	if (value === null) {
		issues.push({ level: "error", message: `Line ${lineNo}: "${valueText.trim()}" is not a number.` });
		return null;
	}
	if (value <= 0) {
		issues.push({ level: "warning", message: `Line ${lineNo}: value must be greater than zero; skipped.` });
		return null;
	}
	return { rowNumber: lineNo, source, target, value };
}

function applyOptions(raw: Map<string, string>, options: BlockOptions, issues: ValidationIssue[]): void {
	const height = raw.get("height");
	if (height !== undefined) {
		const n = parseNumber(height.replace(/px$/i, ""));
		if (n !== null && n >= 120 && n <= 4000) options.height = n;
		else issues.push({ level: "warning", message: `Height "${height}" must be between 120 and 4000.` });
	}
	const title = raw.get("title");
	if (title !== undefined) options.title = parseBool(title) === false ? false : title;
	const align = raw.get("align");
	if (align !== undefined) {
		if ((ALIGNMENTS as readonly string[]).includes(align)) options.align = align as Alignment;
		else issues.push({ level: "warning", message: `Unknown align "${align}". Use ${ALIGNMENTS.join(", ")}.` });
	}
	const values = raw.get("values");
	if (values !== undefined) options.showValues = parseBool(values);
	const prefix = raw.get("prefix");
	if (prefix !== undefined) options.valuePrefix = unquote(prefix);
	const suffix = raw.get("suffix") ?? raw.get("unit");
	if (suffix !== undefined) {
		const quoted = /^(["']).*\1$/.test(suffix.trim());
		const text = unquote(suffix);
		// "TWh" reads as a unit and gets a space ("50 TWh"); "%" or a quoted value is used verbatim.
		options.valueSuffix = !quoted && /^[\p{L}]/u.test(text) ? ` ${text}` : text;
	}
	const colors = raw.get("colors") ?? raw.get("colours");
	if (colors !== undefined) {
		if ((COLOR_MODES as readonly string[]).includes(colors)) options.colorMode = colors as ColorMode;
		else issues.push({ level: "warning", message: `Unknown colour mode "${colors}". Use ${COLOR_MODES.join(", ")}.` });
	}
}

/** Builds the code block text that references a diagram file. */
export function referenceBlock(linktext: string, height?: number): string {
	const lines = [`diagram: [[${linktext}]]`];
	if (height) lines.push(`height: ${height}`);
	return "```sankey\n" + lines.join("\n") + "\n```";
}
