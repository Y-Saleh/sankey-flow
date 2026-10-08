/**
 * Node and flow links are stored as plain strings in standard Obsidian syntax:
 *
 *   [[Note]]  [[Folder/Note#Heading]]  [[Note#^block-id|Alias]]  [[Board.canvas]]
 *   https://example.com   mailto:someone@example.com   obsidian://open?...
 *
 * A bare note name ("Project Alpha") is accepted and treated as a wikilink.
 * Script-capable schemes (javascript:, data:, vbscript:, file:) are refused.
 */

export type ParsedLink =
	| { kind: "internal"; linktext: string; alias: string | null }
	| { kind: "external"; url: string };

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel", "obsidian", "zotero"]);
const KNOWN_SCHEMES = /^(mailto|tel|javascript|data|vbscript|file|obsidian|zotero|blob|about):/i;
const URL_LIKE = /^([a-z][a-z0-9+.-]*):\/\//i;
const WIKILINK = /^!?\[\[([^\]]+?)\]\]$/;
const MARKDOWN_LINK = /^\[([^\]]*)\]\((.+)\)$/;

function schemeOf(value: string): string | null {
	const m = URL_LIKE.exec(value) ?? KNOWN_SCHEMES.exec(value);
	return m ? m[1].toLowerCase() : null;
}

export function parseLink(value: string | null | undefined): ParsedLink | null {
	if (!value) return null;
	const v = value.trim();
	if (!v) return null;

	const wiki = WIKILINK.exec(v);
	if (wiki) {
		const inner = wiki[1];
		const pipe = inner.indexOf("|");
		const linktext = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
		const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() || null : null;
		return linktext ? { kind: "internal", linktext, alias } : null;
	}

	const md = MARKDOWN_LINK.exec(v);
	if (md) {
		const target = md[2].trim().replace(/^<|>$/g, "");
		const parsed = parseLink(target);
		if (parsed?.kind === "internal") {
			let linktext = parsed.linktext;
			try {
				linktext = decodeURI(linktext);
			} catch {
				// Keep the raw text when it is not valid percent-encoding.
			}
			return { kind: "internal", linktext, alias: md[1] || null };
		}
		return parsed;
	}

	const scheme = schemeOf(v);
	if (scheme) return SAFE_SCHEMES.has(scheme) ? { kind: "external", url: v } : null;
	if (/[\n\r]/.test(v)) return null;
	return { kind: "internal", linktext: v, alias: null };
}

export function isAllowedLink(value: string): boolean {
	return parseLink(value) !== null;
}

/** Normalises user input to canonical storage form: wikilink or URL. */
export function canonicalLink(value: string): string | null {
	const parsed = parseLink(value);
	if (!parsed) return null;
	if (parsed.kind === "external") return parsed.url;
	return parsed.alias ? `[[${parsed.linktext}|${parsed.alias}]]` : `[[${parsed.linktext}]]`;
}

/** The note path part of a linktext: "Folder/Note#Heading" → "Folder/Note". */
export function linkpathOf(linktext: string): string {
	const hash = linktext.indexOf("#");
	return (hash >= 0 ? linktext.slice(0, hash) : linktext).trim();
}

/** Subpath including the leading "#", or "". */
export function subpathOf(linktext: string): string {
	const hash = linktext.indexOf("#");
	return hash >= 0 ? linktext.slice(hash) : "";
}

/** Human-readable text for a link: alias, else the last path segment and subpath. */
export function linkDisplayText(value: string): string {
	const parsed = parseLink(value);
	if (!parsed) return value;
	if (parsed.kind === "external") return parsed.url.replace(/^https?:\/\//, "");
	if (parsed.alias) return parsed.alias;
	const path = linkpathOf(parsed.linktext);
	const base = path.split("/").pop() ?? path;
	const sub = subpathOf(parsed.linktext).replace(/^#\^?/, " › ");
	return (base.replace(/\.md$/i, "") + sub).trim();
}
