export interface ValueFormat {
	prefix: string;
	suffix: string;
	decimals: number | null;
}

const cache = new Map<string, Intl.NumberFormat>();

function formatter(decimals: number | null, magnitude: number): Intl.NumberFormat {
	const max = decimals ?? (magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2);
	const min = decimals ?? 0;
	const key = `${min}:${max}`;
	let f = cache.get(key);
	if (!f) {
		f = new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max });
		cache.set(key, f);
	}
	return f;
}

export function formatValue(value: number, format: ValueFormat): string {
	if (!Number.isFinite(value)) return "–";
	const text = formatter(format.decimals, Math.abs(value)).format(value);
	return `${format.prefix}${text}${format.suffix}`;
}

export function formatShare(part: number, total: number): string {
	if (!(total > 0)) return "";
	const pct = (part / total) * 100;
	return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}
