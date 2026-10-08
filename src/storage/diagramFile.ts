import { createEmptyDocument, type SankeyDocument } from "../model/schema";
import { parseDocument, type NormalizeResult } from "../model/validate";
import { collectInternalLinks } from "../model/operations";

/**
 * Diagram files are ordinary Markdown notes:
 *
 *     ---
 *     sankey-flow: diagram
 *     sankey-links:
 *       - "[[Coal]]"
 *     ---
 *
 *     ```sankey
 *     { ...diagram JSON... }
 *     ```
 *
 * - `sankey-flow: diagram` marks the note as a diagram.
 * - `sankey-links` mirrors every note linked from nodes/flows so Obsidian's
 *   own index picks them up: backlinks, graph view, outgoing links and
 *   rename-updates all work without any custom indexing.
 * - The JSON block is rendered by the `sankey` code block processor, so the
 *   note embeds anywhere Markdown renders (`![[...]]`, Canvas, hover preview).
 *
 * Only the two keys above and the data block are ever rewritten. Other
 * frontmatter and any text the user adds around the block are preserved.
 */

export const FRONTMATTER_KEY = "sankey-flow";
export const FRONTMATTER_MARKER = "diagram";
export const LINKS_KEY = "sankey-links";
export const BLOCK_LANGUAGE = "sankey";

export function isDiagramFrontmatter(frontmatter: unknown): boolean {
	if (!frontmatter || typeof frontmatter !== "object") return false;
	const marker = (frontmatter as Record<string, unknown>)[FRONTMATTER_KEY];
	return marker === FRONTMATTER_MARKER || marker === true;
}

export interface BlockLocation {
	/** Offset of the opening fence line. */
	start: number;
	/** Offset just after the closing fence line (or end of text if unterminated). */
	end: number;
	content: string;
	closed: boolean;
}

interface Line {
	text: string;
	start: number;
	end: number; // offset after the line break
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let pos = 0;
	while (pos < text.length) {
		const nl = text.indexOf("\n", pos);
		const end = nl < 0 ? text.length : nl + 1;
		lines.push({ text: text.slice(pos, nl < 0 ? text.length : nl).replace(/\r$/, ""), start: pos, end });
		pos = end;
	}
	return lines;
}

