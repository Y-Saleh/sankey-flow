import { describe, expect, it } from "vitest";
import {
	isDiagramFrontmatter,
	locateDataBlock,
	readDiagramFile,
	setYamlKey,
	stringifyDocument,
	writeDiagramFile,
} from "../src/storage/diagramFile";
import { createEmptyDocument } from "../src/model/schema";
import {
	addFlow,
	addNode,
	collectInternalLinks,
	duplicateFlow,
	moveNode,
	removeNode,
	setFlowEndpointByLabel,
} from "../src/model/operations";
import { History } from "../src/model/history";
import { SankeyFormatError } from "../src/model/validate";
import { computeLayout, linkPath, toNormalisedPosition } from "../src/layout/sankeyLayout";

function sampleDoc() {
	const doc = createEmptyDocument("Energy", new Date("2026-01-01T00:00:00Z"));
	const coal = addNode(doc, { label: "Coal", link: "[[Coal]]" });
	const gas = addNode(doc, { label: "Gas" });
	const elec = addNode(doc, { label: "Electricity", link: "[[Grid#Overview]]" });
	const homes = addNode(doc, { label: "Homes" });
	const industry = addNode(doc, { label: "Industry" });
	addFlow(doc, coal.id, elec.id, 50);
	addFlow(doc, gas.id, elec.id, 30);
	addFlow(doc, elec.id, homes.id, 60);
	addFlow(doc, elec.id, industry.id, 20);
	return doc;
}

describe("diagram files", () => {
	it("writes a new file with marker, links and data block, and reads it back", () => {
		const doc = sampleDoc();
		const text = writeDiagramFile(doc);
		expect(text.startsWith("---\nsankey-flow: diagram\nsankey-links:\n")).toBe(true);
		expect(text).toContain('  - "[[Coal]]"');
		expect(text).toContain('  - "[[Grid#Overview]]"');
		expect(text).toContain("```sankey\n{");
		const { doc: back, issues } = readDiagramFile(text);
		expect(issues).toEqual([]);
		expect(back).toEqual(doc);
	});

	it("preserves user frontmatter and surrounding text on save", () => {
		const doc = sampleDoc();
		const original = [
			"---",
			"tags: [energy, \"2026\"]",
			"sankey-flow: diagram",
			"sankey-links:",
			'  - "[[Old]]"',
			"aliases:",
			"  - Energy chart",
			"---",
			"",
			"Intro paragraph.",
			"",
			"```sankey",
			"{}",
			"```",
			"",
			"## Notes",
			"Kept as is.",
			"",
		].join("\n");
		const text = writeDiagramFile(doc, original);
		expect(text).toContain('tags: [energy, "2026"]');
		expect(text).toContain("aliases:\n  - Energy chart");
		expect(text).not.toContain("[[Old]]");
		expect(text).toContain("Intro paragraph.");
		expect(text).toContain("## Notes\nKept as is.");
		expect(readDiagramFile(text).doc.flows).toHaveLength(4);
		// Saving the same document again is a no-op.
		expect(writeDiagramFile(doc, text)).toBe(text);
	});

	it("removes the links key when no links remain and adds a marker when missing", () => {
		const doc = createEmptyDocument("Empty");
		const text = writeDiagramFile(doc, "---\nsankey-links:\n  - \"[[X]]\"\nfoo: bar\n---\nBody\n");
		expect(text).not.toContain("sankey-links");
		expect(text).toContain("foo: bar");
		expect(text).toContain("sankey-flow: diagram");
	});

	it("uses a longer fence when labels contain backticks", () => {
		const doc = createEmptyDocument("Fence");
		addNode(doc, { label: "Code ``` block" });
		const text = writeDiagramFile(doc);
		expect(text).toContain("````sankey");
		expect(readDiagramFile(text).doc.nodes[0].label).toBe("Code ``` block");
	});

	it("treats a note with no data block as an empty diagram", () => {
		const result = readDiagramFile("---\nsankey-flow: diagram\n---\n");
		expect(result.doc.nodes).toEqual([]);
		expect(result.issues[0].level).toBe("warning");
	});

	it("throws on malformed JSON so the file is never overwritten", () => {
		expect(() => readDiagramFile("```sankey\n{ broken\n```\n")).toThrow(SankeyFormatError);
	});

	it("ignores non-JSON sankey blocks when locating the data block", () => {
		const text = "```sankey\nA -> B: 1\n```\n\n```sankey\n{\"version\":1}\n```\n";
		expect(locateDataBlock(text)?.content).toBe('{"version":1}');
	});

	it("writes one node and one flow per line", () => {
		const json = stringifyDocument(sampleDoc());
		const flowLines = json.split("\n").filter((l) => l.includes('"source"'));
		expect(flowLines).toHaveLength(4);
		expect(JSON.parse(json).flows).toHaveLength(4);
	});

	it("edits single YAML keys without touching others", () => {
		const yaml = "a: 1\nsankey-links:\n- \"[[A]]\"\n- \"[[B]]\"\nb: 2\n";
		expect(setYamlKey(yaml, "sankey-links", ["[[C]]"])).toBe('a: 1\nsankey-links:\n  - "[[C]]"\nb: 2\n');
		expect(setYamlKey(yaml, "sankey-links", null)).toBe("a: 1\nb: 2\n");
	});

	it("recognises the frontmatter marker", () => {
		expect(isDiagramFrontmatter({ "sankey-flow": "diagram" })).toBe(true);
		expect(isDiagramFrontmatter({ "sankey-flow": "nope" })).toBe(false);
		expect(isDiagramFrontmatter(null)).toBe(false);
	});
});

