import { defineConfig } from "tsdown";

// Library entry (`index`) and the bin (`cli`), ESM + .d.ts into dist/, like
// @appflare/pack. `@appflare/schema` and `@appflare/cf-api/capabilities` are
// bundled (JS and types) from their built
// dist/ so the published package has no `@appflare/*` runtime dependency;
// wrangler, zod, and @clack/prompts stay external `dependencies`.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  target: "node22",
  fixedExtension: false,
  deps: {
    alwaysBundle: [/^@appflare\//],
    // Nothing from node_modules may be bundled; fail instead.
    onlyBundle: [],
    dts: { alwaysBundle: [/^@appflare\//] },
  },
  dts: { sourcemap: false },
  sourcemap: false,
  clean: true,
  failOnWarn: true,
  suppressWarnings: "TypeScript 7.0 does not yet have a stable API",
});
