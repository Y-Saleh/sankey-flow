import { createEmptyDocument, type SankeyDocument } from "../model/schema";
import { addFlow, ensureNode } from "../model/operations";
import { parseLink } from "../model/linkValue";
import { parseNumber, type DecimalFormat } from "./numbers";

/** Tabular input from any source (CSV, Markdown table, Dataview, …). */
export interface RawTable {
	headers: string[];
	rows: string[][];
}

/** Column indices; -1 means "not mapped" (only allowed for optional roles). */
export interface ColumnMapping {
	source: number;
	target: number;
	value: number;
	label: number;
}

export interface ColumnSynonyms {
	source: string[];
	target: string[];
	value: string[];
	label: string[];
}

export const DEFAULT_SYNONYMS: ColumnSynonyms = {
	source: ["source", "from", "origin", "src", "start", "input"],
	target: ["target", "to", "destination", "dest", "end", "sink", "output"],
	value: ["value", "amount", "weight", "count", "quantity", "qty", "total", "size", "flow"],
	label: ["label", "flow label", "description", "note", "comment"],
};

export interface Cell {
	label: string;
	link: string | null;
}

export interface ImportRow {
	rowNumber: number;
	source: Cell;
	target: Cell;
	value: number;
	label?: string;
}

export interface RowProblem {
	rowNumber: number;
	message: string;
}