/** Locates the first ```sankey block whose content is JSON (the diagram data). */
export function locateDataBlock(text: string): BlockLocation | null {
	const lines = splitLines(text);
	for (let i = 0; i < lines.length; i++) {
		const open = /^ {0,3}(`{3,}|~{3,})\s*sankey\s*$/.exec(lines[i].text);
		if (!open) continue;
		const fence = open[1];
		const closeRe = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
		let j = i + 1;
		while (j < lines.length && !closeRe.test(lines[j].text)) j++;
		const closed = j < lines.length;
		const contentLines = lines.slice(i + 1, j).map((l) => l.text);
		const content = contentLines.join("\n");
		if (content.trim().startsWith("{")) {
			return { start: lines[i].start, end: closed ? lines[j].end : text.length, content, closed };
		}
		i = j;
	}
	return null;
}

export interface FrontmatterRange {
	/** Offset of the first YAML line (after the opening ---). */
	yamlStart: number;
	/** Offset of the closing --- line. */
	yamlEnd: number;
	/** Offset just after the closing --- line. */
	end: number;
}

export function locateFrontmatter(text: string): FrontmatterRange | null {
	const lines = splitLines(text);
	if (!lines.length || lines[0].text.trim() !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		if (/^(---|\.\.\.)\s*$/.test(lines[i].text)) {
			return { yamlStart: lines[0].end, yamlEnd: lines[i].start, end: lines[i].end };
		}
	}
	return null;
}

/** Reads a diagram note. Throws SankeyFormatError when the data block is unusable. */
export function readDiagramFile(text: string): NormalizeResult {
	const block = locateDataBlock(text);
	if (!block) {
		return {
			doc: createEmptyDocument(""),
			issues: [{ level: "warning", message: "This note has no diagram data yet; it will be added when you save." }],
			migratedFrom: null,
		};
	}
	const result = parseDocument(block.content);
	if (!block.closed) {
		result.issues.push({ level: "warning", message: "The diagram's code block was not closed; it will be repaired on save." });
	}
	return result;
}

/**
 * Pretty-prints a document with one node/flow per line. Compared to
 * `JSON.stringify(doc, null, 2)` this produces much smaller files and
 * one-line diffs when a single flow changes.
 */
export function stringifyDocument(doc: SankeyDocument): string {
	const keys = Object.keys(doc);
	const order = ["type", "version", "meta", "nodes", "flows", "display", "layout", "extensions"];
	keys.sort((a, b) => {
		const ia = order.indexOf(a);
		const ib = order.indexOf(b);
		return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
	});
	const parts = keys.map((key) => {
		const value = doc[key];
		let rendered: string;
		if ((key === "nodes" || key === "flows") && Array.isArray(value)) {
			rendered = value.length
				? "[\n" + value.map((item) => "    " + JSON.stringify(item)).join(",\n") + "\n  ]"
				: "[]";
		} else {
			rendered = JSON.stringify(value, null, 2).replace(/\n/g, "\n  ");
		}
		return `  ${JSON.stringify(key)}: ${rendered}`;
	});
	return "{\n" + parts.join(",\n") + "\n}";
}

function fenceFor(content: string): string {
	const longest = (content.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
	return "`".repeat(Math.max(3, longest + 1));
}

export function renderDataBlock(doc: SankeyDocument): string {
	const json = stringifyDocument(doc);
	const fence = fenceFor(json);
	return `${fence}${BLOCK_LANGUAGE}\n${json}\n${fence}\n`;
}

function yamlQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderKey(key: string, value: string | string[]): string {
	if (typeof value === "string") return `${key}: ${value}\n`;
	return `${key}:\n` + value.map((v) => `  - ${yamlQuote(v)}\n`).join("");
}

/**
 * Sets (or removes, when `value` is null) a top-level key inside a YAML
 * frontmatter body, leaving every other line untouched.
 */
export function setYamlKey(yaml: string, key: string, value: string | string[] | null): string {
	const lines = yaml.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const keyRe = new RegExp(`^${key.replace(/[-]/g, "\\-")}\\s*:`);
	const startIdx = lines.findIndex((l) => keyRe.test(l));
	const rendered = value === null ? [] : renderKey(key, value).replace(/\n$/, "").split("\n");
	if (startIdx < 0) {
		if (value !== null) lines.push(...rendered);
	} else {
		// The value continues on indented lines and on unindented "- item" lines.
		let endIdx = startIdx + 1;
		while (endIdx < lines.length && (/^\s+\S/.test(lines[endIdx]) || /^-(\s|$)/.test(lines[endIdx]))) endIdx++;
		lines.splice(startIdx, endIdx - startIdx, ...rendered);
	}
	return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Produces the full note text for `doc`. When `existing` is given, only the
 * diagram's own frontmatter keys and data block change.
 */
export function writeDiagramFile(doc: SankeyDocument, existing?: string): string {
	const links = collectInternalLinks(doc);
	const block = renderDataBlock(doc);

	if (existing === undefined || existing.trim() === "") {
		let yaml = renderKey(FRONTMATTER_KEY, FRONTMATTER_MARKER);
		if (links.length) yaml += renderKey(LINKS_KEY, links);
		return `---\n${yaml}---\n\n${block}`;
	}

	let text = existing;
	const located = locateDataBlock(text);
	if (located) {
		text = text.slice(0, located.start) + block + text.slice(located.end);
	} else {
		text = text.replace(/\s*$/, "") + "\n\n" + block;
	}

	const fm = locateFrontmatter(text);
	if (fm) {
		let yaml = text.slice(fm.yamlStart, fm.yamlEnd);
		if (!new RegExp(`^${FRONTMATTER_KEY}\\s*:`, "m").test(yaml)) yaml = setYamlKey(yaml, FRONTMATTER_KEY, FRONTMATTER_MARKER);
		yaml = setYamlKey(yaml, LINKS_KEY, links.length ? links : null);
		text = text.slice(0, fm.yamlStart) + yaml + text.slice(fm.yamlEnd);
	} else {
		let yaml = renderKey(FRONTMATTER_KEY, FRONTMATTER_MARKER);
		if (links.length) yaml += renderKey(LINKS_KEY, links);
		text = `---\n${yaml}---\n\n` + text.replace(/^\s+/, "");
	}
	return text;
}

/** Matches a whole `sankey` code block; group 3 is its body. */
const SANKEY_BLOCK = /^( {0,3})(`{3,}|~{3,})[ \t]*sankey[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\2[ \t]*$/gm;

/** Applies `fn` to the body of every `sankey` code block, leaving the rest of the note untouched. */
export function replaceInSankeyBlocks(text: string, fn: (body: string) => string): string {
	return text.replace(new RegExp(SANKEY_BLOCK.source, "gm"), (whole: string, _indent: string, _fence: string, body: string) => {
		const next = fn(body);
		return next === body ? whole : whole.replace(body, next);
	});
}

/** Bodies of every `sankey` code block in a note. */
export function sankeyBlockBodies(text: string): string[] {
	const out: string[] = [];
	const re = new RegExp(SANKEY_BLOCK.source, "gm");
	for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[3]);
	return out;
}
