import type { Alignment, NodePosition } from "../model/schema";

/**
 * Sankey layout, in the spirit of d3-sankey (Bostock) with three additions
 * the editor needs:
 *
 * - Pinned nodes: nodes with a stored position keep it, expressed in
 *   normalised 0..1 coordinates so it survives resizing.
 * - Cycles never throw: flows that close a cycle are marked `circular` and
 *   drawn as loops underneath the diagram.
 * - Zero-value nodes still get a minimum height, so a freshly added node
 *   is visible and can be connected.
 *
 * The algorithm is deterministic: the same input always gives the same
 * output, and initial ordering follows the document's node order, so small
 * value edits do not reshuffle the diagram.
 */

export interface LayoutNodeInput {
	id: string;
	position?: NodePosition | null;
}

export interface LayoutFlowInput {
	id: string;
	source: string;
	target: string;
	value: number;
}

export interface LayoutOptions {
	width: number;
	height: number;
	nodeWidth: number;
	nodePadding: number;
	align: Alignment;
	iterations: number;
	minNodeHeight?: number;
}

export interface LayoutNode {
	id: string;
	index: number;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	value: number;
	inValue: number;
	outValue: number;
	depth: number;
	height: number;
	column: number;
	pinned: boolean;
	sourceLinks: LayoutLink[];
	targetLinks: LayoutLink[];
}

export interface LayoutLink {
	id: string;
	index: number;
	source: LayoutNode;
	target: LayoutNode;
	value: number;
	width: number;
	/** Centre of the band where it leaves the source. */
	y0: number;
	/** Centre of the band where it enters the target. */
	y1: number;
	circular: boolean;
	/** Stacking slot for circular links, used to offset their loops. */
	circularIndex: number;
}

export interface SankeyLayout {
	nodes: LayoutNode[];
	links: LayoutLink[];
	columns: number;
	ky: number;
	width: number;
	height: number;
	/** Extent including circular loops and pinned nodes outside the box. */
	bounds: { x0: number; y0: number; x1: number; y1: number };
	/** y coordinate below which circular loops are drawn; pass to {@link linkPath}. */
	loopBase: number;
}

export function computeLayout(
	nodeInputs: readonly LayoutNodeInput[],
	flowInputs: readonly LayoutFlowInput[],
	options: LayoutOptions,
): SankeyLayout {
	const width = Math.max(1, options.width);
	const height = Math.max(1, options.height);
	const nodeWidth = Math.max(1, Math.min(options.nodeWidth, width / 2));
	const minNodeHeight = options.minNodeHeight ?? 4;

	const nodes: LayoutNode[] = nodeInputs.map((n, index) => ({
		id: n.id,
		index,
		x0: 0,
		x1: 0,
		y0: 0,
		y1: 0,
		value: 0,
		inValue: 0,
		outValue: 0,
		depth: 0,
		height: 0,
		column: 0,
		pinned: !!n.position,
		sourceLinks: [],
		targetLinks: [],
	}));
	const byId = new Map(nodes.map((n) => [n.id, n]));

	const links: LayoutLink[] = [];
	for (const f of flowInputs) {
		const source = byId.get(f.source);
		const target = byId.get(f.target);
		if (!source || !target || source === target || !Number.isFinite(f.value) || f.value <= 0) continue;
		const link: LayoutLink = {
			id: f.id,
			index: links.length,
			source,
			target,
			value: f.value,
			width: 0,
			y0: 0,
			y1: 0,
			circular: false,
			circularIndex: 0,
		};
		links.push(link);
		source.sourceLinks.push(link);
		target.targetLinks.push(link);
	}

	markCircularLinks(nodes);
	for (const node of nodes) {
		node.inValue = sum(node.targetLinks);
		node.outValue = sum(node.sourceLinks);
		node.value = Math.max(node.inValue, node.outValue);
	}
	computeDepths(nodes);
	const columnCount = assignColumns(nodes, options.align);

	const columns: LayoutNode[][] = Array.from({ length: columnCount }, () => []);
	for (const node of nodes) columns[node.column].push(node);

	const maxPerColumn = Math.max(1, ...columns.map((c) => c.length));
	const padding = Math.max(0, Math.min(options.nodePadding, height / Math.max(1, maxPerColumn - 1) / 2));
	const ky = Math.max(
		0,
		Math.min(
			...columns.map((c) => {
				const total = c.reduce((s, n) => s + n.value, 0);
				const free = height - (c.length - 1) * padding - c.filter((n) => n.value === 0).length * minNodeHeight;
				return total > 0 ? Math.max(0, free) / total : Infinity;
			}),
		),
	);
	const scale = Number.isFinite(ky) ? ky : 1;
	const nodeHeight = (n: LayoutNode) => Math.max(minNodeHeight, n.value * scale);

	const xStep = columnCount > 1 ? (width - nodeWidth) / (columnCount - 1) : 0;
	for (const node of nodes) {
		node.x0 = columnCount > 1 ? node.column * xStep : (width - nodeWidth) / 2;
		node.x1 = node.x0 + nodeWidth;
	}

	// Initial stacking: document order, spread evenly over the free space.
	for (const column of columns) {
		let y = 0;
		for (const node of column) {
			node.y0 = y;
			node.y1 = y + nodeHeight(node);
			y = node.y1 + padding;
		}
		const spare = (height - (y - padding)) / (column.length + 1);
		if (spare > 0) column.forEach((node, i) => shift(node, spare * (i + 1)));
	}

	applyPinned(nodes, nodeInputs, width, height, nodeWidth);

	const iterations = Math.max(0, Math.round(options.iterations));
	for (let i = 0; i < iterations; i++) {
		const alpha = Math.pow(0.99, i);
		const beta = Math.max(1 - alpha, (i + 1) / iterations);
		relax(columns, alpha, "backward");
		resolveAll(columns, height, padding, beta);
		relax(columns, alpha, "forward");
		resolveAll(columns, height, padding, beta);
	}
	if (iterations === 0) resolveAll(columns, height, padding, 1);

	for (const link of links) link.width = link.value * scale;
	assignLinkOffsets(nodes);
	assignCircularSlots(links);

	const { bounds, loopBase } = computeBounds(nodes, links, width, height);
	return { nodes, links, columns: columnCount, ky: scale, width, height, bounds, loopBase };
}