describe("operations", () => {
	it("generates unique ids from labels", () => {
		const doc = createEmptyDocument("x");
		expect(addNode(doc, { label: "Coal" }).id).toBe("coal");
		expect(addNode(doc, { label: "coal" }).id).toBe("coal-2");
		expect(addNode(doc, { label: "Énergie Nucléaire" }).id).toBe("energie-nucleaire");
	});

	it("removes attached flows with a node", () => {
		const doc = sampleDoc();
		expect(removeNode(doc, "electricity")).toBe(4);
		expect(doc.flows).toEqual([]);
	});

	it("re-points flows by label and prunes implicit orphans only", () => {
		const doc = sampleDoc();
		const flow = doc.flows.find((f) => f.source === "gas")!;
		setFlowEndpointByLabel(doc, flow.id, "source", "Natural gas");
		expect(doc.nodes.some((n) => n.id === "gas")).toBe(false);
		expect(doc.nodes.some((n) => n.label === "Natural gas")).toBe(true);
		const coalFlow = doc.flows.find((f) => f.source === "coal")!;
		setFlowEndpointByLabel(doc, coalFlow.id, "source", "Lignite");
		// Coal has a link (user metadata), so it is kept.
		expect(doc.nodes.some((n) => n.id === "coal")).toBe(true);
	});

	it("duplicates flows and reorders nodes", () => {
		const doc = sampleDoc();
		const copy = duplicateFlow(doc, doc.flows[0].id)!;
		expect(doc.flows[1]).toBe(copy);
		expect(copy.id).not.toBe(doc.flows[0].id);
		moveNode(doc, "industry", 0);
		expect(doc.nodes[0].id).toBe("industry");
	});

	it("collects canonical internal links", () => {
		expect(collectInternalLinks(sampleDoc())).toEqual(["[[Coal]]", "[[Grid#Overview]]"]);
	});
});

