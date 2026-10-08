import { Notice, normalizePath } from "obsidian";
import type SankeyFlowPlugin from "../main";
import type { SankeyDocument } from "../model/schema";
import { parseLink } from "../model/linkValue";
import type { SankeyRenderer } from "../render/SankeyRenderer";
import { documentToCsv, exportSvg, svgToPng } from "../render/export";
import { stringifyDocument } from "../storage/diagramFile";
import { sanitizeFileName } from "../storage/DiagramStore";
import { resolveLinkedFile } from "../obsidian/links";

export type ExportFormat = "svg" | "png" | "csv" | "json";

export interface ExportContext {
	renderer: SankeyRenderer;
	doc: SankeyDocument;
	name: string;
	/** Note the diagram lives in or is embedded in; used to resolve links and the default folder. */
	sourcePath: string;
}

/**
 * Writes exports as new files in the vault (never overwriting anything).
 * The diagram itself is not modified.
 */
export class Exporter {
	constructor(private readonly plugin: SankeyFlowPlugin) {}

	async export(format: ExportFormat, ctx: ExportContext): Promise<void> {
		try {
			const path = await this.write(format, ctx);
			new Notice(`Exported to ${path}`);
		} catch (e) {
			this.plugin.reportError(`Could not export as ${format.toUpperCase()}`, e);
		}
	}

	private async write(format: ExportFormat, ctx: ExportContext): Promise<string> {
		const { vault } = this.plugin.app;
		const folder = await this.folderFor(ctx.sourcePath);
		const base = sanitizeFileName(ctx.name);
		switch (format) {
			case "svg": {
				const svg = this.svg(ctx);
				const path = this.plugin.store.availablePath(folder, base, "svg");
				await vault.create(path, svg.svg);
				return path;
			}
			case "png": {
				const svg = this.svg(ctx);
				const png = await svgToPng(svg, this.plugin.settings.pngScale);
				const path = this.plugin.store.availablePath(folder, base, "png");
				await vault.createBinary(path, png);
				return path;
			}
			case "csv": {
				const delimiter = this.plugin.settings.csvDelimiter === "auto" ? "," : this.plugin.settings.csvDelimiter;
				const path = this.plugin.store.availablePath(folder, base, "csv");
				await vault.create(path, documentToCsv(ctx.doc, delimiter));
				return path;
			}
			case "json": {
				const path = this.plugin.store.availablePath(folder, `${base}.sankey`, "json");
				await vault.create(path, stringifyDocument(ctx.doc) + "\n");
				return path;
			}
		}
	}

	/** Standalone SVG markup for the diagram as currently shown. */
	svg(ctx: ExportContext) {
		const { app, settings } = this.plugin;
		const background =
			settings.exportBackground === "theme" ? getComputedStyle(document.body).getPropertyValue("--background-primary").trim() || null : null;
		const vaultName = app.vault.getName();
		const nodes = new Map(ctx.doc.nodes.map((n) => [n.id, n]));
		return exportSvg(ctx.renderer, {
			title: ctx.name,
			background,
			nodeHref: (id) => {
				const link = nodes.get(id)?.link;
				const parsed = parseLink(link ?? null);
				if (!parsed || !link) return null;
				if (parsed.kind === "external") return parsed.url;
				const file = resolveLinkedFile(app, link, ctx.sourcePath);
				return file ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.path)}` : null;
			},
		});
	}

	private async folderFor(sourcePath: string): Promise<string> {
		const configured = this.plugin.settings.exportFolder.trim();
		if (configured) {
			const folder = normalizePath(configured);
			await this.plugin.store.ensureFolder(folder);
			return folder;
		}
		const slash = sourcePath.lastIndexOf("/");
		return slash > 0 ? sourcePath.slice(0, slash) : "/";
	}
}