function sum(links: LayoutLink[]): number {
	return links.reduce((s, l) => s + l.value, 0);
}

function shift(node: LayoutNode, dy: number): void {
	node.y0 += dy;
	node.y1 += dy;
}

/** DFS in document order; edges to a node on the current stack close a cycle. */
function markCircularLinks(nodes: LayoutNode[]): void {
	const state = new Map<LayoutNode, 0 | 1 | 2>();
	for (const root of nodes) {
		if (state.get(root)) continue;
		const stack: { node: LayoutNode; next: number }[] = [{ node: root, next: 0 }];
		state.set(root, 1);
		while (stack.length) {
			const frame = stack[stack.length - 1];
			if (frame.next >= frame.node.sourceLinks.length) {
				state.set(frame.node, 2);
				stack.pop();
				continue;
			}
			const link = frame.node.sourceLinks[frame.next++];
			const s = state.get(link.target) ?? 0;
			if (s === 1) link.circular = true;
			else if (s === 0) {
				state.set(link.target, 1);
				stack.push({ node: link.target, next: 0 });
			}
		}
	}
}

function forwardLinks(node: LayoutNode): LayoutLink[] {
	return node.sourceLinks.filter((l) => !l.circular);
}

function backwardLinks(node: LayoutNode): LayoutLink[] {
	return node.targetLinks.filter((l) => !l.circular);
}

/** Longest-path depth (from sources) and height (to sinks) over the acyclic part. */
function computeDepths(nodes: LayoutNode[]): void {
	const indegree = new Map(nodes.map((n) => [n, backwardLinks(n).length]));
	const order: LayoutNode[] = [];
	const queue = nodes.filter((n) => indegree.get(n) === 0);
	while (queue.length) {
		const node = queue.shift() as LayoutNode;
		order.push(node);
		for (const link of forwardLinks(node)) {
			link.target.depth = Math.max(link.target.depth, node.depth + 1);
			const d = (indegree.get(link.target) ?? 0) - 1;
			indegree.set(link.target, d);
			if (d === 0) queue.push(link.target);
		}
	}
	for (let i = order.length - 1; i >= 0; i--) {
		const node = order[i];
		for (const link of forwardLinks(node)) node.height = Math.max(node.height, link.target.height + 1);
	}
}

function assignColumns(nodes: LayoutNode[], align: Alignment): number {
	const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
	for (const node of nodes) {
		const hasOut = forwardLinks(node).length > 0;
		const hasIn = backwardLinks(node).length > 0;
		switch (align) {
			case "left":
				node.column = node.depth;
				break;
			case "right":
				node.column = hasIn || hasOut ? maxDepth - node.height : 0;
				break;
			case "center":
				node.column = hasIn
					? node.depth
					: hasOut
						? Math.max(0, Math.min(...forwardLinks(node).map((l) => l.target.depth)) - 1)
						: 0;
				break;
			case "justify":
			default:
				node.column = hasOut || !hasIn ? node.depth : maxDepth;
		}
	}
	// Compact away empty columns (possible with "right"/"center").
	const used = [...new Set(nodes.map((n) => n.column))].sort((a, b) => a - b);
	const remap = new Map(used.map((c, i) => [c, i]));
	for (const node of nodes) node.column = remap.get(node.column) ?? 0;
	return Math.max(1, used.length);
}

