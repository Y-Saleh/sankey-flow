import { describe, expect, it } from "vitest";
import { normalizeDocument, parseDocument, SankeyFormatError } from "../src/model/validate";
import { SCHEMA_VERSION, createEmptyDocument } from "../src/model/schema";

const valid = {
	type: "sankey-flow",
	version: 1,
	meta: { title: "Energy", description: "" },
	nodes: [
		{ id: "coal", label: "Coal", link: "[[Coal]]" },
		{ id: "elec", label: "Electricity" },
	],
	flows: [{ id: "f1", source: "coal", target: "elec", value: 50 }],
	display: { showValues: true },
	layout: { align: "left", iterations: 4 },
	extensions: {},
};

describe("parseDocument", () => {
	it("accepts a valid document without issues", () => {
		const { doc, issues, migratedFrom } = parseDocument(JSON.stringify(valid));
		expect(issues).toEqual([]);
		expect(migratedFrom).toBeNull();
		expect(doc.nodes).toHaveLength(2);
		expect(doc.flows[0]).toMatchObject({ source: "coal", target: "elec", value: 50 });
		expect(doc.layout.align).toBe("left");
	});

	it("reports invalid JSON as a syntax error", () => {
		expect(() => parseDocument("{ nodes: [")).toThrow(SankeyFormatError);
		try {
			parseDocument("{");
		} catch (e) {
			expect((e as SankeyFormatError).kind).toBe("syntax");
		}
	});

	it("refuses documents from a newer schema version", () => {
		const newer = { ...valid, version: SCHEMA_VERSION + 1 };
		try {
			normalizeDocument(newer);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(SankeyFormatError);
			expect((e as SankeyFormatError).kind).toBe("newer-version");
			expect((e as Error).message).toContain("newer");
		}
	});

	it("rejects non-object input", () => {
		expect(() => normalizeDocument([1, 2])).toThrow(/JSON object/);
		expect(() => normalizeDocument("x")).toThrow(SankeyFormatError);
	});

	it("renames duplicate node ids and reports it", () => {
		const { doc, issues } = normalizeDocument({
			...valid,
			nodes: [
				{ id: "a", label: "A" },
				{ id: "a", label: "A again" },
			],
			flows: [],
		});
		expect(doc.nodes.map((n) => n.id)).toEqual(["a", "a-2"]);
		expect(issues.some((i) => i.message.includes("Duplicate node id"))).toBe(true);
	});

	it("creates nodes for missing flow endpoints", () => {
		const { doc, issues } = normalizeDocument({ ...valid, nodes: [], flows: [{ source: "x", target: "y", value: 3 }] });
		expect(doc.nodes.map((n) => n.id)).toEqual(["x", "y"]);
		expect(issues.filter((i) => i.message.includes("missing node"))).toHaveLength(2);
	});

	it("keeps negative values but warns; coerces numeric strings; zeroes garbage", () => {
		const { doc, issues } = normalizeDocument({
			...valid,
			flows: [
				{ source: "coal", target: "elec", value: -5 },
				{ source: "coal", target: "elec", value: "12.5" },
				{ source: "coal", target: "elec", value: "lots" },
			],
		});
		expect(doc.flows.map((f) => f.value)).toEqual([-5, 12.5, 0]);
		expect(issues.some((i) => i.message.includes("negative"))).toBe(true);
		expect(issues.some((i) => i.level === "error" && i.message.includes("non-numeric"))).toBe(true);
	});

	it("warns about self-loops", () => {
		const { issues } = normalizeDocument({ ...valid, flows: [{ source: "coal", target: "coal", value: 1 }] });
		expect(issues.some((i) => i.message.includes("itself"))).toBe(true);
	});

	it("drops unsafe colours and links", () => {
		const { doc, issues } = normalizeDocument({
			...valid,
			nodes: [
				{ id: "a", label: "A", color: "url(https://evil.example/x.svg)", link: "javascript:alert(1)" },
				{ id: "b", label: "B", color: "#abc", link: "https://example.com" },
			],
			flows: [],
		});
		expect(doc.nodes[0].color).toBeUndefined();
		expect(doc.nodes[0].link).toBeUndefined();
		expect(doc.nodes[1]).toMatchObject({ color: "#abc", link: "https://example.com" });
		expect(issues).toHaveLength(2);
	});

	it("preserves unknown properties for forward compatibility", () => {
		const { doc } = normalizeDocument({
			...valid,
			futureTopLevel: { a: 1 },
			nodes: [{ id: "a", label: "A", icon: "zap" }],
			flows: [],
			extensions: { "other-plugin": { x: 1 } },
		});
		expect(doc.futureTopLevel).toEqual({ a: 1 });
		expect(doc.nodes[0].icon).toBe("zap");
		expect(doc.extensions).toEqual({ "other-plugin": { x: 1 } });
	});

	it("clamps positions and display ranges", () => {
		const { doc } = normalizeDocument({
			...valid,
			nodes: [{ id: "a", label: "A", position: { x: 2, y: -1 } }],
			flows: [],
			display: { nodeWidth: 500, height: 50 },
		});
		expect(doc.nodes[0].position).toEqual({ x: 1, y: 0 });
		expect(doc.display.nodeWidth).toBe(80);
		expect(doc.display.height).toBe(120);
	});

	it("round-trips through JSON", () => {
		const first = parseDocument(JSON.stringify(valid)).doc;
		const second = parseDocument(JSON.stringify(first)).doc;
		expect(second).toEqual(first);
	});

	it("normalises a freshly created document without issues", () => {
		const { issues } = normalizeDocument(createEmptyDocument("New"));
		expect(issues).toEqual([]);
	});
});

describe("migration from unversioned data", () => {
	it("converts the D3 shape with index endpoints", () => {
		const { doc, migratedFrom } = normalizeDocument({
			nodes: [{ name: "Coal" }, { name: "Electricity" }, { name: "Homes" }],
			links: [
				{ source: 0, target: 1, value: 50 },
				{ source: 1, target: 2, value: 40 },
			],
		});
		expect(migratedFrom).toBe(0);
		expect(doc.version).toBe(1);
		expect(doc.nodes.map((n) => n.label)).toEqual(["Coal", "Electricity", "Homes"]);
		expect(doc.flows.map((f) => [f.source, f.target])).toEqual([
			["coal", "electricity"],
			["electricity", "homes"],
		]);
		expect(doc.nodes[0]).not.toHaveProperty("name");
	});

	it("resolves endpoints given by name", () => {
		const { doc } = normalizeDocument({
			nodes: [{ name: "Gas" }, { name: "Power plant" }],
			links: [{ source: "Gas", target: "Power plant", value: 7 }],
		});
		expect(doc.flows[0]).toMatchObject({ source: "gas", target: "power-plant", value: 7 });
	});
});
