import {
	computeLayout,
	linkGeometry,
	linkPath,
	linkRibbon,
	restackLinks,
	toNormalisedPosition,
	type LayoutLink,
	type LayoutNode,
	type LinkGeometry,
	type SankeyLayout,
} from "../layout/sankeyLayout";
import { isDrawableFlow, type NodePosition, type SankeyDocument, type SankeyFlow, type SankeyNode } from "../model/schema";
import { linkDisplayText, parseLink } from "../model/linkValue";
import { flowColor, groupOrder, nodeColor } from "./colors";
import type { RenderConfig } from "./config";
import { formatShare, formatValue, truncate } from "./format";

/**
 * Interactive SVG Sankey renderer.
 *
 * Deliberately independent of the Obsidian API: the host (editor view or
 * embed) supplies callbacks for navigation, menus and persistence. DOM is
 * reconciled by id, so data edits only touch the elements that changed, and
 * hover highlighting only toggles classes on the affected elements.
 */

export type Selection = { kind: "node" | "flow"; id: string } | null;
export type HitTarget = { kind: "node"; id: string } | { kind: "flow"; id: string } | { kind: "background" };

export interface RendererCallbacks {
	onSelectionChange?(selection: Selection): void;
	onClick?(target: HitTarget, evt: MouseEvent): void;
	onDoubleClick?(target: HitTarget, evt: MouseEvent): void;
	onContextMenu?(target: HitTarget, evt: MouseEvent): void;
	/** Fired on hover of an element that has a link; used for Obsidian's page preview. */
	onHoverLink?(target: HitTarget, evt: MouseEvent, el: Element): void;
	/** Keyboard: Enter on the selection. */
	onActivate?(target: HitTarget, evt: KeyboardEvent): void;
	/** Keyboard: Delete/Backspace on the selection (editable mode only). */
	onDeleteRequest?(selection: NonNullable<Selection>): void;
	/** A node was dragged to a new position (editable mode only). */
	onNodeMoved?(nodeId: string, position: NodePosition): void;
	/** A connection was dragged from a node handle (editable mode only). */
	onConnect?(sourceId: string, targetId: string | null, position: NodePosition | null): void;
	onViewChange?(): void;
	/** Called after each layout pass (colours may have changed). */
	onRender?(): void;
}

export interface RendererOptions {
	editable: boolean;
	/** Short description for screen readers. */
	ariaLabel: string;
	/** Text hint shown in node tooltips for linked nodes. */
	linkHint: string;
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface NodeEls {
	g: SVGGElement;
	rect: SVGRectElement;
	handle: SVGCircleElement | null;
	label: SVGTextElement;
	name: SVGTSpanElement;
	value: SVGTSpanElement;
}

interface LinkEls {
	path: SVGPathElement;
	gradient: SVGLinearGradientElement | null;
}

type Gesture =
	| { type: "none" }
	| { type: "pan"; pointerId: number; startX: number; startY: number; tx: number; ty: number; moved: boolean }
	| { type: "node"; pointerId: number; id: string; startX: number; startY: number; box: Box; moved: boolean }
	| { type: "connect"; pointerId: number; sourceId: string }
	| { type: "pinch"; startDistance: number; startK: number; anchor: { x: number; y: number } };

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD_X = 10;
const PAD_Y = 16;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD = 4;
const ANIMATION_MS = 240;
const SR_TABLE_LIMIT = 300;
/** Class that hides SVG and HTML parts of the diagram. */
const HIDDEN = "sankey-flow-hidden";

let instanceCounter = 0;

function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number> = {},
	parent?: Element,
): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent?.appendChild(el);
	return el;
}

