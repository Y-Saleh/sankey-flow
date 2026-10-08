/**
 * Snapshot-based undo/redo. Snapshots are whole documents, which keeps every
 * operation (including layout changes and bulk imports) trivially undoable
 * and avoids a fragile inverse-operation system.
 *
 * Rapid edits that share a `coalesceKey` within `coalesceMs` (typing in a
 * value field, nudging a slider) collapse into a single undo step.
 */
export interface HistoryEntry<T> {
	state: T;
	label: string;
}

export class History<T> {
	private undoStack: HistoryEntry<T>[] = [];
	private redoStack: HistoryEntry<T>[] = [];
	private lastKey: string | null = null;
	private lastTime = 0;

	constructor(
		private readonly limit = 200,
		private readonly coalesceMs = 1200,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Records `previous` as the state to return to on undo. Call this *before*
	 * replacing the current state with a new one.
	 */
	record(previous: T, label: string, coalesceKey?: string): void {
		const time = this.now();
		const coalesce =
			coalesceKey !== undefined &&
			coalesceKey === this.lastKey &&
			time - this.lastTime < this.coalesceMs &&
			this.undoStack.length > 0;
		if (!coalesce) {
			this.undoStack.push({ state: previous, label });
			if (this.undoStack.length > this.limit) this.undoStack.shift();
		}
		this.lastKey = coalesceKey ?? null;
		this.lastTime = time;
		this.redoStack = [];
	}

	/** Breaks coalescing so the next record starts a new step. */
	seal(): void {
		this.lastKey = null;
	}

	undo(current: T): HistoryEntry<T> | null {
		const entry = this.undoStack.pop();
		if (!entry) return null;
		this.redoStack.push({ state: current, label: entry.label });
		this.seal();
		return entry;
	}

	redo(current: T): HistoryEntry<T> | null {
		const entry = this.redoStack.pop();
		if (!entry) return null;
		this.undoStack.push({ state: current, label: entry.label });
		this.seal();
		return entry;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	get undoLabel(): string | null {
		return this.undoStack[this.undoStack.length - 1]?.label ?? null;
	}

	get redoLabel(): string | null {
		return this.redoStack[this.redoStack.length - 1]?.label ?? null;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.seal();
	}
}
