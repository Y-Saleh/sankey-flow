import { Keymap, Menu, Notice, TFile, type App, type HoverParent, type PaneType } from "obsidian";
import { linkpathOf, parseLink } from "../model/linkValue";

export const HOVER_SOURCE = "sankey-flow";

/**
 * Opens a node/flow link through Obsidian's own navigation so tabs, panes,
 * history and "open in new tab" preferences behave exactly like normal links.
 */
export async function openLink(app: App, link: string, sourcePath: string, newLeaf: PaneType | boolean = false): Promise<void> {
	const parsed = parseLink(link);
	if (!parsed) {
		new Notice("This link is not supported.");
		return;
	}
	if (parsed.kind === "external") {
		window.open(parsed.url, "_blank", "noopener");
		return;
	}
	await app.workspace.openLinkText(parsed.linktext, sourcePath, newLeaf);
}

/** Pane type implied by a mouse event (Mod-click → new tab, etc.), following Obsidian's convention. */
export function paneTypeFor(evt: MouseEvent | KeyboardEvent): PaneType | boolean {
	return Keymap.isModEvent(evt);
}

export function resolveLinkedFile(app: App, link: string, sourcePath: string): TFile | null {
	const parsed = parseLink(link);
	if (parsed?.kind !== "internal") return null;
	return app.metadataCache.getFirstLinkpathDest(linkpathOf(parsed.linktext), sourcePath);
}

/** Triggers Obsidian's Page Preview popover for an internal link. */
export function triggerHoverPreview(
	app: App,
	evt: MouseEvent,
	targetEl: HTMLElement | SVGElement,
	link: string,
	sourcePath: string,
	hoverParent: HoverParent,
): void {
	const parsed = parseLink(link);
	if (parsed?.kind !== "internal") return;
	app.workspace.trigger("hover-link", {
		event: evt,
		source: HOVER_SOURCE,
		hoverParent,
		targetEl,
		linktext: parsed.linktext,
		sourcePath,
	});
}

interface FileExplorerLike {
	revealInFolder?(file: TFile): void;
}

/** Reveals a file in the File explorer, if that core plugin is enabled. */
function fileExplorer(app: App): FileExplorerLike | null {
	const internal = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
	const explorer = internal?.getEnabledPluginById?.("file-explorer") as FileExplorerLike | undefined;
	return explorer && typeof explorer.revealInFolder === "function" ? explorer : null;
}

/**
 * Adds the standard link actions to a context menu: open, open in new tab,
 * open to the right, reveal in file explorer, copy link.
 */
export function addLinkMenuItems(menu: Menu, app: App, link: string, sourcePath: string): void {
	const parsed = parseLink(link);
	if (!parsed) return;
	if (parsed.kind === "external") {
		menu.addItem((item) =>
			item
				.setSection("open")
				.setTitle("Open link")
				.setIcon("external-link")
				.onClick(() => void openLink(app, link, sourcePath)),
		);
		menu.addItem((item) =>
			item
				.setSection("open")
				.setTitle("Copy URL")
				.setIcon("copy")
				.onClick(() => void copyText(parsed.url)),
		);
		return;
	}
	const file = resolveLinkedFile(app, link, sourcePath);
	menu.addItem((item) =>
		item
			.setSection("open")
			.setTitle(file ? "Open linked note" : "Create linked note")
			.setIcon(file ? "file-text" : "file-plus")
			.onClick(() => void openLink(app, link, sourcePath, false)),
	);
	menu.addItem((item) =>
		item
			.setSection("open")
			.setTitle("Open in new tab")
			.setIcon("file-plus-2")
			.onClick(() => void openLink(app, link, sourcePath, "tab")),
	);
	menu.addItem((item) =>
		item
			.setSection("open")
			.setTitle("Open to the right")
			.setIcon("separator-vertical")
			.onClick(() => void openLink(app, link, sourcePath, "split")),
	);
	const explorer = fileExplorer(app);
	if (file && explorer) {
		menu.addItem((item) =>
			item
				.setSection("open")
				.setTitle("Reveal in file explorer")
				.setIcon("folder-open")
				.onClick(() => explorer.revealInFolder?.(file)),
		);
	}
	menu.addItem((item) =>
		item
			.setSection("open")
			.setTitle("Copy Obsidian link")
			.setIcon("link")
			.onClick(() => void copyText(`[[${parsed.linktext}]]`)),
	);
}

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice("Copied to clipboard.");
	} catch {
		new Notice("Could not access the clipboard.");
	}
}

/** Builds a wikilink to `file` from `sourcePath`, honouring the shortest-path setting. */
export function wikilinkTo(app: App, file: TFile, sourcePath: string, subpath = ""): string {
	return `[[${app.metadataCache.fileToLinktext(file, sourcePath, true)}${subpath}]]`;
}
