import type { SankeyDocument } from "../model/schema";
import type { ValidationIssue } from "../model/validate";

/**
 * A pluggable producer of diagram data. Embeds and importers depend only on
 * this interface, so new sources (YAML, frontmatter, Bases, APIs, …) can be
 * added without touching rendering or storage.
 */
export interface SankeyDataSource {
	/** Short user-facing description, e.g. "Dataview query". */
	readonly label: string;
	load(): Promise<SankeyLoadResult>;
	/** Subscribes to changes that require a reload. Returns an unsubscribe function. */
	watch?(onChange: () => void): () => void;
}

export interface SankeyLoadResult {
	doc: SankeyDocument;
	issues: ValidationIssue[];
}

/** A source that already has its data (inline flows, JSON in the block). */
export class StaticSource implements SankeyDataSource {
	constructor(
		readonly label: string,
		private readonly result: SankeyLoadResult,
	) {}

	async load(): Promise<SankeyLoadResult> {
		return this.result;
	}
}