function applyPinned(
	nodes: LayoutNode[],
	inputs: readonly LayoutNodeInput[],
	width: number,
	height: number,
	nodeWidth: number,
): void {
	nodes.forEach((node, i) => {
		const pos = inputs[i].position;
		if (!pos) return;
		const h = node.y1 - node.y0;
		node.x0 = pos.x * Math.max(0, width - nodeWidth);
		node.x1 = node.x0 + nodeWidth;
		node.y0 = pos.y * Math.max(0, height - h);
		node.y1 = node.y0 + h;
	});
}

function centre(n: LayoutNode): number {
	return (n.y0 + n.y1) / 2;
}

/** Moves each free node towards the value-weighted centre of its neighbours. */
function relax(columns: LayoutNode[][], alpha: number, direction: "forward" | "backward"): void {
	const order = direction === "forward" ? columns : [...columns].reverse();
	for (const column of order) {
		for (const node of column) {
			if (node.pinned) continue;
			const links = direction === "forward" ? backwardLinks(node) : forwardLinks(node);
			if (!links.length) continue;
			let weighted = 0;
			let total = 0;
			for (const link of links) {
				const other = direction === "forward" ? link.source : link.target;
				weighted += centre(other) * link.value;
				total += link.value;
			}
			if (total <= 0) continue;
			shift(node, (weighted / total - centre(node)) * alpha);
		}
	}
}

function resolveAll(columns: LayoutNode[][], height: number, padding: number, beta: number): void {
	for (const column of columns) resolveCollisions(column, height, padding, beta);
}

/** Pushes overlapping free nodes apart and back inside [0, height]. Pinned nodes stay put. */
function resolveCollisions(column: LayoutNode[], height: number, padding: number, beta: number): void {
	const free = column.filter((n) => !n.pinned).sort((a, b) => a.y0 - b.y0 || a.index - b.index);
	if (!free.length) return;
	let y = 0;
	for (const node of free) {
		const dy = (y - node.y0) * beta;
		if (dy > 1e-6) shift(node, dy);
		if (node.y0 < y) shift(node, y - node.y0);
		y = node.y1 + padding;
	}
	let overflow = y - padding - height;
	if (overflow > 0) {
		for (let i = free.length - 1; i >= 0; i--) {
			const node = free[i];
			const limit = i === free.length - 1 ? height : free[i + 1].y0 - padding;
			const dy = Math.max(0, node.y1 - limit);
			if (dy <= 0) break;
			shift(node, -dy);
			overflow -= dy;
		}
		// If the column is simply too tall, keep the top aligned to 0.
		if (free[0].y0 < 0) {
			const dy = -free[0].y0;
			let prevBottom = -Infinity;
			for (const node of free) {
				const target = Math.max(node.y0 + dy, prevBottom + padding);
				shift(node, target - node.y0);
				prevBottom = node.y1;
			}
		}
	}
}

/** Orders links at each node by the position of the node at the other end, then stacks them. */
function assignLinkOffsets(nodes: LayoutNode[]): void {
	const byOther = (key: "source" | "target") => (a: LayoutLink, b: LayoutLink) => {
		if (a.circular !== b.circular) return a.circular ? 1 : -1;
		return a[key].y0 - b[key].y0 || a[key].index - b[key].index || a.index - b.index;
	};
	for (const node of nodes) {
		node.sourceLinks.sort(byOther("target"));
		node.targetLinks.sort(byOther("source"));
		const total = (links: LayoutLink[]) => links.reduce((s, l) => s + l.width, 0);
		// Centre the bands vertically on nodes taller than their flows (min height / mismatched in/out).
		let y = node.y0 + Math.max(0, (node.y1 - node.y0 - total(node.sourceLinks)) / 2);
		for (const link of node.sourceLinks) {
			link.y0 = y + link.width / 2;
			y += link.width;
		}
		y = node.y0 + Math.max(0, (node.y1 - node.y0 - total(node.targetLinks)) / 2);
		for (const link of node.targetLinks) {
			link.y1 = y + link.width / 2;
			y += link.width;
		}
	}
}

function assignCircularSlots(links: LayoutLink[]): void {
	let slot = 0;
	for (const link of links) if (link.circular) link.circularIndex = slot++;
}

