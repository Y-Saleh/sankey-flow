/** Turns a label into a readable identifier: "Natural Gas (LNG)" → "natural-gas-lng". */
export function slugify(label: string): string {
	const slug = label
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\[\[|\]\]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "node";
}

/** Returns `base`, or `base-2`, `base-3`, … whichever is not in `taken`. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Short random id for flows, which have no natural name. */
export function randomId(prefix: string, taken: ReadonlySet<string>): string {
	for (;;) {
		const candidate = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
		if (!taken.has(candidate)) return candidate;
	}
}
