/** Console logging that stays silent unless "Enable debug logging" is on. */
export class Logger {
	constructor(private readonly isEnabled: () => boolean) {}

	debug(...args: unknown[]): void {
		if (this.isEnabled()) console.debug("[Sankey Flow]", ...args);
	}

	/** Unexpected failures are always logged; users see a friendly Notice instead. */
	error(message: string, error?: unknown): void {
		if (this.isEnabled()) console.error("[Sankey Flow]", message, error);
		else console.error(`[Sankey Flow] ${message}${error instanceof Error ? `: ${error.message}` : ""}`);
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
