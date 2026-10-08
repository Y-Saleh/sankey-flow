import type { SankeyDocument } from "../model/schema";
import { cloneDocument, touch } from "../model/operations";
import { History } from "../model/history";
import type { Selection } from "../render/SankeyRenderer";

export type ChangeKind = "edit" | "undo" | "redo" | "load" | "external" | "selection";

export interface ChangeEvent {
	kind: ChangeKind;
	label?: string;
	/** Where a selection change came from, so panels do not echo it back. */
	origin?: string;
}

type Listener = (event: ChangeEvent) => void;

/**
 * The in-memory model behind one editor: the current document, its undo
 * history and the selection. Every edit goes through {@link update}, which
 * works on a copy so history snapshots are never mutated.
 */
export class DiagramController {
	private current: SankeyDocument;
	private readonly history = new History<SankeyDocument>();
	private listeners = new Set<Listener>();
	selection: Selection = null;

	constructor(doc: SankeyDocument) {
		this.current = doc;
	}

	get doc(): SankeyDocument {
		return this.current;
	}

	get canUndo(): boolean {
		return this.history.canUndo;
	}

	get canRedo(): boolean {
		return this.history.canRedo;
	}

	get undoLabel(): string | null {
		return this.history.undoLabel;
	}

	get redoLabel(): string | null {
		return this.history.redoLabel;
	}

	on(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: ChangeEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	/** Loads a document as the new baseline (opening a file). Clears history. */
	load(doc: SankeyDocument): void {
		this.current = doc;
		this.history.clear();
		this.emit({ kind: "load" });
	}

	/** Replaces the document as an undoable step (external change, import). */
	replace(doc: SankeyDocument, label: string, kind: "external" | "edit" = "edit"): void {
		this.history.record(this.current, label);
		this.history.seal();
		this.current = doc;
		this.emit({ kind, label });
	}

	/**
	 * Applies `mutate` to a copy of the document. Returns false (and records
	 * nothing) when the mutation did not change anything.
	 */
	update(label: string, mutate: (draft: SankeyDocument) => void, options: { coalesce?: string } = {}): boolean {
		const before = this.current;
		const draft = cloneDocument(before);
		mutate(draft);
		if (JSON.stringify(draft) === JSON.stringify(before)) return false;
		touch(draft);
		this.history.record(before, label, options.coalesce);
		this.current = draft;
		this.emit({ kind: "edit", label });
		return true;
	}

	/** Ends coalescing (e.g. when a field loses focus). */
	seal(): void {
		this.history.seal();
	}

	undo(): boolean {
		const entry = this.history.undo(this.current);
		if (!entry) return false;
		this.current = entry.state;
		this.emit({ kind: "undo", label: entry.label });
		return true;
	}

	redo(): boolean {
		const entry = this.history.redo(this.current);
		if (!entry) return false;
		this.current = entry.state;
		this.emit({ kind: "redo", label: entry.label });
		return true;
	}

	select(selection: Selection, origin?: string): void {
		const prev = this.selection;
		if (prev?.kind === selection?.kind && prev?.id === selection?.id) return;
		this.selection = selection;
		this.emit({ kind: "selection", origin });
	}
}
