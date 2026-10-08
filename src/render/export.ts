import type { SankeyRenderer } from "./SankeyRenderer";
import type { SankeyDocument } from "../model/schema";
import { toCsv } from "../data/csv";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Presentation properties copied from computed styles into the exported SVG. */
const STYLE_PROPS = [
	"fill",
	"fill-opacity",
	"stroke",
	"stroke-opacity",
	"stroke-width",
	"stroke-linejoin",
	"opacity",
	"paint-order",
	"font-family",
	"font-size",
	"font-weight",
	"stop-color",
] as const;

const colorCache = new Map<string, string>();

/**
 * Resolves any CSS colour (including color-mix(), oklab(), color(srgb …)) to
 * a plain hex/rgba value that every SVG consumer understands, by letting the
 * browser paint it into a 1×1 canvas.
 */
function toPortableColor(value: string): string {
	if (!value || value === "none" || value.startsWith("url(")) return value;
	const cached = colorCache.get(value);
	if (cached) return cached;
	const canvas = createEl("canvas");
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return value;
	ctx.clearRect(0, 0, 1, 1);
	ctx.fillStyle = "#000";
	ctx.fillStyle = value;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
	const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
	const out = a === 255 ? hex : `rgba(${r},${g},${b},${Math.round((a / 255) * 1000) / 1000})`;
	colorCache.set(value, out);
	return out;
}

export interface SvgExportOptions {
	title: string;
	/** Concrete background colour, or null for transparent. */
	background: string | null;
	/** href for a node label, or null. */
	nodeHref?: (nodeId: string) => string | null;
}

export interface SvgExport {
	svg: string;
	width: number;
	height: number;
}

/**
 * Serialises what the renderer currently shows as a standalone SVG.
 * Hover/selection state is excluded; the diagram on screen is not modified.
 */
export function exportSvg(renderer: SankeyRenderer, options: SvgExportOptions): SvgExport {
	const root = renderer.el;
	const transient = ["has-hover", "has-selection"];
	const restoreRoot = transient.filter((c) => root.classList.contains(c));
	root.classList.remove(...transient);
	const marked = Array.from(root.querySelectorAll(".is-related, .is-selected"));
	const markedClasses = marked.map((el) => [el.classList.contains("is-related"), el.classList.contains("is-selected")] as const);
	marked.forEach((el) => el.classList.remove("is-related", "is-selected"));

	try {
		const source = renderer.svgEl;
		const clone = source.cloneNode(true) as SVGSVGElement;
		const originals = [source, ...Array.from(source.querySelectorAll("*"))];
		const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];

		originals.forEach((orig, i) => {
			const copy = copies[i] as SVGElement;
			const computed = getComputedStyle(orig);
			const inDefs = !!orig.closest("defs");
			const hidden = !inDefs && computed.display === "none";
			if (hidden || copy.classList.contains("sankey-flow-handle") || copy.classList.contains("sankey-flow-connect-preview")) {
				copy.setAttribute("data-remove", "1");
				return;
			}
			if (copy !== clone) {
				for (const prop of STYLE_PROPS) {
					const value = computed.getPropertyValue(prop);
					if (!value) continue;
					const portable = prop === "fill" || prop === "stroke" || prop === "stop-color" ? toPortableColor(value) : value;
					copy.setAttribute(prop, portable);
				}
			}
			copy.removeAttribute("style");
			copy.removeAttribute("class");
			for (const attr of Array.from(copy.attributes)) {
				if (attr.name.startsWith("data-") && attr.name !== "data-remove") copy.removeAttribute(attr.name);
			}
			if (copy.tagName === "text" && options.nodeHref) {
				const id = (orig as SVGElement).dataset.id;
				const href = id ? options.nodeHref(id) : null;
				if (href) {
					const a = document.createElementNS(SVG_NS, "a");
					a.setAttribute("href", href);
					a.setAttributeNS(XLINK_NS, "xlink:href", href);
					copy.replaceWith(a);
					a.appendChild(copy);
				}
			}
		});
		clone.querySelectorAll("[data-remove]").forEach((el) => el.remove());

		const b = renderer.contentBounds();
		const width = Math.ceil(b.x1 - b.x0);
		const height = Math.ceil(b.y1 - b.y0);
		const viewport = clone.querySelector("g");
		viewport?.setAttribute("transform", `translate(${-b.x0},${-b.y0})`);
		clone.setAttribute("xmlns", SVG_NS);
		clone.setAttribute("xmlns:xlink", XLINK_NS);
		clone.setAttribute("width", String(width));
		clone.setAttribute("height", String(height));
		clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
		clone.removeAttribute("aria-hidden");
		clone.removeAttribute("focusable");
		clone.setAttribute("role", "img");

		const title = document.createElementNS(SVG_NS, "title");
		title.textContent = options.title;
		clone.insertBefore(title, clone.firstChild);
		if (options.background) {
			const bg = document.createElementNS(SVG_NS, "rect");
			bg.setAttribute("width", "100%");
			bg.setAttribute("height", "100%");
			bg.setAttribute("fill", toPortableColor(options.background));
			clone.insertBefore(bg, title.nextSibling);
		}
		const xml = new XMLSerializer().serializeToString(clone);
		return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`, width, height };
	} finally {
		root.classList.add(...restoreRoot);
		marked.forEach((el, i) => {
			if (markedClasses[i][0]) el.classList.add("is-related");
			if (markedClasses[i][1]) el.classList.add("is-selected");
		});
	}
}

/** Rasterises an exported SVG. */
export async function svgToPng(exported: SvgExport, scale: number): Promise<ArrayBuffer> {
	const blob = new Blob([exported.svg], { type: "image/svg+xml;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.decoding = "async";
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("The SVG could not be rasterised."));
			img.src = url;
		});
		const canvas = createEl("canvas");
		const s = Math.min(8, Math.max(1, scale));
		canvas.width = Math.max(1, Math.round(exported.width * s));
		canvas.height = Math.max(1, Math.round(exported.height * s));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas is not available.");
		ctx.scale(s, s);
		ctx.drawImage(img, 0, 0, exported.width, exported.height);
		const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!png) throw new Error("PNG encoding failed.");
		return await png.arrayBuffer();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Flow table as CSV: Source, Target, Value, Label (labels, not ids). */
export function documentToCsv(doc: SankeyDocument, delimiter = ","): string {
	const label = new Map(doc.nodes.map((n) => [n.id, n.label]));
	const rows: (string | number)[][] = [["Source", "Target", "Value", "Label"]];
	for (const f of doc.flows) rows.push([label.get(f.source) ?? f.source, label.get(f.target) ?? f.target, f.value, f.label ?? ""]);
	return toCsv(rows, delimiter);
}
