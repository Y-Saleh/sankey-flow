import { AbstractInputSuggest, prepareFuzzySearch, type App, type TFile } from "obsidian";

interface LinkSuggestion {
	/** Text inserted inside [[ ]]. */
	linktext: string;
	title: string;
	detail: string;
}

/**
 * Suggests notes, canvases and attachments as you type in a link field, and
 * headings (`Note#`) or blocks (`Note#^`) once a note is chosen — the same
 * targets Obsidian's own link autocomplete offers.
 */
export class LinkSuggest extends AbstractInputSuggest<LinkSuggestion> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private readonly sourcePath: () => string,
		private readonly onPick: (link: string) => void,
	) {
		super(app, input);
		this.limit = 50;
	}

	protected getSuggestions(raw: string): LinkSuggestion[] {
		const query = raw.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0];
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) return [];

		const hash = query.indexOf("#");
		if (hash >= 0) return this.subpathSuggestions(query.slice(0, hash), query.slice(hash + 1));

		const files = this.app.vault.getFiles();
		if (!query.trim()) {
			return [...files]
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, this.limit)
				.map((f) => this.fileSuggestion(f));
		}
		const match = prepareFuzzySearch(query);
		return files
			.map((f) => ({ f, m: match(f.path) }))
			.filter((x) => x.m)
			.sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))
			.slice(0, this.limit)
			.map((x) => this.fileSuggestion(x.f));
	}

	private fileSuggestion(file: TFile): LinkSuggestion {
		const linktext = this.app.metadataCache.fileToLinktext(file, this.sourcePath(), true);
		return { linktext, title: file.extension === "md" ? file.basename : file.name, detail: file.parent?.path === "/" ? "" : file.parent?.path ?? "" };
	}

	private subpathSuggestions(note: string, sub: string): LinkSuggestion[] {
		const file = this.app.metadataCache.getFirstLinkpathDest(note, this.sourcePath());
		if (!file) return [];
		const cache = this.app.metadataCache.getFileCache(file);
		const base = this.app.metadataCache.fileToLinktext(file, this.sourcePath(), true);
		const out: LinkSuggestion[] = [];
		if (sub.startsWith("^")) {
			const q = sub.slice(1).toLowerCase();
			for (const id of Object.keys(cache?.blocks ?? {})) {
				if (id.toLowerCase().includes(q)) out.push({ linktext: `${base}#^${id}`, title: `^${id}`, detail: file.basename });
			}
			return out.slice(0, this.limit);
		}
		const q = sub.toLowerCase();
		for (const h of cache?.headings ?? []) {
			if (h.heading.toLowerCase().includes(q)) {
				out.push({ linktext: `${base}#${h.heading}`, title: `${"#".repeat(h.level)} ${h.heading}`, detail: file.basename });
			}
		}
		return out.slice(0, this.limit);
	}

	renderSuggestion(value: LinkSuggestion, el: HTMLElement): void {
		el.createDiv({ text: value.title, cls: "suggestion-title" });
		if (value.detail) el.createDiv({ text: value.detail, cls: "suggestion-note" });
	}

	selectSuggestion(value: LinkSuggestion): void {
		const link = `[[${value.linktext}]]`;
		this.input.value = link;
		this.onPick(link);
		this.close();
	}
}
