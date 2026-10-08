import { normalizePath, TFile, TFolder, type App, type CachedMetadata } from "obsidian";
import type { SankeyDocument } from "../model/schema";
import type { NormalizeResult } from "../model/validate";
import { linkpathOf, parseLink, subpathOf } from "../model/linkValue";
import { isDiagramFrontmatter, readDiagramFile, replaceInSankeyBlocks, sankeyBlockBodies, writeDiagramFile } from "./diagramFile";
import { parseBlock } from "../data/blockSyntax";
import type { Logger } from "../util/logger";

/** Characters Obsidian (and common file systems) reject in file names. */
const INVALID_NAME = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeFileName(name: string): string {
	return name.replace(INVALID_NAME, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled diagram";
}

/**
 * All vault access for diagram files. Diagrams are discovered through the
 * metadata cache (frontmatter marker), so listing never reads file contents.
 */
export class DiagramStore {
	/** sourcePath → diagram paths referenced from `sankey` code blocks. */
	private blockRefs = new Map<string, Set<string>>();
	private blockRefsReady: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly folder: () => string,
		private readonly logger: Logger,
	) {}

	isDiagramFile(file: TFile | null | undefined): boolean {
		if (!file || file.extension !== "md") return false;
		return isDiagramFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
	}

	listDiagrams(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => this.isDiagramFile(f));
	}

	async read(file: TFile): Promise<NormalizeResult> {
		return readDiagramFile(await this.app.vault.cachedRead(file));
	}

	/** Writes a document into an existing diagram note, preserving everything else in it. */
	async write(file: TFile, doc: SankeyDocument): Promise<void> {
		await this.app.vault.process(file, (text) => writeDiagramFile(doc, text));
	}

	/** Creates a new diagram note. Never overwrites: a free name is chosen if needed. */
	async create(name: string, doc: SankeyDocument, folderPath?: string): Promise<TFile> {
		const folder = normalizePath((folderPath ?? this.folder()).trim() || "/");
		if (folder !== "/") await this.ensureFolder(folder);
		const path = this.availablePath(folder, sanitizeFileName(name), "md");
		const file = await this.app.vault.create(path, writeDiagramFile(doc));
		this.logger.debug("Created diagram", path);
		return file;
	}

	async duplicate(file: TFile): Promise<TFile> {
		const folder = file.parent?.path ?? "/";
		const path = this.availablePath(folder, `${file.basename} copy`, file.extension);
		return this.app.vault.copy(file, path);
	}

	availablePath(folder: string, base: string, extension: string): string {
		const prefix = folder === "/" || folder === "" ? "" : `${folder}/`;
		let candidate = normalizePath(`${prefix}${base}.${extension}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(candidate); i++) {
			candidate = normalizePath(`${prefix}${base} ${i}.${extension}`);
		}
		return candidate;
	}

	async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		if (existing) throw new Error(`"${path}" exists and is not a folder.`);
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);
		await this.app.vault.createFolder(path);
	}

	/** Resolves `[[Sankey/Energy]]`, `Sankey/Energy` or a path to a diagram file. */
	resolve(reference: string, sourcePath: string): TFile | null {
		const parsed = parseLink(reference);
		const target = parsed?.kind === "internal" ? linkpathOf(parsed.linktext) : reference.trim();
		if (!target) return null;
		return (
			this.app.metadataCache.getFirstLinkpathDest(target, sourcePath) ??
			(this.app.vault.getAbstractFileByPath(normalizePath(target)) as TFile | null) ??
			null
		);
	}

	// ── References ───────────────────────────────────────────────────────

	/** Notes linking to or embedding the diagram, including `sankey` code block references. */
	async findReferences(file: TFile): Promise<TFile[]> {
		const paths = new Set<string>();
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (source !== file.path && targets[file.path]) paths.add(source);
		}
		await this.ensureBlockRefs();
		for (const [source, targets] of this.blockRefs) {
			if (targets.has(file.path)) paths.add(source);
		}
		return [...paths]
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Builds the code-block reference index on first use, reading only notes that contain code blocks. */
	private ensureBlockRefs(): Promise<void> {
		if (!this.blockRefsReady) {
			this.blockRefsReady = (async () => {
				const started = performance.now();
				for (const file of this.app.vault.getMarkdownFiles()) {
					const cache = this.app.metadataCache.getFileCache(file);
					if (!cache?.sections?.some((s) => s.type === "code")) continue;
					this.indexFile(file, await this.app.vault.cachedRead(file), cache);
				}
				this.logger.debug(`Indexed sankey code block references in ${Math.round(performance.now() - started)} ms`);
			})();
		}
		return this.blockRefsReady;
	}

	/** Keeps the reference index current; fed by the metadata cache's "changed" event. */
	indexFile(file: TFile, data: string, _cache?: CachedMetadata | null): void {
		if (!this.blockRefsReady) return; // Not built yet; the first scan will read this file.
		const targets = new Set<string>();
		for (const body of sankeyBlockBodies(data)) {
			const spec = parseBlock(body);
			if (spec.kind !== "reference") continue;
			const target = this.resolve(spec.target, file.path);
			if (target) targets.add(target.path);
		}
		if (targets.size) this.blockRefs.set(file.path, targets);
		else this.blockRefs.delete(file.path);
	}

	forgetFile(path: string): void {
		this.blockRefs.delete(path);
	}

	onFileRenamed(file: TFile, oldPath: string): void {
		const refs = this.blockRefs.get(oldPath);
		if (refs) {
			this.blockRefs.delete(oldPath);
			this.blockRefs.set(file.path, refs);
		}
		for (const targets of this.blockRefs.values()) {
			if (targets.delete(oldPath)) targets.add(file.path);
		}
	}

	// ── Rename support ───────────────────────────────────────────────────

	/**
	 * After `file` moved from `oldPath`, returns updated links for any node or
	 * flow link in `doc` that pointed at the old location, or null when no
	 * link was affected. Links that still resolve are never touched.
	 */
	relinkAfterRename(doc: SankeyDocument, diagramPath: string, file: TFile, oldPath: string): SankeyDocument | null {
		const oldNoExt = oldPath.replace(/\.md$/i, "");
		const oldBase = oldNoExt.split("/").pop() ?? oldNoExt;
		let changed = false;
		const fix = (link: string | null | undefined): string | null | undefined => {
			const parsed = parseLink(link ?? null);
			if (parsed?.kind !== "internal") return link;
			const path = linkpathOf(parsed.linktext);
			const matchesOld = path === oldPath || path === oldNoExt || path === oldBase || path === oldPath.split("/").pop();
			if (!matchesOld) return link;
			if (this.app.metadataCache.getFirstLinkpathDest(path, diagramPath)) return link;
			changed = true;
			const linktext = this.app.metadataCache.fileToLinktext(file, diagramPath, true) + subpathOf(parsed.linktext);
			return parsed.alias ? `[[${linktext}|${parsed.alias}]]` : `[[${linktext}]]`;
		};
		const next = structuredClone(doc);
		for (const item of [...next.nodes, ...next.flows]) {
			if (item.link) item.link = fix(item.link) ?? null;
		}
		return changed ? next : null;
	}

	/**
	 * Rewrites `diagram: [[old]]` references inside `sankey` code blocks after a
	 * diagram file is renamed. Only the reference line is changed.
	 */
	async updateBlockReferences(file: TFile, oldPath: string): Promise<number> {
		const oldNoExt = oldPath.replace(/\.md$/i, "");
		const oldBase = oldNoExt.split("/").pop() ?? oldNoExt;
		let updated = 0;
		// Scan notes that contain code blocks; the reference index cannot be trusted here
		// because the old name no longer resolves after the rename.
		for (const note of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(note);
			if (!cache?.sections?.some((s) => s.type === "code")) continue;
			const source = note.path;
			const fix = (block: string) =>
				block.replace(/^(\s*(?:diagram|file)\s*:\s*)(.+)$/gim, (line, prefix: string, ref: string) => {
					const parsed = parseLink(ref);
					const path = parsed?.kind === "internal" ? linkpathOf(parsed.linktext) : ref.trim();
					if (path !== oldNoExt && path !== oldBase && path !== oldPath) return line;
					// Leave references that still resolve (e.g. to another note with the old name).
					if (this.app.metadataCache.getFirstLinkpathDest(path, source)) return line;
					return `${prefix}[[${this.app.metadataCache.fileToLinktext(file, source, true)}]]`;
				});
			const text = await this.app.vault.cachedRead(note);
			if (replaceInSankeyBlocks(text, fix) === text) continue;
			await this.app.vault.process(note, (current) => replaceInSankeyBlocks(current, fix));
			this.indexFile(note, await this.app.vault.cachedRead(note));
			updated++;
		}
		return updated;
	}
}
