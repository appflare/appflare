import { defineConfig } from "tsdown";

// Library entry (`index`) and the `appflare-pack` bin (`cli`), ESM + .d.ts into
// dist/. The workspace packages `@appflare/schema` and `@appflare/cf-api` are
// bundled (JS and types) so the published package has no `@appflare/*` runtime
// dependency; every third-party `dependencies` entry stays external. They are
// bundled from their built dist/ (JS and .d.ts), not from src: the declaration
// pass (tsgo) cannot emit types for files outside this package. Turbo's
// `build` dependsOn `^build` builds them first; tsconfig.build.json clears the
// `@appflare/source` condition so types resolve to dist as well.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  target: "node22",
  fixedExtension: false,
  deps: {
    alwaysBundle: [/^@appflare\//],
    // Nothing from node_modules may be bundled (the workspace packages resolve
    // through symlinks to packages/*, outside node_modules); fail instead.
    onlyBundle: [],
    dts: { alwaysBundle: [/^@appflare\//] },
  },
  dts: { sourcemap: false },
  sourcemap: false,
  clean: true,
  // An unresolved import is a warning that rolldown turns into an external;
  // fail instead. The TypeScript 7 notice is informational.
  failOnWarn: true,
  suppressWarnings: "TypeScript 7.0 does not yet have a stable API",
});
