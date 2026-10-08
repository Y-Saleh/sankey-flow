import type { App } from "obsidian";
import { buildRows, documentFromRows, guessMapping, type ColumnMapping, type RawTable } from "./tableImport";
import type { DataviewColumns } from "./blockSyntax";
import type { SankeyDataSource, SankeyLoadResult } from "./sources";
import type { DecimalFormat } from "./numbers";

/**
 * Optional Dataview integration. Dataview is never required: everything here
 * is feature-detected through the API object Dataview publishes, and the
 * rest of the plugin works identically without it.
 */

interface DataviewQueryResult {
	successful: boolean;
	error?: string;
	value?: { type: string; headers?: string[]; values?: unknown[][] };
}

interface DataviewApi {
	query(source: string, originFile?: string): Promise<DataviewQueryResult>;
}

export function getDataviewApi(app: App): DataviewApi | null {
	const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, { api?: unknown }> } }).plugins;
	if (plugins?.enabledPlugins && !plugins.enabledPlugins.has("dataview")) return null;
	const api = plugins?.plugins?.dataview?.api as Partial<DataviewApi> | undefined;
	return api && typeof api.query === "function" ? (api as DataviewApi) : null;
}

/** Turns a Dataview value (links, dates, lists, numbers…) into cell text. */
function cellText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(cellText).join(", ");
	if (typeof value === "object") {
		const v = value as { path?: unknown; display?: unknown; subpath?: unknown; markdown?: () => string; toString?: () => string };
		if (typeof v.path === "string") {
			const sub = typeof v.subpath === "string" && v.subpath ? `#${v.subpath}` : "";
			const display = typeof v.display === "string" && v.display ? `|${v.display}` : "";
			return `[[${v.path.replace(/\.md$/i, "")}${sub}${display}]]`;
		}
		if (typeof v.toString === "function" && v.toString !== Object.prototype.toString) return v.toString();
	}
	return "";
}

export class DataviewSource implements SankeyDataSource {
	readonly label = "Dataview query";

	constructor(
		private readonly app: App,
		private readonly query: string,
		private readonly columns: DataviewColumns,
		private readonly sourcePath: string,
		private readonly decimal: DecimalFormat,
		private readonly subscribe: (cb: () => void) => () => void,
	) {}

	async load(): Promise<SankeyLoadResult> {
		const api = getDataviewApi(this.app);
		if (!api) throw new Error("This diagram uses a Dataview query, but the Dataview plugin is not installed or enabled.");
		const result = await api.query(this.query, this.sourcePath);
		if (!result.successful) throw new Error(`Dataview query failed: ${result.error ?? "unknown error"}`);
		if (result.value?.type !== "table") throw new Error("Use a TABLE query that returns source, target and value columns.");
		const table: RawTable = {
			headers: (result.value.headers ?? []).map(String),
			rows: (result.value.values ?? []).map((row) => row.map(cellText)),
		};
		const mapping = this.mapping(table);
		const built = buildRows(table, mapping, { decimal: this.decimal });
		const doc = documentFromRows("", built.rows, true);
		return {
			doc,
			issues: built.problems.map((p) => ({ level: "warning" as const, message: p.message })),
		};
	}

	watch(onChange: () => void): () => void {
		return this.subscribe(onChange);
	}

	private mapping(table: RawTable): ColumnMapping {
		const guessed = guessMapping(table);
		const find = (name: string | undefined, fallback: number) => {
			if (!name) return fallback;
			const idx = table.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
			if (idx < 0) throw new Error(`The query has no column called "${name}". Columns: ${table.headers.join(", ")}.`);
			return idx;
		};
		return {
			source: find(this.columns.source, guessed.source),
			target: find(this.columns.target, guessed.target),
			value: find(this.columns.value, guessed.value),
			label: find(this.columns.label, -1),
		};
	}
}
