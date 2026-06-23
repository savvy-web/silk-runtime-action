import { defineConfig } from "@savvy-web/github-action-builder";

export default defineConfig({
	entries: {
		main: "src/main.ts",
		post: "src/post.ts",
		workers: { "turbo-server": "src/turbo-server.ts" },
	},
	build: {
		minify: true,
		// `@cyclonedx/cyclonedx-library` (pulled in transitively by
		// `@savvy-web/github-action-effects`) ships optional plugins — XML
		// serializers/validators and draft-2019 JSON validators — that this
		// action never invokes. They aren't installed and would never be
		// present in the deployed action, so `ignore` (alias to a throwing
		// stub) is correct here, not `externals` (which means "available at
		// runtime"). cyclonedx's `_optPlug` wrapper try/catches the stub throw
		// and falls through gracefully.
		ignore: ["xmlbuilder2", "libxmljs2", "ajv-formats-draft2019"],
	},
	persistLocal: {
		enabled: true,
		path: ".github/actions/local",
	},
});