function computeBounds(nodes: LayoutNode[], links: LayoutLink[], width: number, height: number) {
	let x0 = 0;
	let y0 = 0;
	let x1 = width;
	let y1 = height;
	for (const n of nodes) {
		x0 = Math.min(x0, n.x0);
		x1 = Math.max(x1, n.x1);
		y0 = Math.min(y0, n.y0);
		y1 = Math.max(y1, n.y1);
	}
	const loopBase = y1;
	for (const l of links) {
		if (!l.circular) continue;
		const loop = circularGeometry(linkGeometry(l), loopBase);
		y1 = Math.max(y1, loop.bottom + l.width / 2);
		x1 = Math.max(x1, loop.right + l.width / 2);
		x0 = Math.min(x0, loop.left - l.width / 2);
	}
	return { bounds: { x0, y0, x1, y1 }, loopBase };
}

/** The numbers needed to draw one link; also used for animation frames. */
export interface LinkGeometry {
	/** Right edge of the source node. */
	sx: number;
	/** Left edge of the target node. */
	tx: number;
	y0: number;
	y1: number;
	width: number;
	circular: boolean;
	circularIndex: number;
}

export function linkGeometry(link: LayoutLink): LinkGeometry {
	return {
		sx: link.source.x1,
		tx: link.target.x0,
		y0: link.y0,
		y1: link.y1,
		width: link.width,
		circular: link.circular,
		circularIndex: link.circularIndex,
	};
}

/** Geometry of the loop a circular link takes beneath the diagram. */
export function circularGeometry(g: LinkGeometry, loopBase: number) {
	const gap = 16 + g.width / 2;
	const bottom = loopBase + 18 + g.circularIndex * 10 + g.width / 2;
	return { right: g.sx + gap, left: g.tx - gap, bottom };
}

/** SVG path for a link's centre line; the band is drawn with stroke-width = width. */
export function linkPath(link: LayoutLink | LinkGeometry, loopBase: number): string {
	const g = "source" in link ? linkGeometry(link) : link;
	const { sx, tx, y0: sy, y1: ty } = g;
	if (!g.circular) {
		const mx = sx + (tx - sx) / 2;
		const back = Math.max(40, (sx - tx) / 2);
		const c1 = tx >= sx ? mx : sx + back;
		const c2 = tx >= sx ? mx : tx - back;
		return `M${r(sx)},${r(sy)}C${r(c1)},${r(sy)} ${r(c2)},${r(ty)} ${r(tx)},${r(ty)}`;
	}
	const { right, left, bottom } = circularGeometry(g, loopBase);
	return (
		`M${r(sx)},${r(sy)}` +
		`C${r(right)},${r(sy)} ${r(right)},${r(bottom)} ${r(sx)},${r(bottom)}` +
		`L${r(tx)},${r(bottom)}` +
		`C${r(left)},${r(bottom)} ${r(left)},${r(ty)} ${r(tx)},${r(ty)}`
	);
}

/**
 * Filled ribbon outline for a non-circular link. Unlike a thick stroked
 * centre line, a ribbon keeps the band's vertical thickness constant, so
 * steep flows between close columns never bulge outside their lane.
 */
export function linkRibbon(g: LinkGeometry): string {
	const half = Math.max(0.5, g.width / 2);
	const { sx, tx } = g;
	const mx = sx + (tx - sx) / 2;
	const back = Math.max(40, (sx - tx) / 2);
	const c1 = tx >= sx ? mx : sx + back;
	const c2 = tx >= sx ? mx : tx - back;
	const t0 = g.y0 - half;
	const t1 = g.y1 - half;
	const b0 = g.y0 + half;
	const b1 = g.y1 + half;
	return (
		`M${r(sx)},${r(t0)}C${r(c1)},${r(t0)} ${r(c2)},${r(t1)} ${r(tx)},${r(t1)}` +
		`L${r(tx)},${r(b1)}C${r(c2)},${r(b1)} ${r(c1)},${r(b0)} ${r(sx)},${r(b0)}Z`
	);
}

/** Re-stacks the link bands at the given nodes (used while dragging). */
export function restackLinks(nodes: Iterable<LayoutNode>): void {
	assignLinkOffsets([...nodes]);
}

function r(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Converts an absolute node top-left into the normalised position stored in the document. */
export function toNormalisedPosition(
	x0: number,
	y0: number,
	nodeHeight: number,
	options: Pick<LayoutOptions, "width" | "height" | "nodeWidth">,
): NodePosition {
	const w = Math.max(1, options.width - options.nodeWidth);
	const h = Math.max(1, options.height - nodeHeight);
	const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
	return { x: clamp(x0 / w), y: clamp(y0 / h) };
}
