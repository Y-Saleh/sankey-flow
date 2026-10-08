import { describe, expect, it } from "vitest";
import { parseCsv, detectDelimiter, toCsv, CsvError } from "../src/data/csv";
import { parseNumber } from "../src/data/numbers";
import { findTableAt, parseMarkdownTable, splitRow } from "../src/data/markdownTable";
import {
	buildRows,
	documentFromRows,
	firstRowLooksLikeHeader,
	guessMapping,
	parseCell,
	summarizeProblems,
	tableFromRows,
} from "../src/data/tableImport";
import { parseBlock } from "../src/data/blockSyntax";
import { parseLink, canonicalLink, linkDisplayText } from "../src/model/linkValue";

describe("parseNumber", () => {
	it.each([
		["42", 42],
		["-3.5", -3.5],
		["1,234.5", 1234.5],
		["1.234,5", 1234.5],
		["1 234", 1234],
		["12,5", 12.5],
		["1,234", 1234],
		["€ 12.50", 12.5],
		["(42)", -42],
		["15%", 15],
		[".5", 0.5],
		["1.234.567", 1234567],
	])("auto: %s → %s", (input, expected) => {
		expect(parseNumber(input)).toBe(expected);
	});

	it.each(["", "abc", "1.2.3,4,5", "12a34", "--", "1,23,4"])("rejects %j", (input) => {
		expect(parseNumber(input)).toBeNull();
	});

	it("honours an explicit decimal format", () => {
		expect(parseNumber("1,234", "comma")).toBe(1.234);
		expect(parseNumber("1.234", "dot")).toBe(1.234);
		expect(parseNumber("1.234,5", "comma")).toBe(1234.5);
	});
});

describe("parseCsv", () => {
	it("parses quoted fields, escaped quotes and embedded newlines", () => {
		const { rows } = parseCsv('a,b,c\n"x, y","he said ""hi""","line1\nline2"\n');
		expect(rows).toEqual([
			["a", "b", "c"],
			["x, y", 'he said "hi"', "line1\nline2"],
		]);
	});

	it("handles BOM, CRLF and blank lines", () => {
		const { rows } = parseCsv("﻿Source,Target,Value\r\nA,B,1\r\n\r\nC,D,2");
		expect(rows).toEqual([
			["Source", "Target", "Value"],
			["A", "B", "1"],
			["C", "D", "2"],
		]);
	});

	it("detects semicolon and tab delimiters", () => {
		expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
		expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
		expect(parseCsv("From;To;Amount\nA;B;1,5").rows[1]).toEqual(["A", "B", "1,5"]);
	});

	it("does not count delimiters inside quotes when detecting", () => {
		expect(detectDelimiter('"a;b",c,d\n"e;f",g,h')).toBe(",");
	});

	it("reports unterminated quotes with a line number", () => {
		expect(() => parseCsv('a,b\n"oops,c\nd,e')).toThrow(CsvError);
		expect(() => parseCsv('a,b\n"oops,c\nd,e')).toThrow(/line 2/);
	});

	it("round-trips through toCsv", () => {
		const rows = [
			["Source", "Target", "Value"],
			['Say "x"', "a,b", "3"],
		];
		expect(parseCsv(toCsv(rows)).rows).toEqual(rows);
	});
});

