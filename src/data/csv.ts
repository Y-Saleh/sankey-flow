export type CsvDelimiter = "auto" | "," | ";" | "\t" | "|";

export interface CsvParseResult {
	rows: string[][];
	delimiter: Exclude<CsvDelimiter, "auto">;
}

export class CsvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CsvError";
	}
}

const CANDIDATES: Exclude<CsvDelimiter, "auto">[] = [",", ";", "\t", "|"];

/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes (""), CRLF/LF line
 * endings, newlines inside quotes and a leading BOM. Fully empty lines are
 * dropped. No values are evaluated — everything stays a string.
 */
export function parseCsv(text: string, delimiter: CsvDelimiter = "auto"): CsvParseResult {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const delim = delimiter === "auto" ? detectDelimiter(source) : delimiter;

	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let quoteStartLine = 0;
	let line = 1;

	const endField = () => {
		row.push(field);
		field = "";
	};
	const endRow = () => {
		endField();
		if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
		row = [];
	};

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (inQuotes) {
			if (ch === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				if (ch === "\n") line++;
				field += ch;
			}
			continue;
		}
		if (ch === '"' && field.trim() === "") {
			inQuotes = true;
			quoteStartLine = line;
			field = "";
		} else if (ch === delim) {
			endField();
		} else if (ch === "\r") {
			if (source[i + 1] === "\n") i++;
			endRow();
			line++;
		} else if (ch === "\n") {
			endRow();
			line++;
		} else {
			field += ch;
		}
	}
	if (inQuotes) {
		throw new CsvError(`Unterminated quoted field starting on line ${quoteStartLine}.`);
	}
	if (field !== "" || row.length > 0) endRow();
	return { rows, delimiter: delim };
}

/** Picks the candidate that splits the first lines into the most consistent column count. */
export function detectDelimiter(text: string): Exclude<CsvDelimiter, "auto"> {
	const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
	let best: Exclude<CsvDelimiter, "auto"> = ",";
	let bestScore = 0;
	for (const candidate of CANDIDATES) {
		const counts = sample.map((l) => countOutsideQuotes(l, candidate));
		if (!counts.length || counts[0] === 0) continue;
		const first = counts[0];
		const consistent = counts.filter((c) => c === first).length;
		const score = consistent * 1000 + first;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
}

function countOutsideQuotes(line: string, ch: string): number {
	let count = 0;
	let quoted = false;
	for (const c of line) {
		if (c === '"') quoted = !quoted;
		else if (c === ch && !quoted) count++;
	}
	return count;
}

function escapeField(value: string, delimiter: string): string {
	if (value.includes('"') || value.includes(delimiter) || /[\r\n]/.test(value) || /^\s|\s$/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function toCsv(rows: readonly (readonly (string | number)[])[], delimiter = ","): string {
	return rows.map((r) => r.map((v) => escapeField(String(v), delimiter)).join(delimiter)).join("\n") + "\n";
}