describe("history", () => {
	it("undoes and redoes, coalescing rapid edits with the same key", () => {
		let t = 0;
		const h = new History<number>(10, 1000, () => t);
		let state = 0;
		const set = (v: number, key?: string) => {
			h.record(state, "edit", key);
			state = v;
		};
		set(1, "value");
		t = 100;
		set(2, "value");
		t = 200;
		set(3, "value");
		t = 5000;
		set(4, "other");
		expect(h.undo(state)?.state).toBe(3);
		state = 3;
		expect(h.undo(state)?.state).toBe(0);
		state = 0;
		expect(h.canUndo).toBe(false);
		expect(h.redo(state)?.state).toBe(3);
	});

	it("drops redo after a new edit and respects the limit", () => {
		const h = new History<number>(2);
		h.record(0, "a");
		h.record(1, "b");
		h.record(2, "c");
		expect(h.undo(3)?.state).toBe(2);
		expect(h.undo(2)?.state).toBe(1);
		expect(h.undo(1)).toBeNull();
		h.record(1, "d");
		expect(h.canRedo).toBe(false);
	});
});

describe("layout", () => {
	const opts = { width: 800, height: 400, nodeWidth: 12, nodePadding: 12, align: "justify" as const, iterations: 6 };

	it("places columns by depth and sizes nodes by value", () => {
		const doc = sampleDoc();
		const layout = computeLayout(doc.nodes, doc.flows, opts);
		const byId = new Map(layout.nodes.map((n) => [n.id, n]));
		expect(layout.columns).toBe(3);
		expect(byId.get("coal")!.x0).toBe(0);
		expect(byId.get("homes")!.x1).toBeCloseTo(800);
		expect(byId.get("electricity")!.value).toBe(80);
		const elec = byId.get("electricity")!;
		expect(elec.y1 - elec.y0).toBeCloseTo(80 * layout.ky);
		for (const n of layout.nodes) {
			expect(n.y0).toBeGreaterThanOrEqual(-1e-6);
			expect(n.y1).toBeLessThanOrEqual(400 + 1e-6);
		}
	});

	it("does not overlap nodes within a column", () => {
		const doc = createEmptyDocument("wide");
		const hub = addNode(doc, { label: "Hub" });
		for (let i = 0; i < 30; i++) addFlow(doc, hub.id, addNode(doc, { label: `Leaf ${i}` }).id, 1 + (i % 5));
		const layout = computeLayout(doc.nodes, doc.flows, opts);
		const leaves = layout.nodes.filter((n) => n.id !== hub.id).sort((a, b) => a.y0 - b.y0);
		for (let i = 1; i < leaves.length; i++) expect(leaves[i].y0).toBeGreaterThanOrEqual(leaves[i - 1].y1 - 1e-6);
	});

	it("handles cycles without throwing and marks the closing link circular", () => {
		const doc = createEmptyDocument("cycle");
		const a = addNode(doc, { label: "A" });
		const b = addNode(doc, { label: "B" });
		const c = addNode(doc, { label: "C" });
		addFlow(doc, a.id, b.id, 5);
		addFlow(doc, b.id, c.id, 5);
		addFlow(doc, c.id, a.id, 2);
		const layout = computeLayout(doc.nodes, doc.flows, opts);
		expect(layout.links.filter((l) => l.circular)).toHaveLength(1);
		expect(layout.links.find((l) => l.circular)!.source.id).toBe("c");
		const path = linkPath(layout.links.find((l) => l.circular)!, layout.loopBase);
		expect(path).toMatch(/^M.*C.*L.*C/);
		expect(layout.bounds.y1).toBeGreaterThan(400);
	});

	it("keeps pinned nodes where they were placed", () => {
		const doc = sampleDoc();
		doc.nodes.find((n) => n.id === "gas")!.position = { x: 0.5, y: 1 };
		const layout = computeLayout(doc.nodes, doc.flows, opts);
		const gas = layout.nodes.find((n) => n.id === "gas")!;
		expect(gas.pinned).toBe(true);
		expect(gas.y1).toBeCloseTo(400);
		expect(gas.x0).toBeCloseTo((800 - 12) * 0.5);
		const pos = toNormalisedPosition(gas.x0, gas.y0, gas.y1 - gas.y0, opts);
		expect(pos.x).toBeCloseTo(0.5);
		expect(pos.y).toBeCloseTo(1);
	});

	it("gives isolated and zero-value nodes a visible minimum height", () => {
		const doc = createEmptyDocument("x");
		addNode(doc, { label: "Lonely" });
		const layout = computeLayout(doc.nodes, doc.flows, opts);
		expect(layout.nodes[0].y1 - layout.nodes[0].y0).toBeGreaterThanOrEqual(4);
	});

	it("ignores invalid flows", () => {
		const doc = sampleDoc();
		addFlow(doc, "coal", "coal", 5);
		addFlow(doc, "coal", "homes", -3);
		addFlow(doc, "coal", "nope", 3);
		expect(computeLayout(doc.nodes, doc.flows, opts).links).toHaveLength(4);
	});

	it("is deterministic", () => {
		const doc = sampleDoc();
		const a = computeLayout(doc.nodes, doc.flows, opts);
		const b = computeLayout(doc.nodes, doc.flows, opts);
		expect(a.nodes.map((n) => [n.y0, n.y1])).toEqual(b.nodes.map((n) => [n.y0, n.y1]));
	});

	it("lays out hundreds of nodes and thousands of flows quickly", () => {
		const doc = createEmptyDocument("big");
		const layers = 6;
		const perLayer = 60;
		for (let l = 0; l < layers; l++) for (let i = 0; i < perLayer; i++) addNode(doc, { label: `N${l}-${i}` });
		let seed = 1;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let l = 0; l < layers - 1; l++) {
			for (let k = 0; k < 600; k++) {
				const s = doc.nodes[l * perLayer + Math.floor(rand() * perLayer)].id;
				const t = doc.nodes[(l + 1) * perLayer + Math.floor(rand() * perLayer)].id;
				addFlow(doc, s, t, 1 + Math.floor(rand() * 20));
			}
		}
		expect(doc.flows.length).toBe(3000);
		const start = performance.now();
		const layout = computeLayout(doc.nodes, doc.flows, { ...opts, width: 1600, height: 1200 });
		const elapsed = performance.now() - start;
		expect(layout.nodes).toHaveLength(360);
		expect(layout.links).toHaveLength(3000);
		expect(elapsed).toBeLessThan(1000);
	});
});