describe("Markdown tables", () => {
	const note = [
		"# Energy",
		"",
		"| Source | Target | Value |",
		"|---|---|---:|",
		"| Coal | Electricity | 50 |",
		"| [[Gas\\|Natural gas]] | Electricity | 30 |",
		"| Electricity | Homes | 60 |",
		"",
		"Some text",
	];

	it("finds the table containing the cursor", () => {
		expect(findTableAt(note, 4)).toEqual({ start: 2, end: 6 });
		expect(findTableAt(note, 2)).toEqual({ start: 2, end: 6 });
		expect(findTableAt(note, 7)).toEqual({ start: 2, end: 6 });
		expect(findTableAt(note, 0)).toBeNull();
		expect(findTableAt(note, 8)).toBeNull();
	});

	it("parses cells including wikilinks with aliases", () => {
		const table = parseMarkdownTable(note.slice(2, 7));
		expect(table.headers).toEqual(["Source", "Target", "Value"]);
		expect(table.rows[1][0]).toBe("[[Gas|Natural gas]]");
		expect(table.rows).toHaveLength(3);
	});

	it("splits rows without outer pipes and with inline code", () => {
		expect(splitRow("a | `x|y` | c")).toEqual(["a", "`x|y`", "c"]);
		expect(splitRow("| [[A|B]] | 2 |")).toEqual(["[[A|B]]", "2"]);
	});

	it("rejects text without a separator row", () => {
		expect(() => parseMarkdownTable(["| a | b |", "| 1 | 2 |"])).toThrow(/separator/);
	});

	it("ignores tables inside code fences", () => {
		const lines = ["```", "| a | b |", "|---|---|", "```", "| x | y |", "|--|--|", "| 1 | 2 |"];
		expect(findTableAt(lines, 1)).toBeNull();
		expect(findTableAt(lines, 6)).toEqual({ start: 4, end: 6 });
	});
});

describe("column mapping and import", () => {
	it("maps synonyms like From/To/Amount", () => {
		const table = { headers: ["From", "To", "Amount"], rows: [["A", "B", "1"]] };
		expect(guessMapping(table)).toEqual({ source: 0, target: 1, value: 2, label: -1 });
	});

	it("falls back to the most numeric column for value", () => {
		const table = { headers: ["Year", "Origin country", "Dest", "Tonnes"], rows: [["x", "A", "B", "5"], ["y", "C", "D", "6"]] };
		const m = guessMapping(table);
		expect(m.value).toBe(3);
		expect(m.source).toBe(1);
		expect(m.target).toBe(2);
	});

	it("produces a clear message when the value column is not numeric", () => {
		const table = { headers: ["Source", "Target", "Value"], rows: [["A", "B", "lots"], ["B", "C", "many"]] };
		const mapping = guessMapping(table);
		const mapped = { ...mapping, value: 2 };
		const result = buildRows(table, mapped, { decimal: "auto" });
		expect(result.rows).toEqual([]);
		expect(summarizeProblems(result, table, mapped)).toBe("The selected Value column (Value) contains non-numeric values.");
	});

	it("reports skipped rows individually and keeps valid ones", () => {
		const table = { headers: ["s", "t", "v"], rows: [["A", "B", "1"], ["", "C", "2"], ["D", "D", "3"], ["E", "F", "-1"]] };
		const result = buildRows(table, { source: 0, target: 1, value: 2, label: -1 }, { decimal: "auto" });
		expect(result.rows).toHaveLength(1);
		expect(result.problems.map((p) => p.rowNumber)).toEqual([2, 3, 4]);
	});

	it("rejects identical columns", () => {
		const table = { headers: ["a", "b"], rows: [["1", "2"]] };
		const result = buildRows(table, { source: 0, target: 0, value: 1, label: -1 }, { decimal: "auto" });
		expect(result.problems[0].message).toMatch(/different columns/);
	});

	it("detects header rows", () => {
		expect(firstRowLooksLikeHeader([["Source", "Target", "Value"], ["A", "B", "1"]])).toBe(true);
		expect(firstRowLooksLikeHeader([["A", "B", "1"], ["C", "D", "2"]])).toBe(false);
		expect(tableFromRows([["A", "B", "1"]], false).headers).toEqual(["Column 1", "Column 2", "Column 3"]);
	});

	it("turns wikilink cells into linked nodes and merges duplicate flows", () => {
		expect(parseCell("[[Energy/Coal|Coal power]]")).toEqual({ label: "Coal power", link: "[[Energy/Coal]]" });
		expect(parseCell("[[Energy/Coal]]")).toEqual({ label: "Coal", link: "[[Energy/Coal]]" });
		expect(parseCell("[Site](https://example.com)")).toEqual({ label: "Site", link: "https://example.com" });
		const table = { headers: ["s", "t", "v"], rows: [["[[Coal]]", "Power", "1"], ["Coal", "Power", "2"]] };
		const { rows } = buildRows(table, { source: 0, target: 1, value: 2, label: -1 }, { decimal: "auto" });
		const doc = documentFromRows("T", rows);
		expect(doc.nodes).toHaveLength(2);
		expect(doc.nodes[0].link).toBe("[[Coal]]");
		expect(doc.flows).toHaveLength(1);
		expect(doc.flows[0].value).toBe(3);
	});
});

