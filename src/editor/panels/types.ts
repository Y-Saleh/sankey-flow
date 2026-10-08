import type SankeyFlowPlugin from "../../main";
import type { DiagramController, ChangeEvent } from "../DiagramController";
import type { HitTarget, Selection } from "../../render/SankeyRenderer";

/** What the editor view offers its sidebar panels. */
export interface PanelHost {
	readonly plugin: SankeyFlowPlugin;
	readonly controller: DiagramController;
	sourcePath(): string;
	/** Highlights an element in the diagram while hovering a row. */
	hover(target: HitTarget | null): void;
	/** Selects in model + diagram; optionally switches to the inspector. */
	select(selection: Selection, options?: { inspect?: boolean; origin?: string }): void;
	/** The colour the diagram currently uses for a node. */
	nodeColor(nodeId: string): string;
	openNodeMenu(nodeId: string, evt: MouseEvent): void;
	openFlowMenu(flowId: string, evt: MouseEvent): void;
	importData(): void;
	exportCsv(): void;
	addNode(): void;
}

export interface Panel {
	readonly el: HTMLElement;
	refresh(event: ChangeEvent): void;
	onShow?(): void;
	destroy?(): void;
}

/** True when keyboard focus is inside `el` (so a refresh must not clobber what is being typed). */
export function hasFocusWithin(el: HTMLElement): boolean {
	const active = el.ownerDocument.activeElement;
	return !!active && el.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
}