function div(cls: string, parent?: HTMLElement): HTMLDivElement {
	const el = createDiv({ cls });
	parent?.appendChild(el);
	return el;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function easeOut(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export class SankeyRenderer {
	readonly el: HTMLDivElement;
	readonly svgEl: SVGSVGElement;
	private readonly instance = ++instanceCounter;
	private readonly defs: SVGDefsElement;
	private readonly viewport: SVGGElement;
	private readonly linkLayer: SVGGElement;
	private readonly nodeLayer: SVGGElement;
	private readonly labelLayer: SVGGElement;
	private readonly preview: SVGPathElement;
	private readonly tooltip: HTMLDivElement;
	private readonly live: HTMLDivElement;
	private readonly srTable: HTMLTableElement;
	private readonly emptyEl: HTMLDivElement;
	private readonly labelEl: HTMLDivElement;

	private doc: SankeyDocument | null = null;
	private config: RenderConfig | null = null;
	private layout: SankeyLayout | null = null;
	private nodeById = new Map<string, SankeyNode>();
	private flowById = new Map<string, SankeyFlow>();
	private layoutNodeById = new Map<string, LayoutNode>();
	private layoutLinkById = new Map<string, LayoutLink>();
	private nodeColors = new Map<string, string>();

	private nodeEls = new Map<string, NodeEls>();
	private linkEls = new Map<string, LinkEls>();
	private shownNodes = new Map<string, Box>();
	private shownLinks = new Map<string, LinkGeometry>();

	private size = { w: 0, h: 0 };
	private transform = { k: 1, x: PAD_X, y: PAD_Y };
	private userTransformed = false;
	private selection: Selection = null;
	private hovered: HitTarget | null = null;
	private related: Element[] = [];
	private gesture: Gesture = { type: "none" };
	private pointers = new Map<number, { x: number; y: number }>();
	private suppressClick = false;
	/** What was under the pointer at pointerdown. Pointer capture retargets the later click event, so we keep this. */
	private downTarget: HitTarget | null = null;
	private frame: number | null = null;
	private animation: number | null = null;
	private pendingAnimate = false;
	private resizeObserver: ResizeObserver | null = null;
	private destroyed = false;
	private large = false;

	constructor(
		parent: HTMLElement,
		private readonly callbacks: RendererCallbacks,
		private readonly options: RendererOptions,
	) {
		this.el = div("sankey-flow-diagram", parent);
		this.el.tabIndex = 0;
		this.el.setAttribute("role", "group");
		this.el.setAttribute("aria-roledescription", "Sankey diagram");
		// aria-labelledby rather than aria-label: Obsidian turns aria-label into a hover tooltip.
		this.labelEl = div("sankey-flow-sr-only", this.el);
		this.labelEl.id = `sankey-flow-${this.instance}-label`;
		this.labelEl.textContent = options.ariaLabel;
		this.el.setAttribute("aria-labelledby", this.labelEl.id);
		this.el.classList.toggle("is-editable", options.editable);

		this.svgEl = svg("svg", { class: "sankey-flow-svg", "aria-hidden": "true", focusable: "false" }, this.el);
		this.defs = svg("defs", {}, this.svgEl);
		this.viewport = svg("g", { class: "sankey-flow-viewport" }, this.svgEl);
		this.linkLayer = svg("g", { class: "sankey-flow-links" }, this.viewport);
		this.nodeLayer = svg("g", { class: "sankey-flow-nodes" }, this.viewport);
		this.labelLayer = svg("g", { class: "sankey-flow-labels" }, this.viewport);
		this.preview = svg("path", { class: "sankey-flow-connect-preview" }, this.viewport);
		this.preview.classList.add(HIDDEN);

		this.emptyEl = div("sankey-flow-empty", this.el);
		this.emptyEl.hide();
		this.tooltip = div("sankey-flow-tooltip", this.el);
		this.tooltip.setAttribute("role", "tooltip");
		this.live = div("sankey-flow-sr-only", this.el);
		this.live.setAttribute("aria-live", "polite");
		this.srTable = this.el.createEl("table", { cls: "sankey-flow-sr-only" });

		this.bindEvents();
		this.resizeObserver = new ResizeObserver(() => this.onResize());
		this.resizeObserver.observe(this.el);
	}

	// ── Public API ────────────────────────────────────────────────────────

	setData(doc: SankeyDocument, config: RenderConfig, animate = true): void {
		this.doc = doc;
		this.config = config;
		this.nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
		this.flowById = new Map(doc.flows.map((f) => [f.id, f]));
		if (this.selection && !this.exists(this.selection)) this.setSelection(null, true);
		this.scheduleRender(animate);
	}

	/** Shows a message instead of a diagram (empty or invalid data). */
	setMessage(message: string | null): void {
		this.emptyEl.textContent = message ?? "";
		this.emptyEl.toggle(!!message);
	}

	setSelection(selection: Selection, silent = false): void {
		const prev = this.selection;
		if (prev?.kind === selection?.kind && prev?.id === selection?.id) return;
		if (prev) this.elementFor(prev)?.classList.remove("is-selected");
		this.selection = selection && this.exists(selection) ? selection : null;
		if (this.selection) this.elementFor(this.selection)?.classList.add("is-selected");
		this.el.classList.toggle("has-selection", !!this.selection);
		if (!silent) this.callbacks.onSelectionChange?.(this.selection);
	}

	/** Highlights an element from outside the diagram (e.g. hovering a table row). */
	setExternalHover(target: HitTarget | null): void {
		this.applyHover(target);
	}

	fitView(): void {
		this.userTransformed = false;
		this.applyFit();
		this.callbacks.onViewChange?.();
	}

	zoomBy(factor: number): void {
		const { w, h } = this.size;
		this.zoomAround(w / 2, h / 2, factor);
	}

	/** Colour currently used for a node (a CSS expression). */
	colorOf(nodeId: string): string {
		return this.nodeColors.get(nodeId) ?? "var(--interactive-accent)";
	}

	/** Content extent in layout coordinates, with room for labels. */
	contentBounds(): Box {
		const b = this.layout?.bounds ?? { x0: 0, y0: 0, x1: 100, y1: 100 };
		let { x0, x1 } = b;
		for (const els of this.nodeEls.values()) {
			if (els.label.classList.contains(HIDDEN)) continue;
			try {
				const bb = els.label.getBBox();
				x0 = Math.min(x0, bb.x);
				x1 = Math.max(x1, bb.x + bb.width);
			} catch {
				// getBBox throws when not rendered; bounds stay as computed.
			}
		}
		return { x0: x0 - PAD_X, y0: b.y0 - PAD_Y, x1: x1 + PAD_X, y1: b.y1 + PAD_Y };
	}

	focus(): void {
		this.el.focus({ preventScroll: true });
	}

	destroy(): void {
		this.destroyed = true;
		this.resizeObserver?.disconnect();
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		if (this.animation !== null) window.cancelAnimationFrame(this.animation);
		this.el.remove();
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	private scheduleRender(animate: boolean): void {
		this.pendingAnimate = this.pendingAnimate || animate;
		if (this.frame !== null || this.destroyed) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			const anim = this.pendingAnimate;
			this.pendingAnimate = false;
			this.render(anim);
		});
	}

	/** Layout size of the container. clientWidth/Height ignore CSS transforms (e.g. Canvas zoom). */
	private measure(): { w: number; h: number } {
		return { w: this.el.clientWidth, h: this.el.clientHeight };
	}

	private onResize(): void {
		const { w, h } = this.measure();
		if (w === this.size.w && h === this.size.h) return;
		this.size = { w, h };
		if (this.doc) this.scheduleRender(false);
	}

	private render(animate: boolean): void {
		const doc = this.doc;
		const config = this.config;
		if (!doc || !config || this.destroyed) return;
		if (!this.size.w || !this.size.h) {
			this.size = this.measure();
			if (!this.size.w || !this.size.h) return; // Hidden; ResizeObserver will retry.
		}

		const drawable = doc.flows.filter((f) => isDrawableFlow(f) && this.nodeById.has(f.source) && this.nodeById.has(f.target));
		this.large = drawable.length > config.largeThreshold;
		this.el.classList.toggle("is-large", this.large);
		this.el.style.setProperty("--sankey-flow-opacity", String(config.flowOpacity));
		this.el.style.setProperty("--sankey-flow-hover-opacity", String(config.flowHoverOpacity));
		this.el.dataset.border = config.border;

		const layout = computeLayout(doc.nodes, drawable, {
			width: Math.max(240, this.size.w - PAD_X * 2),
			height: Math.max(80, this.size.h - PAD_Y * 2),
			nodeWidth: config.nodeWidth,
			nodePadding: config.nodePadding,
			align: config.align,
			iterations: this.large ? Math.min(config.iterations, 3) : config.iterations,
			minNodeHeight: 4,
		});
		this.layout = layout;
		this.layoutNodeById = new Map(layout.nodes.map((n) => [n.id, n]));
		this.layoutLinkById = new Map(layout.links.map((l) => [l.id, l]));

		const groups = groupOrder(doc.nodes);
		this.nodeColors = new Map(
			layout.nodes.map((ln) => {
				const node = this.nodeById.get(ln.id) as SankeyNode;
				const color = nodeColor(
					{ index: ln.index, column: ln.column, columnCount: layout.columns, group: node.group, explicit: node.color },
					config.colors,
					groups,
				);
				return [ln.id, color];
			}),
		);

		this.reconcileLinks(layout, config);
		this.reconcileNodes(layout, config);
		this.updateAccessibility(doc, layout);
		this.setMessage(doc.nodes.length ? null : this.options.editable ? "Add a node or import data to get started." : "This diagram is empty.");

		const shouldAnimate =
			animate && config.animations && !this.large && !prefersReducedMotion() && this.shownNodes.size > 0;
		if (shouldAnimate) this.animateTo(layout);
		else this.drawFrame(layout, 1, true);

		if (!this.userTransformed) this.applyFit();
		if (this.selection) this.elementFor(this.selection)?.classList.add("is-selected");
		this.callbacks.onRender?.();
	}

	private reconcileLinks(layout: SankeyLayout, config: RenderConfig): void {
		const seen = new Set<string>();
		for (const link of layout.links) {
			seen.add(link.id);
			let els = this.linkEls.get(link.id);
			if (!els) {
				const path = svg("path", { class: "sankey-flow-link" }, this.linkLayer);
				path.dataset.kind = "flow";
				path.dataset.id = link.id;
				els = { path, gradient: null };
				this.linkEls.set(link.id, els);
			}
			const flow = this.flowById.get(link.id) as SankeyFlow;
			const color = flowColor(
				{
					explicit: flow.color,
					sourceColor: this.nodeColors.get(link.source.id) ?? "var(--text-muted)",
					targetColor: this.nodeColors.get(link.target.id) ?? "var(--text-muted)",
				},
				this.large && config.flowColorMode === "gradient" ? "source" : config.flowColorMode,
				config.defaultFlowColor,
			);
			if (Array.isArray(color)) {
				if (!els.gradient) {
					els.gradient = svg("linearGradient", { id: `sankey-flow-${this.instance}-g-${link.index}`, gradientUnits: "userSpaceOnUse" }, this.defs);
					svg("stop", { offset: "0%" }, els.gradient);
					svg("stop", { offset: "100%" }, els.gradient);
				}
				els.gradient.id = `sankey-flow-${this.instance}-g-${link.index}`;
				const [a, b] = Array.from(els.gradient.children) as SVGStopElement[];
				a.style.setProperty("stop-color", color[0]);
				b.style.setProperty("stop-color", color[1]);
				els.path.style.setProperty("--sankey-link-color", `url(#${els.gradient.id})`);
			} else {
				els.gradient?.remove();
				els.gradient = null;
				els.path.style.setProperty("--sankey-link-color", color);
			}
			els.path.classList.toggle("is-circular", link.circular);
			els.path.classList.toggle("has-link", !!flow.link);
		}
		for (const [id, els] of this.linkEls) {
			if (seen.has(id)) continue;
			els.path.remove();
			els.gradient?.remove();
			this.linkEls.delete(id);
			this.shownLinks.delete(id);
		}
		// Keep DOM order aligned with layout order so thin flows draw above thick ones consistently.
		const ordered = [...layout.links].sort((a, b) => b.width - a.width);
		for (const link of ordered) {
			const path = this.linkEls.get(link.id)?.path;
			if (path) this.linkLayer.appendChild(path);
		}
	}

	private reconcileNodes(layout: SankeyLayout, config: RenderConfig): void {
		const seen = new Set<string>();
		const half = layout.width / 2;
		for (const ln of layout.nodes) {
			seen.add(ln.id);
			const node = this.nodeById.get(ln.id) as SankeyNode;
			let els = this.nodeEls.get(ln.id);
			if (!els) {
				const g = svg("g", { class: "sankey-flow-node" }, this.nodeLayer);
				g.dataset.kind = "node";
				g.dataset.id = ln.id;
				const rect = svg("rect", { class: "sankey-flow-node-rect" }, g);
				const handle = this.options.editable ? svg("circle", { class: "sankey-flow-handle", r: 5 }, g) : null;
				if (handle) handle.dataset.handle = "1";
				const label = svg("text", { class: "sankey-flow-label", dy: "0.35em" }, this.labelLayer);
				label.dataset.kind = "node";
				label.dataset.id = ln.id;
				const name = svg("tspan", { class: "sankey-flow-label-name" }, label);
				const value = svg("tspan", { class: "sankey-flow-label-value", dx: "0.4em" }, label);
				els = { g, rect, handle, label, name, value };
				this.nodeEls.set(ln.id, els);
			}
			els.rect.style.setProperty("fill", this.nodeColors.get(ln.id) ?? "var(--interactive-accent)");
			els.rect.setAttribute("rx", String(Math.min(config.cornerRadius, config.nodeWidth / 2)));
			els.g.classList.toggle("has-link", !!node.link);
			els.g.classList.toggle("is-pinned", ln.pinned);
			els.label.classList.toggle("has-link", !!node.link);

			const showLabel = config.showLabels && !(this.large && ln.y1 - ln.y0 < 7);
			els.label.classList.toggle(HIDDEN, !showLabel);
			els.name.textContent = truncate(node.label, 48);
			els.value.textContent = config.showValues ? formatValue(ln.value, config.format) : "";
			const right = (ln.x0 + ln.x1) / 2 < half || layout.columns === 1;
			els.label.setAttribute("text-anchor", right ? "start" : "end");
			els.label.dataset.side = right ? "right" : "left";
		}
		for (const [id, els] of this.nodeEls) {
			if (seen.has(id)) continue;
			els.g.remove();
			els.label.remove();
			this.nodeEls.delete(id);
			this.shownNodes.delete(id);
		}
	}

	/** Draws the layout, optionally interpolating from what is currently shown. */
	private drawFrame(layout: SankeyLayout, t: number, final: boolean): void {
		const nodeBox = new Map<string, Box>();
		for (const ln of layout.nodes) {
			const from = this.shownNodes.get(ln.id);
			const box =
				from && t < 1
					? { x0: lerp(from.x0, ln.x0, t), y0: lerp(from.y0, ln.y0, t), x1: lerp(from.x1, ln.x1, t), y1: lerp(from.y1, ln.y1, t) }
					: { x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1 };
			nodeBox.set(ln.id, box);
			this.positionNode(ln.id, box);
		}
		const linkGeo = new Map<string, LinkGeometry>();
		for (const link of layout.links) {
			const to = linkGeometry(link);
			const from = this.shownLinks.get(link.id);
			let g = to;
			if (t < 1) {
				const start = from ?? { ...to, width: 0 };
				g = {
					sx: nodeBox.get(link.source.id)?.x1 ?? to.sx,
					tx: nodeBox.get(link.target.id)?.x0 ?? to.tx,
					y0: lerp(start.y0, to.y0, t),
					y1: lerp(start.y1, to.y1, t),
					width: lerp(start.width, to.width, t),
					circular: to.circular,
					circularIndex: to.circularIndex,
				};
			}
			linkGeo.set(link.id, g);
			this.positionLink(link.id, g, layout.loopBase);
		}
		if (final) {
			this.shownNodes = nodeBox;
			this.shownLinks = linkGeo;
		} else {
			this.frameNodes = nodeBox;
			this.frameLinks = linkGeo;
		}
	}

	private frameNodes = new Map<string, Box>();
	private frameLinks = new Map<string, LinkGeometry>();

	private animateTo(layout: SankeyLayout): void {
		if (this.animation !== null) {
			window.cancelAnimationFrame(this.animation);
			// Continue from wherever the interrupted animation got to.
			this.shownNodes = new Map([...this.shownNodes, ...this.frameNodes]);
			this.shownLinks = new Map([...this.shownLinks, ...this.frameLinks]);
		}
		const start = performance.now();
		const step = (now: number) => {
			if (this.destroyed || this.layout !== layout) return;
			const t = Math.min(1, (now - start) / ANIMATION_MS);
			const done = t >= 1;
			this.drawFrame(layout, done ? 1 : easeOut(t), done);
			this.animation = done ? null : window.requestAnimationFrame(step);
		};
		this.animation = window.requestAnimationFrame(step);
	}

	private positionNode(id: string, box: Box): void {
		const els = this.nodeEls.get(id);
		if (!els) return;
		const h = Math.max(1, box.y1 - box.y0);
		els.rect.setAttribute("x", r(box.x0));
		els.rect.setAttribute("y", r(box.y0));
		els.rect.setAttribute("width", r(box.x1 - box.x0));
		els.rect.setAttribute("height", r(h));
		if (els.handle) {
			els.handle.setAttribute("cx", r(box.x1));
			els.handle.setAttribute("cy", r(box.y0 + h / 2));
		}
		const right = els.label.dataset.side === "right";
		els.label.setAttribute("x", r(right ? box.x1 + 6 : box.x0 - 6));
		els.label.setAttribute("y", r(box.y0 + h / 2));
	}

	private positionLink(id: string, g: LinkGeometry, loopBase: number): void {
		const els = this.linkEls.get(id);
		if (!els) return;
		if (g.circular) {
			els.path.setAttribute("d", linkPath(g, loopBase));
			els.path.setAttribute("stroke-width", r(Math.max(1, g.width)));
		} else {
			els.path.setAttribute("d", linkRibbon(g));
			els.path.removeAttribute("stroke-width");
		}
		if (els.gradient) {
			els.gradient.setAttribute("x1", r(g.sx));
			els.gradient.setAttribute("x2", r(g.tx));
		}
	}

	private updateAccessibility(doc: SankeyDocument, layout: SankeyLayout): void {
		const title = doc.meta.title || "Untitled diagram";
		this.labelEl.textContent = `${this.options.ariaLabel}: ${title}. ${layout.nodes.length} nodes, ${layout.links.length} flows. Use arrow keys to move between nodes.`;
		// A hidden table gives screen readers the full data, independent of colour or geometry.
		this.srTable.replaceChildren();
		this.srTable.createEl("caption", { text: `Flows in ${title}` });
		const head = this.srTable.createTHead().insertRow();
		for (const h of ["Source", "Target", "Value"]) {
			head.createEl("th", { text: h });
		}
		const body = this.srTable.createTBody();
		const config = this.config as RenderConfig;
		for (const link of layout.links.slice(0, SR_TABLE_LIMIT)) {
			const row = body.insertRow();
			row.insertCell().textContent = this.nodeById.get(link.source.id)?.label ?? link.source.id;
			row.insertCell().textContent = this.nodeById.get(link.target.id)?.label ?? link.target.id;
			row.insertCell().textContent = formatValue(link.value, config.format);
		}
	}

	// ── View transform ───────────────────────────────────────────────────

	private applyTransform(): void {
		const { k, x, y } = this.transform;
		this.viewport.setAttribute("transform", `translate(${r(x)},${r(y)}) scale(${Math.round(k * 1000) / 1000})`);
		this.el.classList.toggle("is-zoomed", this.userTransformed);
	}

	private applyFit(): void {
		const b = this.layout?.bounds;
		const { w, h } = this.size;
		if (!b || !w || !h) return;
		const bw = Math.max(1, b.x1 - b.x0);
		const bh = Math.max(1, b.y1 - b.y0);
		const k = Math.min(1, (w - PAD_X * 2) / bw, (h - PAD_Y * 2) / bh);
		this.transform = {
			k,
			x: PAD_X + (w - PAD_X * 2 - bw * k) / 2 - b.x0 * k,
			y: PAD_Y + (h - PAD_Y * 2 - bh * k) / 2 - b.y0 * k,
		};
		this.applyTransform();
	}

	private zoomAround(px: number, py: number, factor: number): void {
		const { k, x, y } = this.transform;
		const nk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
		if (nk === k) return;
		this.transform = { k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk };
		this.userTransformed = true;
		this.applyTransform();
		this.callbacks.onViewChange?.();
	}

	/** Client coordinates → layout coordinates. */
	private toLayout(clientX: number, clientY: number): { x: number; y: number } {
		const p = this.localPoint({ clientX, clientY });
		const { k, x, y } = this.transform;
		return { x: (p.x - x) / k, y: (p.y - y) / k };
	}

	/** Client coordinates → unscaled container coordinates, correcting for ancestor CSS transforms. */
	private localPoint(evt: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = this.el.getBoundingClientRect();
		const sx = this.el.clientWidth ? rect.width / this.el.clientWidth : 1;
		const sy = this.el.clientHeight ? rect.height / this.el.clientHeight : 1;
		return { x: (evt.clientX - rect.left) / (sx || 1), y: (evt.clientY - rect.top) / (sy || 1) };
	}

	// ── Events ────────────────────────────────────────────────────────────

	private bindEvents(): void {
		const el = this.el;
		el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		el.addEventListener("pointermove", (e) => this.onPointerMove(e));
		el.addEventListener("pointerup", (e) => this.onPointerUp(e));
		el.addEventListener("pointercancel", (e) => this.onPointerUp(e, true));
		el.addEventListener("pointerleave", () => {
			if (this.gesture.type === "none") {
				this.applyHover(null);
				this.hideTooltip();
			}
		});
		el.addEventListener("click", (e) => this.onClick(e));
		el.addEventListener("dblclick", (e) => this.onDoubleClick(e));
		el.addEventListener("contextmenu", (e) => this.onContextMenu(e));
		el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		el.addEventListener("keydown", (e) => this.onKeyDown(e));
		el.addEventListener("focus", () => {
			if (!this.selection && this.el.matches(":focus-visible")) this.announceSelection();
		});
	}

	private hitTest(target: EventTarget | null): HitTarget {
		const el = target instanceof Element ? target.closest<SVGElement>("[data-kind]") : null;
		if (el && this.el.contains(el)) {
			const id = el.dataset.id ?? "";
			if (el.dataset.kind === "node") return { kind: "node", id };
			if (el.dataset.kind === "flow") return { kind: "flow", id };
		}
		return { kind: "background" };
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0 && e.button !== 1) return;
		this.pointers.set(e.pointerId, this.localPoint(e));
		this.hideTooltip();

		if (this.pointers.size === 2 && this.options.editable) {
			const [a, b] = [...this.pointers.values()];
			this.gesture = {
				type: "pinch",
				startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
				startK: this.transform.k,
				anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
			};
			return;
		}
		if (this.pointers.size > 1) return;

		const target = this.hitTest(e.target);
		this.downTarget = target;
		const isHandle = e.target instanceof Element && !!e.target.closest("[data-handle]");
		const p = this.localPoint(e);

		if (this.options.editable && e.button === 0 && target.kind === "node" && isHandle) {
			this.gesture = { type: "connect", pointerId: e.pointerId, sourceId: target.id };
			this.el.setPointerCapture(e.pointerId);
			this.el.classList.add("is-connecting");
			e.preventDefault();
			return;
		}
		if (this.options.editable && e.button === 0 && target.kind === "node") {
			const ln = this.layoutNodeById.get(target.id);
			if (ln) {
				this.gesture = {
					type: "node",
					pointerId: e.pointerId,
					id: target.id,
					startX: p.x,
					startY: p.y,
					box: { x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1 },
					moved: false,
				};
				this.el.setPointerCapture(e.pointerId);
				return;
			}
		}
		const canPan = this.config?.pan && (e.pointerType !== "touch" || this.options.editable);
		if (canPan && (target.kind === "background" || e.button === 1)) {
			this.gesture = { type: "pan", pointerId: e.pointerId, startX: p.x, startY: p.y, tx: this.transform.x, ty: this.transform.y, moved: false };
			this.el.setPointerCapture(e.pointerId);
			if (e.button === 1) e.preventDefault();
		}
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.localPoint(e));
		const g = this.gesture;
		const p = this.localPoint(e);

		switch (g.type) {
			case "pinch": {
				const pts = [...this.pointers.values()];
				if (pts.length < 2) return;
				const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
				const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.startK * (dist / g.startDistance)));
				this.zoomAround(g.anchor.x, g.anchor.y, target / this.transform.k);
				return;
			}
			case "pan": {
				if (e.pointerId !== g.pointerId) return;
				const dx = p.x - g.startX;
				const dy = p.y - g.startY;
				if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
				g.moved = true;
				this.el.classList.add("is-panning");
				this.transform = { ...this.transform, x: g.tx + dx, y: g.ty + dy };
				this.userTransformed = true;
				this.applyTransform();
				return;
			}
			case "node": {
				if (e.pointerId !== g.pointerId) return;
				const dx = (p.x - g.startX) / this.transform.k;
				const dy = (p.y - g.startY) / this.transform.k;
				if (!g.moved && Math.hypot(dx, dy) * this.transform.k < DRAG_THRESHOLD) return;
				g.moved = true;
				this.el.classList.add("is-dragging");
				this.moveNodeLive(g.id, { x0: g.box.x0 + dx, y0: g.box.y0 + dy, x1: g.box.x1 + dx, y1: g.box.y1 + dy });
				return;
			}
			case "connect": {
				if (e.pointerId !== g.pointerId) return;
				const ln = this.layoutNodeById.get(g.sourceId);
				if (!ln) return;
				const to = this.toLayout(e.clientX, e.clientY);
				const sx = ln.x1;
				const sy = (ln.y0 + ln.y1) / 2;
				const mx = sx + (to.x - sx) / 2;
				this.preview.setAttribute("d", `M${r(sx)},${r(sy)}C${r(mx)},${r(sy)} ${r(mx)},${r(to.y)} ${r(to.x)},${r(to.y)}`);
				this.preview.classList.remove(HIDDEN);
				const over = this.hitTest(document.elementFromPoint(e.clientX, e.clientY));
				this.applyHover(over.kind === "node" && over.id !== g.sourceId ? over : null);
				return;
			}
			case "none": {
				if (e.pointerType === "touch") return;
				const target = this.hitTest(e.target);
				if (!sameTarget(target, this.hovered)) {
					this.applyHover(target.kind === "background" ? null : target);
					if (target.kind !== "background") this.maybeHoverLink(target, e);
				}
				if (target.kind === "background") this.hideTooltip();
				else this.showTooltip(target, e);
				return;
			}
		}
	}

	private onPointerUp(e: PointerEvent, cancelled = false): void {
		this.pointers.delete(e.pointerId);
		const g = this.gesture;
		if (this.el.hasPointerCapture?.(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
		this.el.classList.remove("is-panning", "is-dragging", "is-connecting");

		if (g.type === "pinch") {
			if (this.pointers.size < 2) this.gesture = { type: "none" };
			this.suppressClick = true;
			return;
		}
		if (g.type === "none" || ("pointerId" in g && g.pointerId !== e.pointerId)) return;
		this.gesture = { type: "none" };

		if (g.type === "pan") {
			if (g.moved) {
				this.suppressClick = true;
				this.callbacks.onViewChange?.();
			}
			return;
		}
		if (g.type === "node") {
			if (!g.moved || cancelled) {
				if (cancelled) this.drawFrame(this.layout as SankeyLayout, 1, true);
				return;
			}
			this.suppressClick = true;
			const ln = this.layoutNodeById.get(g.id);
			if (ln && this.layout) {
				const pos = toNormalisedPosition(ln.x0, ln.y0, ln.y1 - ln.y0, {
					width: this.layout.width,
					height: this.layout.height,
					nodeWidth: ln.x1 - ln.x0,
				});
				this.callbacks.onNodeMoved?.(g.id, pos);
			}
			return;
		}
		if (g.type === "connect") {
			this.preview.classList.add(HIDDEN);
			this.applyHover(null);
			this.suppressClick = true;
			if (cancelled) return;
			const over = this.hitTest(document.elementFromPoint(e.clientX, e.clientY));
			if (over.kind === "node") {
				if (over.id !== g.sourceId) this.callbacks.onConnect?.(g.sourceId, over.id, null);
				return;
			}
			const pt = this.toLayout(e.clientX, e.clientY);
			const layout = this.layout;
			if (!layout) return;
			const nodeWidth = this.config?.nodeWidth ?? 12;
			const pos = toNormalisedPosition(pt.x, pt.y - 10, 20, { width: layout.width, height: layout.height, nodeWidth });
			this.callbacks.onConnect?.(g.sourceId, null, pos);
		}
	}

	/** Moves a node during a drag without re-running the layout. */
	private moveNodeLive(id: string, box: Box): void {
		const layout = this.layout;
		const ln = this.layoutNodeById.get(id);
		if (!layout || !ln) return;
		const dy = box.y0 - ln.y0;
		ln.x0 = box.x0;
		ln.x1 = box.x1;
		ln.y0 += dy;
		ln.y1 += dy;
		const affected = new Set<LayoutNode>([ln]);
		for (const l of ln.sourceLinks) affected.add(l.target);
		for (const l of ln.targetLinks) affected.add(l.source);
		restackLinks(affected);
		for (const n of affected) {
			const b = { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 };
			this.positionNode(n.id, b);
			this.shownNodes.set(n.id, b);
			for (const l of [...n.sourceLinks, ...n.targetLinks]) {
				const geo = linkGeometry(l);
				this.positionLink(l.id, geo, layout.loopBase);
				this.shownLinks.set(l.id, geo);
			}
		}
	}

	private onClick(e: MouseEvent): void {
		const down = this.downTarget;
		this.downTarget = null;
		if (this.suppressClick) {
			this.suppressClick = false;
			return;
		}
		const target = down ?? this.hitTest(e.target);
		this.setSelection(target.kind === "background" ? null : target);
		this.callbacks.onClick?.(target, e);
	}

	private onDoubleClick(e: MouseEvent): void {
		const under = this.hitTest(document.elementFromPoint(e.clientX, e.clientY));
		const target = under.kind === "background" ? this.hitTest(e.target) : under;
		if (target.kind === "background") {
			this.fitView();
			return;
		}
		this.callbacks.onDoubleClick?.(target, e);
	}

	private onContextMenu(e: MouseEvent): void {
		if (!this.callbacks.onContextMenu) return;
		const target = this.hitTest(e.target);
		e.preventDefault();
		if (target.kind !== "background") this.setSelection(target);
		this.hideTooltip();
		this.callbacks.onContextMenu(target, e);
	}

	private onWheel(e: WheelEvent): void {
		const mode = this.config?.wheel ?? "off";
		if (mode === "off") return;
		const mod = e.ctrlKey || e.metaKey;
		const p = this.localPoint(e);
		if (mode === "zoom" || mod) {
			e.preventDefault();
			const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			this.zoomAround(p.x, p.y, Math.exp(-delta * (mod ? 0.01 : 0.0015)));
			return;
		}
		// "mod-zoom": plain wheel pans inside the editor, and is left alone in embeds.
		if (this.options.editable) {
			e.preventDefault();
			this.transform = { ...this.transform, x: this.transform.x - e.deltaX, y: this.transform.y - e.deltaY };
			this.userTransformed = true;
			this.applyTransform();
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.target !== this.el) return; // Never interfere with inputs or the rest of Obsidian.
		const mod = e.ctrlKey || e.metaKey;
		if (mod || e.altKey) return;
		switch (e.key) {
			case "ArrowUp":
			case "ArrowDown":
			case "ArrowLeft":
			case "ArrowRight":
				this.moveSelection(e.key);
				break;
			case "Enter":
				if (!this.selection) return;
				this.callbacks.onActivate?.(this.selection, e);
				break;
			case "Delete":
			case "Backspace":
				if (!this.options.editable || !this.selection) return;
				this.callbacks.onDeleteRequest?.(this.selection);
				break;
			case "Escape":
				if (this.gesture.type === "connect") {
					this.preview.classList.add(HIDDEN);
					this.gesture = { type: "none" };
				} else if (this.selection) {
					this.setSelection(null);
				} else return;
				break;
			case "+":
			case "=":
				this.zoomBy(1.25);
				break;
			case "-":
			case "_":
				this.zoomBy(0.8);
				break;
			case "0":
				this.fitView();
				break;
			case "ContextMenu":
				this.openContextMenuForSelection();
				break;
			case "F10":
				if (!e.shiftKey) return;
				this.openContextMenuForSelection();
				break;
			default:
				return;
		}
		e.preventDefault();
		e.stopPropagation();
	}

	private openContextMenuForSelection(): void {
		const sel = this.selection;
		const el = sel ? this.elementFor(sel) : null;
		const rect = (el ?? this.el).getBoundingClientRect();
		const evt = new MouseEvent("contextmenu", { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
		this.callbacks.onContextMenu?.(sel ?? { kind: "background" }, evt);
	}

	/** Arrow-key navigation: up/down within a column, left/right to the nearest node in the next column. */
	private moveSelection(key: string): void {
		const layout = this.layout;
		if (!layout || !layout.nodes.length) return;
		const current = this.selection?.kind === "node" ? this.layoutNodeById.get(this.selection.id) : undefined;
		let next: LayoutNode | undefined;
		if (!current) {
			next = [...layout.nodes].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0)[0];
		} else if (key === "ArrowUp" || key === "ArrowDown") {
			const column = layout.nodes.filter((n) => n.column === current.column).sort((a, b) => a.y0 - b.y0);
			const i = column.indexOf(current) + (key === "ArrowDown" ? 1 : -1);
			next = column[Math.max(0, Math.min(column.length - 1, i))];
		} else {
			const dir = key === "ArrowRight" ? 1 : -1;
			const cy = (current.y0 + current.y1) / 2;
			const candidates = layout.nodes.filter((n) => (dir > 0 ? n.x0 > current.x0 + 1 : n.x0 < current.x0 - 1));
			const nearestX = candidates.reduce((best, n) => Math.min(best, Math.abs(n.x0 - current.x0)), Infinity);
			next = candidates
				.filter((n) => Math.abs(Math.abs(n.x0 - current.x0) - nearestX) < 1)
				.sort((a, b) => Math.abs((a.y0 + a.y1) / 2 - cy) - Math.abs((b.y0 + b.y1) / 2 - cy))[0];
		}
		if (!next) return;
		this.setSelection({ kind: "node", id: next.id });
		this.applyHover({ kind: "node", id: next.id });
		this.announceSelection();
	}

	private announceSelection(): void {
		const sel = this.selection;
		if (!sel) {
			this.live.textContent = "No node selected. Use arrow keys to select a node.";
			return;
		}
		this.live.textContent = this.describe(sel);
	}

	private describe(target: NonNullable<Selection>): string {
		const config = this.config as RenderConfig;
		if (target.kind === "node") {
			const node = this.nodeById.get(target.id);
			const ln = this.layoutNodeById.get(target.id);
			if (!node || !ln) return "";
			const parts = [
				`${node.label}, ${formatValue(ln.value, config.format)}`,
				`${ln.targetLinks.length} incoming, ${ln.sourceLinks.length} outgoing flows`,
			];
			if (node.link) parts.push(`linked to ${linkDisplayText(node.link)}`);
			return parts.join(". ");
		}
		const link = this.layoutLinkById.get(target.id);
		if (!link) return "";
		const s = this.nodeById.get(link.source.id)?.label ?? "";
		const t = this.nodeById.get(link.target.id)?.label ?? "";
		return `Flow from ${s} to ${t}, ${formatValue(link.value, config.format)}`;
	}

	// ── Hover & tooltips ─────────────────────────────────────────────────

	private applyHover(target: HitTarget | null): void {
		this.hovered = target;
		for (const el of this.related) el.classList.remove("is-related");
		this.related = [];
		const highlight = this.config?.highlight ?? true;
		if (!target || target.kind === "background" || !highlight) {
			this.el.classList.remove("has-hover");
			return;
		}
		const add = (el: Element | undefined | null) => {
			if (!el) return;
			el.classList.add("is-related");
			this.related.push(el);
		};
		const addNode = (id: string) => {
			const els = this.nodeEls.get(id);
			add(els?.g);
			add(els?.label);
		};
		if (target.kind === "node") {
			const ln = this.layoutNodeById.get(target.id);
			addNode(target.id);
			for (const l of [...(ln?.sourceLinks ?? []), ...(ln?.targetLinks ?? [])]) {
				add(this.linkEls.get(l.id)?.path);
				addNode(l.source.id);
				addNode(l.target.id);
			}
		} else {
			const link = this.layoutLinkById.get(target.id);
			add(this.linkEls.get(target.id)?.path);
			if (link) {
				addNode(link.source.id);
				addNode(link.target.id);
			}
		}
		this.el.classList.add("has-hover");
	}

	private maybeHoverLink(target: HitTarget, e: MouseEvent): void {
		if (target.kind === "background") return;
		const item = target.kind === "node" ? this.nodeById.get(target.id) : this.flowById.get(target.id);
		const el = this.elementFor(target);
		if (item?.link && el) this.callbacks.onHoverLink?.(target, e, el);
	}

	private showTooltip(target: HitTarget, e: MouseEvent): void {
		if (!this.config?.tooltips || target.kind === "background") return;
		const tip = this.tooltip;
		if (tip.dataset.for !== `${target.kind}:${target.id}`) {
			tip.replaceChildren();
			if (target.kind === "node") this.fillNodeTooltip(tip, target.id);
			else this.fillFlowTooltip(tip, target.id);
			tip.dataset.for = `${target.kind}:${target.id}`;
		}
		tip.classList.add("is-visible");
		const p = this.localPoint(e);
		const { w, h } = this.size;
		const tw = tip.offsetWidth;
		const th = tip.offsetHeight;
		let x = p.x + 14;
		let y = p.y + 14;
		if (x + tw > w - 4) x = Math.max(4, p.x - tw - 14);
		if (y + th > h - 4) y = Math.max(4, p.y - th - 14);
		tip.setCssProps({ "--sankey-flow-tip-x": `${Math.round(x)}px`, "--sankey-flow-tip-y": `${Math.round(y)}px` });
	}

	private hideTooltip(): void {
		this.tooltip.classList.remove("is-visible");
		delete this.tooltip.dataset.for;
	}

	private fillNodeTooltip(tip: HTMLElement, id: string): void {
		const node = this.nodeById.get(id);
		const ln = this.layoutNodeById.get(id);
		const config = this.config as RenderConfig;
		if (!node || !ln) return;
		const header = div("sankey-flow-tooltip-title", tip);
		const swatch = div("sankey-flow-swatch", header);
		swatch.setCssProps({ "--sankey-flow-swatch": this.nodeColors.get(id) ?? "" });
		header.append(document.createTextNode(node.label));
		if (node.group) div("sankey-flow-tooltip-chip", header).textContent = node.group;

		const totals = div("sankey-flow-tooltip-meta", tip);
		totals.textContent =
			ln.inValue && ln.outValue && Math.abs(ln.inValue - ln.outValue) > 1e-9
				? `In ${formatValue(ln.inValue, config.format)} · Out ${formatValue(ln.outValue, config.format)}`
				: `Total ${formatValue(ln.value, config.format)}`;

		const section = (title: string, links: LayoutLink[], other: "source" | "target", total: number) => {
			if (!links.length) return;
			div("sankey-flow-tooltip-section", tip).textContent = title;
			const sorted = [...links].sort((a, b) => b.value - a.value);
			for (const l of sorted.slice(0, 6)) {
				const row = div("sankey-flow-tooltip-row", tip);
				const name = div("sankey-flow-tooltip-name", row);
				name.textContent =
					other === "source"
						? `${this.nodeById.get(l.source.id)?.label ?? ""} → ${node.label}`
						: `${node.label} → ${this.nodeById.get(l.target.id)?.label ?? ""}`;
				const value = div("sankey-flow-tooltip-value", row);
				value.textContent = `${formatValue(l.value, config.format)}`;
				const share = div("sankey-flow-tooltip-share", row);
				share.textContent = formatShare(l.value, total);
			}
			if (sorted.length > 6) div("sankey-flow-tooltip-more", tip).textContent = `+ ${sorted.length - 6} more`;
		};
		section("Incoming", ln.targetLinks, "source", ln.inValue);
		section("Outgoing", ln.sourceLinks, "target", ln.outValue);
		if (node.description) div("sankey-flow-tooltip-desc", tip).textContent = truncate(node.description, 240);
		if (node.link) {
			const hint = div("sankey-flow-tooltip-link", tip);
			const parsed = parseLink(node.link);
			hint.textContent = `${parsed?.kind === "external" ? "↗" : "→"} ${linkDisplayText(node.link)} · ${this.options.linkHint}`;
		}
	}

	private fillFlowTooltip(tip: HTMLElement, id: string): void {
		const flow = this.flowById.get(id);
		const link = this.layoutLinkById.get(id);
		const config = this.config as RenderConfig;
		if (!flow || !link) return;
		const s = this.nodeById.get(link.source.id)?.label ?? "";
		const t = this.nodeById.get(link.target.id)?.label ?? "";
		div("sankey-flow-tooltip-title", tip).textContent = `${s} → ${t}`;
		if (flow.label) div("sankey-flow-tooltip-meta", tip).textContent = flow.label;
		const row = div("sankey-flow-tooltip-row", tip);
		div("sankey-flow-tooltip-name", row).textContent = "Value";
		div("sankey-flow-tooltip-value", row).textContent = formatValue(link.value, config.format);
		const shareRow = div("sankey-flow-tooltip-row", tip);
		div("sankey-flow-tooltip-name", shareRow).textContent = `Share of ${s}`;
		div("sankey-flow-tooltip-value", shareRow).textContent = formatShare(link.value, link.source.outValue);
		if (link.circular) div("sankey-flow-tooltip-desc", tip).textContent = "Part of a cycle; drawn as a loop.";
		if (flow.description) div("sankey-flow-tooltip-desc", tip).textContent = truncate(flow.description, 240);
		if (flow.link) div("sankey-flow-tooltip-link", tip).textContent = `→ ${linkDisplayText(flow.link)} · ${this.options.linkHint}`;
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	private exists(target: NonNullable<Selection>): boolean {
		return target.kind === "node" ? this.nodeById.has(target.id) : this.flowById.has(target.id);
	}

	elementFor(target: HitTarget): Element | null {
		if (target.kind === "node") return this.nodeEls.get(target.id)?.g ?? null;
		if (target.kind === "flow") return this.linkEls.get(target.id)?.path ?? null;
		return null;
	}

}

function sameTarget(a: HitTarget | null, b: HitTarget | null): boolean {
	if (!a || !b) return a === b;
	if (a.kind === "background" || b.kind === "background") return a.kind === b.kind;
	return a.kind === b.kind && a.id === b.id;
}

function r(n: number): string {
	return String(Math.round(n * 10) / 10);
}