describe("code block syntax", () => {
	it("parses arrow and SankeyMATIC notations with options", () => {
		const spec = parseBlock(
			[
				"height: 300",
				"suffix: TWh",
				"// comment",
				"Coal -> Electricity: 50",
				"Gas [30] Electricity",
				"[[Wind]] → Electricity: 1,5",
				":Electricity #336699",
			].join("\n"),
		);
		expect(spec.kind).toBe("inline");
		if (spec.kind !== "inline") return;
		expect(spec.issues).toEqual([]);
		expect(spec.options).toMatchObject({ height: 300, valueSuffix: " TWh" });
		expect(spec.doc.flows.map((f) => f.value)).toEqual([50, 30, 1.5]);
		expect(spec.doc.nodes.find((n) => n.label === "Electricity")?.color).toBe("#336699");
		expect(spec.doc.nodes.find((n) => n.label === "Wind")?.link).toBe("[[Wind]]");
	});

	it("recognises references, JSON and Dataview queries", () => {
		expect(parseBlock("diagram: [[Sankey/Energy]]\nheight: 400")).toMatchObject({
			kind: "reference",
			target: "[[Sankey/Energy]]",
			options: { height: 400 },
		});
		expect(parseBlock('{ "version": 1 }').kind).toBe("json");
		const dv = parseBlock('query: TABLE from, to, amount\n  FROM "Finance"\nsource: from\nvalue: amount');
		expect(dv).toMatchObject({ kind: "dataview", query: 'TABLE from, to, amount\nFROM "Finance"', columns: { source: "from", value: "amount" } });
	});

	it("reports bad lines with line numbers", () => {
		const spec = parseBlock("A -> B\nC -> D: x\nnonsense here");
		expect(spec.kind).toBe("empty");
		expect(spec.issues.map((i) => i.message)).toEqual([
			expect.stringContaining("Line 1: missing value"),
			expect.stringContaining('Line 2: "x" is not a number'),
			expect.stringContaining("Line 3: could not understand"),
		]);
	});
});

describe("links", () => {
	it("parses wikilinks, headings, blocks, aliases and URLs", () => {
		expect(parseLink("[[Note#Heading|Alias]]")).toEqual({ kind: "internal", linktext: "Note#Heading", alias: "Alias" });
		expect(parseLink("[[Note#^abc123]]")).toEqual({ kind: "internal", linktext: "Note#^abc123", alias: null });
		expect(parseLink("Board.canvas")).toEqual({ kind: "internal", linktext: "Board.canvas", alias: null });
		expect(parseLink("https://obsidian.md")).toEqual({ kind: "external", url: "https://obsidian.md" });
		expect(parseLink("[Doc](My%20Note.md)")).toEqual({ kind: "internal", linktext: "My Note.md", alias: "Doc" });
	});

	it("refuses script-capable schemes", () => {
		for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"]) {
			expect(parseLink(bad)).toBeNull();
		}
	});

	it("canonicalises and displays links", () => {
		expect(canonicalLink("Project Alpha")).toBe("[[Project Alpha]]");
		expect(linkDisplayText("[[Folder/Note#Budget]]")).toBe("Note › Budget");
		expect(linkDisplayText("[[Note#^block]]")).toBe("Note › block");
	});
});

describe("value suffix options", () => {
	it("spaces word units, keeps symbols and quoted values verbatim", () => {
		const opts = (line: string) => parseBlock(`${line}\nA -> B: 1`).options;
		expect(opts("suffix: TWh").valueSuffix).toBe(" TWh");
		expect(opts("suffix: %").valueSuffix).toBe("%");
		expect(opts('suffix: "kg"').valueSuffix).toBe("kg");
		expect(opts("unit: t").valueSuffix).toBe(" t");
		expect(opts('prefix: "$ "').valuePrefix).toBe("$ ");
	});
});