export interface ImportResult {
	rows: ImportRow[];
	problems: RowProblem[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/**
 * Suggests a mapping from header names, falling back to the column layout
 * (first two text columns → source/target, the most numeric column → value).
 */
export function guessMapping(table: RawTable, synonyms: ColumnSynonyms = DEFAULT_SYNONYMS): ColumnMapping {
	const headers = table.headers.map(norm);
	const used = new Set<number>();
	const find = (names: string[]) => {
		const wanted = names.map(norm);
		// Exact header matches win; then headers containing a synonym as a word ("Origin country").
		const matchers = [
			(h: string, name: string) => h === name,
			(h: string, name: string) => h.split(" ").includes(name),
		];
		for (const matches of matchers) {
			for (const name of wanted) {
				const idx = headers.findIndex((h, i) => !used.has(i) && matches(h, name));
				if (idx >= 0) {
					used.add(idx);
					return idx;
				}
			}
		}
		return -1;
	};
	const mapping: ColumnMapping = {
		source: find(synonyms.source),
		target: find(synonyms.target),
		value: find(synonyms.value),
		label: find(synonyms.label),
	};

	if (mapping.value < 0) {
		let best = -1;
		let bestCount = 0;
		for (let c = 0; c < table.headers.length; c++) {
			if (used.has(c)) continue;
			const numeric = table.rows.slice(0, 50).filter((r) => r[c] !== undefined && parseNumber(r[c]) !== null).length;
			if (numeric > bestCount) {
				bestCount = numeric;
				best = c;
			}
		}
		mapping.value = best;
		if (best >= 0) used.add(best);
	}
	for (const role of ["source", "target"] as const) {
		if (mapping[role] >= 0) continue;
		for (let c = 0; c < table.headers.length; c++) {
			if (!used.has(c)) {
				mapping[role] = c;
				used.add(c);
				break;
			}
		}
	}
	return mapping;
}

/** Heuristic for CSVs: the first row is a header if it is text where later rows are numeric. */
export function firstRowLooksLikeHeader(rows: string[][]): boolean {
	if (rows.length < 2) return true;
	const [first, ...rest] = rows;
	const sample = rest.slice(0, 10);
	for (let c = 0; c < first.length; c++) {
		const laterNumeric = sample.filter((r) => r[c] !== undefined && parseNumber(r[c]) !== null).length;
		if (laterNumeric >= Math.ceil(sample.length / 2) && parseNumber(first[c] ?? "") === null) return true;
	}
	return first.every((cell) => parseNumber(cell) === null) && new Set(first.map(norm)).size === first.length;
}

/** Splits CSV rows into a header + body table. */
export function tableFromRows(rows: string[][], hasHeader: boolean): RawTable {
	const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
	const pad = (r: string[]): string[] => (r.length < width ? [...r, ...new Array<string>(width - r.length).fill("")] : r);
	if (hasHeader && rows.length) {
		const headers = pad(rows[0]).map((h, i) => h.trim() || `Column ${i + 1}`);
		return { headers, rows: rows.slice(1).map(pad) };
	}
	return { headers: Array.from({ length: width }, (_, i) => `Column ${i + 1}`), rows: rows.map(pad) };
}

/**
 * Interprets a cell: wikilinks and Markdown links become linked nodes
 * (`[[Coal]]` → label "Coal", link "[[Coal]]"); anything else is plain text.
 */
export function parseCell(text: string): Cell {
	const raw = text.trim();
	if (/^!?\[\[.+\]\]$/.test(raw) || /^\[[^\]]*\]\(.+\)$/.test(raw)) {
		const parsed = parseLink(raw);
		if (parsed?.kind === "internal") {
			const path = parsed.linktext.split("#")[0];
			const label = parsed.alias ?? (path.split("/").pop() ?? path).replace(/\.md$/i, "");
			return { label: label || parsed.linktext, link: `[[${parsed.linktext}]]` };
		}
		if (parsed?.kind === "external") {
			const text = /^\[([^\]]*)\]/.exec(raw)?.[1];
			return { label: text || parsed.url, link: parsed.url };
		}
	}
	return { label: raw.replace(/^(\*\*|__|\*|_|`)(.*)\1$/, "$2").trim(), link: null };
}

export interface BuildOptions {
	decimal: DecimalFormat;
}

/** Validates every row against the mapping. Invalid rows are reported, never silently dropped. */
export function buildRows(table: RawTable, mapping: ColumnMapping, options: BuildOptions): ImportResult {
	const rows: ImportRow[] = [];
	const problems: RowProblem[] = [];
	const name = (i: number) => table.headers[i] ?? `Column ${i + 1}`;
	if (mapping.source < 0 || mapping.target < 0 || mapping.value < 0) {
		return { rows, problems: [{ rowNumber: 0, message: "Choose a column for Source, Target and Value." }] };
	}
	if (new Set([mapping.source, mapping.target, mapping.value]).size < 3) {
		return { rows, problems: [{ rowNumber: 0, message: "Source, Target and Value must be different columns." }] };
	}

	table.rows.forEach((cells, index) => {
		const rowNumber = index + 1;
		const source = parseCell(cells[mapping.source] ?? "");
		const target = parseCell(cells[mapping.target] ?? "");
		const rawValue = cells[mapping.value] ?? "";
		if (!source.label && !target.label && !rawValue.trim()) return;
		if (!source.label) {
			problems.push({ rowNumber, message: `Row ${rowNumber}: the ${name(mapping.source)} cell is empty.` });
			return;
		}
		if (!target.label) {
			problems.push({ rowNumber, message: `Row ${rowNumber}: the ${name(mapping.target)} cell is empty.` });
			return;
		}
		const value = parseNumber(rawValue, options.decimal);
		if (value === null) {
			problems.push({ rowNumber, message: `Row ${rowNumber}: "${rawValue}" in ${name(mapping.value)} is not a number.` });
			return;
		}
		if (value <= 0) {
			problems.push({ rowNumber, message: `Row ${rowNumber}: value ${value} must be greater than zero.` });
			return;
		}
		if (source.label === target.label) {
			problems.push({ rowNumber, message: `Row ${rowNumber}: "${source.label}" flows into itself.` });
			return;
		}
		const row: ImportRow = { rowNumber, source, target, value };
		const label = mapping.label >= 0 ? (cells[mapping.label] ?? "").trim() : "";
		if (label) row.label = label;
		rows.push(row);
	});
	return { rows, problems };
}

/**
 * A single sentence describing why an import failed or what was skipped,
 * e.g. "the selected Value column contains non-numeric values".
 */
export function summarizeProblems(result: ImportResult, table: RawTable, mapping: ColumnMapping): string | null {
	if (!result.problems.length) return null;
	if (result.problems[0].rowNumber === 0) return result.problems[0].message;
	if (!result.rows.length) {
		const allNumeric = result.problems.every((p) => p.message.includes("is not a number"));
		if (allNumeric) {
			return `The selected Value column (${table.headers[mapping.value]}) contains non-numeric values.`;
		}
		return `No usable rows: ${result.problems[0].message}`;
	}
	const n = result.problems.length;
	return `${n} row${n === 1 ? "" : "s"} will be skipped. First: ${result.problems[0].message}`;
}

/** Adds rows to a document. Duplicate source→target pairs are summed when `merge` is set. */
export function appendRows(doc: SankeyDocument, rows: readonly ImportRow[], merge: boolean): void {
	for (const row of rows) {
		const s = ensureNode(doc, row.source.label, row.source.link);
		const t = ensureNode(doc, row.target.label, row.target.link);
		const existing = merge ? doc.flows.find((f) => f.source === s.id && f.target === t.id) : undefined;
		if (existing) {
			existing.value += row.value;
		} else {
			addFlow(doc, s.id, t.id, row.value, row.label ? { label: row.label } : {});
		}
	}
}

export function documentFromRows(title: string, rows: readonly ImportRow[], merge = true): SankeyDocument {
	const doc = createEmptyDocument(title);
	appendRows(doc, rows, merge);
	return doc;
}
