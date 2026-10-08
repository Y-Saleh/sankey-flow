import type { SankeyDocument, SankeyFlow, SankeyNode } from "./schema";
import { randomId, slugify, uniqueId } from "./ids";
import { parseLink } from "./linkValue";

/**
 * Pure document mutations. They mutate the document they are given; callers
 * (the editor controller) work on a copy so every change is undoable.
 */

export function cloneDocument(doc: SankeyDocument): SankeyDocument {
	return structuredClone(doc);
}

export function nodeById(doc: SankeyDocument, id: string): SankeyNode | undefined {
	return doc.nodes.find((n) => n.id === id);
}

export function flowById(doc: SankeyDocument, id: string): SankeyFlow | undefined {
	return doc.flows.find((f) => f.id === id);
}

export function findNodeByLabel(doc: SankeyDocument, label: string): SankeyNode | undefined {
	const wanted = label.trim();
	return (
		doc.nodes.find((n) => n.label === wanted) ??
		doc.nodes.find((n) => n.label.toLocaleLowerCase() === wanted.toLocaleLowerCase())
	);
}

export function nextNodeLabel(doc: SankeyDocument): string {
	const labels = new Set(doc.nodes.map((n) => n.label));
	for (let i = doc.nodes.length + 1; ; i++) {
		if (!labels.has(`Node ${i}`)) return `Node ${i}`;
	}
}

export function addNode(doc: SankeyDocument, init: Partial<SankeyNode> & { label: string }): SankeyNode {
	const taken = new Set(doc.nodes.map((n) => n.id));
	const id = uniqueId(init.id?.trim() || slugify(init.label), taken);
	const node: SankeyNode = { ...init, id, label: init.label.trim() || id };
	doc.nodes.push(node);
	return node;
}

/** Finds a node by label or creates it. Used by importers and the flow table. */
export function ensureNode(doc: SankeyDocument, label: string, link?: string | null): SankeyNode {
	const existing = findNodeByLabel(doc, label);
	if (existing) {
		if (link && !existing.link) existing.link = link;
		return existing;
	}
	return addNode(doc, link ? { label, link } : { label });
}

export function updateNode(doc: SankeyDocument, id: string, patch: Partial<SankeyNode>): void {
	const node = nodeById(doc, id);
	if (!node) return;
	for (const [key, value] of Object.entries(patch)) {
		if (key === "id") continue;
		if (value === null || value === undefined || value === "") delete node[key];
		else node[key] = value;
	}
	if (!node.label) node.label = node.id;
}

/** Removes a node and every flow attached to it. Returns the number of flows removed. */
export function removeNode(doc: SankeyDocument, id: string): number {
	const before = doc.flows.length;
	doc.nodes = doc.nodes.filter((n) => n.id !== id);
	doc.flows = doc.flows.filter((f) => f.source !== id && f.target !== id);
	return before - doc.flows.length;
}

/** Moves a node within the node list, which sets its vertical order in the layout. */
export function moveNode(doc: SankeyDocument, id: string, toIndex: number): void {
	const from = doc.nodes.findIndex((n) => n.id === id);
	if (from < 0) return;
	const [node] = doc.nodes.splice(from, 1);
	const clamped = Math.max(0, Math.min(doc.nodes.length, toIndex));
	doc.nodes.splice(clamped, 0, node);
}

export function addFlow(
	doc: SankeyDocument,
	source: string,
	target: string,
	value: number,
	init: Partial<SankeyFlow> = {},
): SankeyFlow {
	const taken = new Set(doc.flows.map((f) => f.id));
	const flow: SankeyFlow = { ...init, id: randomId("f-", taken), source, target, value };
	doc.flows.push(flow);
	return flow;
}

export function updateFlow(doc: SankeyDocument, id: string, patch: Partial<SankeyFlow>): void {
	const flow = flowById(doc, id);
	if (!flow) return;
	for (const [key, value] of Object.entries(patch)) {
		if (key === "id") continue;
		if (value === null || value === undefined || value === "") {
			if (key !== "value" && key !== "source" && key !== "target") delete flow[key];
		} else {
			flow[key] = value;
		}
	}
}

export function removeFlow(doc: SankeyDocument, id: string): void {
	doc.flows = doc.flows.filter((f) => f.id !== id);
}

export function duplicateFlow(doc: SankeyDocument, id: string): SankeyFlow | null {
	const index = doc.flows.findIndex((f) => f.id === id);
	if (index < 0) return null;
	const taken = new Set(doc.flows.map((f) => f.id));
	const copy: SankeyFlow = { ...structuredClone(doc.flows[index]), id: randomId("f-", taken) };
	doc.flows.splice(index + 1, 0, copy);
	return copy;
}

/** A node with no flows and no user-added metadata. */
export function isImplicitOrphan(doc: SankeyDocument, id: string): boolean {
	const node = nodeById(doc, id);
	if (!node) return false;
	if (doc.flows.some((f) => f.source === id || f.target === id)) return false;
	return !node.link && !node.color && !node.description && !node.group && !node.position;
}

/**
 * Re-points one end of a flow at the node with the given label (creating it
 * if needed). A node left behind with nothing attached and no metadata is
 * removed, matching the "nodes are implied by rows" model of the data table.
 */
export function setFlowEndpointByLabel(
	doc: SankeyDocument,
	flowId: string,
	end: "source" | "target",
	label: string,
): void {
	const flow = flowById(doc, flowId);
	const trimmed = label.trim();
	if (!flow || !trimmed) return;
	const previous = flow[end];
	const node = ensureNode(doc, trimmed);
	flow[end] = node.id;
	if (previous !== node.id && isImplicitOrphan(doc, previous)) removeNode(doc, previous);
}

export function clearPositions(doc: SankeyDocument): void {
	for (const node of doc.nodes) delete node.position;
}

export interface NodeTotals {
	incoming: number;
	outgoing: number;
}

export function nodeTotals(doc: SankeyDocument): Map<string, NodeTotals> {
	const totals = new Map<string, NodeTotals>(doc.nodes.map((n) => [n.id, { incoming: 0, outgoing: 0 }]));
	for (const f of doc.flows) {
		if (!Number.isFinite(f.value) || f.value <= 0) continue;
		const s = totals.get(f.source);
		const t = totals.get(f.target);
		if (s) s.outgoing += f.value;
		if (t) t.incoming += f.value;
	}
	return totals;
}

/** Every internal link used by nodes and flows, as canonical `[[linktext]]`, deduplicated. */
export function collectInternalLinks(doc: SankeyDocument): string[] {
	const seen = new Set<string>();
	for (const item of [...doc.nodes, ...doc.flows]) {
		const parsed = parseLink(item.link ?? null);
		if (parsed?.kind === "internal") seen.add(`[[${parsed.linktext}]]`);
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

export function touch(doc: SankeyDocument, now: Date = new Date()): void {
	doc.meta.modified = now.toISOString();
}
