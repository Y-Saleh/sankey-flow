import type { RawTable } from "./tableImport";

export interface TableLocation {
	/** First line (header) of the table, 0-based. */
	start: number;
	/** Last line of the table, inclusive. */
	end: number;
}

const SEPARATOR_CELL = /^\s*:?-{1,}:?\s*$/;

function looksLikeRow(line: string): boolean {
	const t = line.trim();
	return t.includes("|") && !/^(```|~~~)/.test(t);
}

function isSeparatorRow(line: string): boolean {
	const cells = splitRow(line);
	return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c));
}

/**
 * Splits a Markdown table row into cells. Handles optional outer pipes,
 * escaped pipes (`\|`) and pipes inside wikilinks (`[[Note|alias]]`) and
 * inline code.
 */
export function splitRow(line: string): string[] {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);

	const cells: string[] = [];
	let cell = "";
	let wikiDepth = 0;
	let inCode = false;
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (ch === "\\" && t[i + 1] === "|") {
			cell += "|";
			i++;
		} else if (ch === "`") {
			inCode = !inCode;
			cell += ch;
		} else if (!inCode && ch === "[" && t[i + 1] === "[") {
			wikiDepth++;
			cell += "[[";
			i++;
		} else if (!inCode && ch === "]" && t[i + 1] === "]" && wikiDepth > 0) {
			wikiDepth--;
			cell += "]]";
			i++;
		} else if (ch === "|" && wikiDepth === 0 && !inCode) {
			cells.push(cell.trim());
			cell = "";
		} else {
			cell += ch;
		}
	}
	cells.push(cell.trim());
	return cells;
}

/**
 * Finds the table containing `cursorLine`. If the cursor is on a blank line
 * directly below a table, that table is used, which matches the common
 * "just finished typing the table" case.
 */
export function findTableAt(lines: readonly string[], cursorLine: number): TableLocation | null {
	let line = cursorLine;
	if (line < 0 || line >= lines.length) return null;
	if (!looksLikeRow(lines[line]) && line > 0 && looksLikeRow(lines[line - 1]) && !lines[line].trim()) line--;
	if (!looksLikeRow(lines[line]) || insideFence(lines, line)) return null;

	let start = line;
	while (start > 0 && looksLikeRow(lines[start - 1])) start--;
	let end = line;
	while (end < lines.length - 1 && looksLikeRow(lines[end + 1])) end++;

	// A valid table has its separator row directly below the header.
	for (let s = start; s < end; s++) {
		if (isSeparatorRow(lines[s + 1])) return line >= s ? { start: s, end } : null;
	}
	return null;
}

/** Parses the table lines (header, separator, body) into a raw table. */
export function parseMarkdownTable(lines: readonly string[]): RawTable {
	if (lines.length < 2 || !isSeparatorRow(lines[1])) {
		throw new Error("This does not look like a Markdown table (missing the |---| separator row).");
	}
	const headers = splitRow(lines[0]).map(stripInlineFormatting);
	const rows = lines
		.slice(2)
		.filter((l) => l.trim())
		.map((l) => {
			const cells = splitRow(l);
			while (cells.length < headers.length) cells.push("");
			return cells.slice(0, Math.max(headers.length, cells.length));
		});
	return { headers, rows };
}

/** Removes emphasis/code markers from header cells: "**Value**" → "Value". */
export function stripInlineFormatting(text: string): string {
	return text.replace(/^(\*\*|__|\*|_|`)(.*)\1$/, "$2").trim();
}

/** True when `line` sits inside a fenced code block. */
function insideFence(lines: readonly string[], line: number): boolean {
	let inFence = false;
	for (let i = 0; i < line; i++) if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
	return inFence;
}
