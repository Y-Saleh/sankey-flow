// Obsidian's official plugin rules — the same checks the community directory runs.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// Build tooling and tests run in Node, not in Obsidian, so the plugin rules do not apply to them.
	{ ignores: ["node_modules/**", "main.js", "tests/**", "examples/**", "esbuild.config.mjs", "vitest.config.ts"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
			},
		},
	},
]);
