import { MarkdownView, Notice, type Editor } from "obsidian";
import type SankeyFlowPlugin from "./main";
import { SankeyEditorView } from "./editor/SankeyEditorView";
import { findTableAt, parseMarkdownTable } from "./data/markdownTable";
import { parseBlock } from "./data/blockSyntax";
import { CsvSourceModal, FilePickerModal } from "./modals/basic";
import type { ExportFormat } from "./export/exporter";

/**
 * Every command is registered through Obsidian's command API with no default
 * hotkey, so users assign their own shortcuts and nothing collides with
 * existing bindings or other plugins.
 */
export function registerCommands(plugin: SankeyFlowPlugin): void {
	const { app } = plugin;
	const activeEditor = (): SankeyEditorView | null => app.workspace.getActiveViewOfType(SankeyEditorView);
	const withEditor = (fn: (view: SankeyEditorView) => void) => (checking: boolean) => {
		const view = activeEditor();
		if (!view || view.hasLoadError) return false;
		if (!checking) fn(view);
		return true;
	};

	plugin.addCommand({
		id: "create-diagram",
		name: "Create new diagram",
		callback: () => void plugin.createDiagramInteractive(),
	});

	plugin.addCommand({
		id: "open-diagram",
		name: "Open diagram…",
		callback: () => {
			const files = plugin.store.listDiagrams().sort((a, b) => b.stat.mtime - a.stat.mtime);
			new FilePickerModal(app, files, "Open a Sankey diagram…", (file, evt) => void plugin.openDiagram(file, evt instanceof KeyboardEvent && evt.ctrlKey ? "tab" : false), "No Sankey diagrams in this vault yet.").open();
		},
	});

	plugin.addCommand({
		id: "open-manager",
		name: "Open diagram manager",
		callback: () => void plugin.activateManager(),
	});

	plugin.addCommand({
		id: "create-from-table",
		name: "Create diagram from current table",
		editorCheckCallback: (checking, editor) => {
			if (checking) return true;
			plugin.createFromTable(editor);
			return true;
		},
	});

	plugin.addCommand({
		id: "create-from-csv",
		name: "Create diagram from CSV",
		callback: () => new CsvSourceModal(app, (text, name) => plugin.createFromCsv(text, name)).open(),
	});

	plugin.addCommand({
		id: "insert-diagram",
		name: "Insert diagram into current note",
		editorCallback: (editor, ctx) => {
			const sourcePath = ctx.file?.path ?? "";
			const files = plugin.store.listDiagrams().sort((a, b) => b.stat.mtime - a.stat.mtime);
			new FilePickerModal(app, files, "Choose a diagram to insert…", (file) => {
				editor.replaceSelection(plugin.embedCode(file, sourcePath) + "\n");
			}, "No Sankey diagrams in this vault yet. Run “Create new diagram” first.").open();
		},
	});

	plugin.addCommand({
		id: "edit-current",
		name: "Edit current diagram",
		checkCallback: (checking) => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			const file = view?.file;
			if (!view || !file) return false;
			let target = plugin.store.isDiagramFile(file) ? file : null;
			if (!target && view.getMode() === "source") target = referencedDiagramAtCursor(plugin, view.editor, file.path);
			if (!target) return false;
			if (!checking) void plugin.openDiagram(target, target === file ? false : "tab");
			return true;
		},
	});

	plugin.addCommand({
		id: "open-diagram-data",
		name: "Open diagram data as Markdown",
		checkCallback: withEditor((view) => void plugin.openAsMarkdown(view.leaf)),
	});

	plugin.addCommand({
		id: "refresh",
		name: "Refresh diagrams",
		callback: () => {
			plugin.events.trigger("refresh");
			new Notice("Sankey diagrams refreshed.");
		},
	});

	const exports: [ExportFormat, string][] = [
		["svg", "Export current diagram as SVG"],
		["png", "Export current diagram as PNG"],
		["csv", "Export current diagram flows as CSV"],
		["json", "Export current diagram data as JSON"],
	];
	for (const [format, name] of exports) {
		plugin.addCommand({ id: `export-${format}`, name, checkCallback: withEditor((view) => void view.export(format)) });
	}

	plugin.addCommand({ id: "import-csv", name: "Import CSV into current diagram", checkCallback: withEditor((view) => view.importData()) });
	plugin.addCommand({ id: "add-node", name: "Add node", checkCallback: withEditor((view) => view.addNode()) });
	plugin.addCommand({ id: "undo", name: "Undo diagram change", checkCallback: withEditor((view) => view.undo()) });
	plugin.addCommand({ id: "redo", name: "Redo diagram change", checkCallback: withEditor((view) => view.redo()) });
	plugin.addCommand({ id: "focus-editor", name: "Focus diagram", checkCallback: withEditor((view) => view.focusDiagram()) });
	plugin.addCommand({ id: "fit-view", name: "Fit diagram to view", checkCallback: withEditor((view) => view.fitView()) });
	plugin.addCommand({ id: "zoom-in", name: "Zoom in", checkCallback: withEditor((view) => view.zoom(1.25)) });
	plugin.addCommand({ id: "zoom-out", name: "Zoom out", checkCallback: withEditor((view) => view.zoom(0.8)) });
	plugin.addCommand({ id: "reset-layout", name: "Reset layout", checkCallback: withEditor((view) => view.resetLayout()) });
	plugin.addCommand({ id: "save", name: "Save diagram now", checkCallback: withEditor((view) => void view.saveNow()) });
}

/** The diagram referenced by a `sankey` code block that contains the cursor, if any. */
function referencedDiagramAtCursor(plugin: SankeyFlowPlugin, editor: Editor, sourcePath: string) {
	const cursor = editor.getCursor().line;
	let start = -1;
	for (let i = cursor; i >= 0; i--) {
		const line = editor.getLine(i);
		if (/^\s*(`{3,}|~{3,})\s*sankey(?:-flow)?\s*$/.test(line)) {
			start = i;
			break;
		}
		if (i !== cursor && /^\s*(`{3,}|~{3,})/.test(line)) return null;
	}
	if (start < 0) return null;
	const lines: string[] = [];
	for (let i = start + 1; i < editor.lineCount(); i++) {
		const line = editor.getLine(i);
		if (/^\s*(`{3,}|~{3,})\s*$/.test(line)) break;
		lines.push(line);
	}
	const spec = parseBlock(lines.join("\n"));
	return spec.kind === "reference" ? plugin.store.resolve(spec.target, sourcePath) : null;
}

export function tableAtCursor(editor: Editor) {
	const lines = editor.getValue().split("\n");
	const loc = findTableAt(lines, editor.getCursor().line);
	if (!loc) return null;
	return { loc, table: parseMarkdownTable(lines.slice(loc.start, loc.end + 1)) };
}
