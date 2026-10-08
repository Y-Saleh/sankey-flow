import type { ColorMode, FlowColorMode } from "../model/schema";

/**
 * Colours are produced as CSS expressions built on Obsidian's theme
 * variables (`--interactive-accent`, `--color-blue`, `--background-primary`,
 * …). The browser resolves them, so diagrams follow the active theme, light
 * and dark mode and community themes with no JavaScript re-rendering.
 *
 * Every automatic colour is gently mixed towards the background, which
 * gives a restrained, readable palette instead of saturated primaries.
 */

export interface ColorContext {
	mode: ColorMode;
	isDark: boolean;
	/** Custom accent; empty means the theme's accent colour. */
	accent: string;
	/** Fallback for nodes when set; empty means automatic. */
	defaultNodeColor: string;
	customLight: string[];
	customDark: string[];
}

export interface NodeColorInput {
	index: number;
	column: number;
	columnCount: number;
	group: string | null | undefined;
	explicit: string | null | undefined;
}

const ACCENT = "var(--interactive-accent)";

/** Theme hues in an order that keeps neighbours distinct. */
const THEME_HUES = [
	"var(--color-cyan)",
	"var(--color-orange)",
	"var(--color-green)",
	"var(--color-pink)",
	"var(--color-yellow)",
	"var(--color-blue)",
	"var(--color-red)",
	"var(--color-purple)",
];

export function mute(color: string, amount = 14): string {
	return `color-mix(in srgb, ${color} ${100 - amount}%, var(--background-primary))`;
}

function accentOf(ctx: ColorContext): string {
	return ctx.accent.trim() || ACCENT;
}

/** The ordered palette for categorical colouring. */
export function categoricalPalette(ctx: ColorContext): string[] {
	if (ctx.mode === "custom") {
		const custom = ctx.isDark ? ctx.customDark : ctx.customLight;
		if (custom.length) return custom;
	}
	return [accentOf(ctx), ...THEME_HUES].map((c) => mute(c, 20));
}

/** Variations of the accent colour: tints and shades that stay recognisably "accent". */
function accentVariant(ctx: ColorContext, i: number): string {
	const accent = accentOf(ctx);
	const variants = [
		mute(accent, 6),
		`color-mix(in oklab, ${accent} 72%, var(--text-normal))`,
		mute(accent, 38),
		`color-mix(in oklab, ${accent} 78%, var(--color-blue))`,
		`color-mix(in oklab, ${accent} 52%, var(--text-normal))`,
		`color-mix(in oklab, ${accent} 78%, var(--color-pink))`,
		mute(accent, 55),
	];
	return variants[i % variants.length];
}

export function nodeColor(input: NodeColorInput, ctx: ColorContext, groups: readonly string[]): string {
	if (input.explicit) return input.explicit;
	if (ctx.defaultNodeColor.trim()) return ctx.defaultNodeColor.trim();
	switch (ctx.mode) {
		case "accent":
			return accentVariant(ctx, input.column + input.index);
		case "sequential": {
			const t = input.columnCount > 1 ? input.column / (input.columnCount - 1) : 0;
			const pct = Math.round((1 - t) * 100);
			return mute(`color-mix(in oklch, ${accentOf(ctx)} ${pct}%, var(--color-cyan))`);
		}
		case "custom":
		case "categorical":
		default: {
			const palette = categoricalPalette(ctx);
			const key = input.group && groups.length ? groups.indexOf(input.group) : input.index;
			return palette[((key % palette.length) + palette.length) % palette.length];
		}
	}
}

export interface FlowColorInput {
	explicit: string | null | undefined;
	sourceColor: string;
	targetColor: string;
}

/** Returns a single colour, or a [from, to] pair for gradients. */
export function flowColor(input: FlowColorInput, mode: FlowColorMode, defaultFlowColor: string): string | [string, string] {
	if (input.explicit) return input.explicit;
	if (defaultFlowColor.trim()) return defaultFlowColor.trim();
	switch (mode) {
		case "target":
			return input.targetColor;
		case "gradient":
			return [input.sourceColor, input.targetColor];
		case "neutral":
			return "var(--text-muted)";
		case "source":
		default:
			return input.sourceColor;
	}
}

/** Distinct groups in first-seen order (so colours are stable). */
export function groupOrder(nodes: readonly { group?: string | null }[]): string[] {
	const seen: string[] = [];
	for (const n of nodes) if (n.group && !seen.includes(n.group)) seen.push(n.group);
	return seen;
}
