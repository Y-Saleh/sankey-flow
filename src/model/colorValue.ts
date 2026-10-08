/**
 * Colours from diagram files are untrusted. They end up in SVG `style`
 * properties, so anything that could trigger a network request
 * (`url(...)`, `image-set(...)`) or break out of the property is rejected.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(\s*[0-9.,%\s/+-]*(?:deg|rad|turn)?[0-9.,%\s/+-]*\)$/i;
const NAMED = /^[a-z]{3,24}$/i;
const CSS_VAR = /^var\(\s*--[a-z0-9-]+\s*\)$/i;

export function isSafeColor(value: string): boolean {
	const v = value.trim();
	if (!v || v.length > 64) return false;
	return HEX.test(v) || FUNCTIONAL.test(v) || NAMED.test(v) || CSS_VAR.test(v);
}

/** Expands `#abc` → `#aabbcc` and returns null for anything that is not a hex colour. */
export function normalizeHex(value: string): string | null {
	const v = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(v)) return v;
	if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
	return null;
}

/** Parses a comma/space separated palette, keeping only safe colours. */
export function parsePalette(text: string): string[] {
	return text
		.split(/[\s,;]+/)
		.map((c) => c.trim())
		.filter((c) => c && isSafeColor(c));
}
