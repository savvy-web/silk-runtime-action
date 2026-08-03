import { defineConfig } from "@savvy-web/github-action-builder";

export default defineConfig({
	entries: {
		main: "src/main.ts",
		post: "src/post.ts",
		workers: { "turbo-server": "src/turbo-server.ts" },
	},
	build: {
		minify: true,
		// Vestigial insurance from the legacy cyclonedx sbom stack: these
		// optional plugins (XML serializers/validators, draft-2019 JSON
		// validators) no longer appear anywhere in the dependency tree, so
		// the aliases are inert. Kept as a harmless guard in case a future
		// dependency reintroduces cyclonedx's `_optPlug` optional-require
		// pattern; `ignore` (alias to a throwing stub) is the right shape
		// for that, not `externals` (which means "available at runtime").
		ignore: ["xmlbuilder2", "libxmljs2", "ajv-formats-draft2019"],
	},
	persistLocal: {
		enabled: true,
		path: ".github/actions/local",
	},
});
