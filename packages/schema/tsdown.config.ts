import { defineConfig } from "tsdown";

// ESM + .d.ts into dist/. `dependencies` (zod) stay external. Three entries:
// the package itself, `catalog-display` (the client-safe helpers the manager
// and the docs site share) and `links` (slugs and GitHub repositories, which
// the docs site checks install links with in the browser), which
// package.json exports as subpaths.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "catalog-display": "src/catalog-display/index.ts",
    links: "src/links.ts",
  },
  format: "esm",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  target: "node22",
  fixedExtension: false,
  dts: { sourcemap: false },
  sourcemap: false,
  clean: true,
  // Fail on unresolved imports instead of silently externalizing them. The
  // TypeScript 7 notice is informational.
  failOnWarn: true,
  suppressWarnings: "TypeScript 7.0 does not yet have a stable API",
});
