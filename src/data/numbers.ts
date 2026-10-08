export type DecimalFormat = "auto" | "dot" | "comma";

/**
 * Parses human-entered numbers such as "1,234.5", "1.234,5", "1 234",
 * "€ 12.50", "(42)" (accounting negative) or "12%". Returns null for anything
 * that is not clearly a number rather than guessing.
 *
 * In "auto" mode a lone comma followed by exactly three digits groups is read
 * as a thousands separator ("1,234" → 1234); otherwise it is a decimal comma
 * ("12,5" → 12.5).
 */
export function parseNumber(input: string, format: DecimalFormat = "auto"): number | null {
	let s = input.trim();
	if (!s) return null;

	let negative = false;
	if (/^\(.*\)$/.test(s)) {
		negative = true;
		s = s.slice(1, -1).trim();
	}
	// Strip currency symbols, percent signs, unit-free whitespace and apostrophe grouping.
	s = s.replace(/[\s  '’]/g, "").replace(/^[^\d.,+-]+|[^\d.,]+$/g, "");
	if (/^[+-]/.test(s)) {
		if (s[0] === "-") negative = !negative;
		s = s.slice(1);
	}
	if (!s || !/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

	const decimal = resolveDecimal(s, format);
	if (decimal === null) return null;
	const group = decimal === "." ? "," : ".";

	const parts = s.split(decimal);
	if (parts.length > 2) return null;
	const [intPart, fracPart = ""] = parts;
	if (fracPart.includes(group)) return null;
	if (intPart.includes(group) && !/^\d{1,3}([.,]\d{3})+$/.test(intPart)) return null;

	const normalized = `${intPart.split(group).join("")}${fracPart ? "." + fracPart : ""}`;
	const value = Number(normalized.startsWith(".") ? "0" + normalized : normalized);
	if (!Number.isFinite(value)) return null;
	return negative ? -value : value;
}

function resolveDecimal(s: string, format: DecimalFormat): "." | "," | null {
	if (format === "dot") return ".";
	if (format === "comma") return ",";
	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");
	if (lastDot >= 0 && lastComma >= 0) return lastDot > lastComma ? "." : ",";
	if (lastComma >= 0) {
		return /^\d{1,3}(,\d{3})+$/.test(s) ? "." : ",";
	}
	if (lastDot >= 0 && /^\d{1,3}(\.\d{3}){2,}$/.test(s)) return ",";
	return ".";
}