import { replaceInSankeyBlocks, sankeyBlockBodies } from "../src/storage/diagramFile";

describe("sankey block helpers", () => {
	const note = "diagram: [[Not in a block]]\n\n```sankey\ndiagram: [[Old]]\nheight: 300\n```\n\n~~~~sankey\nA -> B: 1\n~~~~\n";
	it("lists block bodies", () => {
		expect(sankeyBlockBodies(note)).toEqual(["diagram: [[Old]]\nheight: 300", "A -> B: 1"]);
	});
	it("only rewrites inside sankey blocks", () => {
		const out = replaceInSankeyBlocks(note, (b) => b.replace(/^diagram: .*$/m, "diagram: [[New]]"));
		expect(out).toContain("diagram: [[Not in a block]]");
		expect(out).toContain("```sankey\ndiagram: [[New]]\nheight: 300\n```");
	});
});

import { readFileSync } from "node:fs";
import { parseBlock } from "../src/data/blockSyntax";

describe("shipped examples", () => {
	it("example diagram note loads without issues", () => {
		const text = readFileSync("examples/Sankey/Energy flow.md", "utf8");
		const { doc, issues } = readDiagramFile(text);
		expect(issues).toEqual([]);
		expect(doc.nodes).toHaveLength(8);
		expect(collectInternalLinks(doc)).toEqual(["[[Coal]]", "[[Grid#Overview]]"]);
		// The frontmatter already mirrors the links, so saving it unchanged is a no-op.
		expect(writeDiagramFile(doc, text)).toBe(text);
	});

	it("example report's code blocks parse", () => {
		const text = readFileSync("examples/Energy report.md", "utf8");
		const kinds = sankeyBlockBodies(text).map((b) => parseBlock(b).kind);
		expect(kinds).toEqual(["inline", "reference"]);
	});
});
