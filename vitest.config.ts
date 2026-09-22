import { defineConfig } from "vitest/config";

// Root multi-project config (Vitest 4's `projects` mechanism, which replaced the
// removed `vitest.workspace.ts`). Running `vitest` here discovers every workspace
// package that ships its own `vitest.config.ts` and runs them as isolated projects.
//
// Per-package runs (`turbo run test` -> `vitest run` inside a package) resolve the
// package's own nearest config, so they stay scoped to that package.
//
// HOW A WORKER PACKAGE OPTS IN (verified against @cloudflare/vitest-pool-workers
// 0.22.0, which targets Vitest 4): the old `defineWorkersConfig` /
// `defineWorkersProject` helper and the `/config` subpath were removed. A Worker
// package now uses the `cloudflareTest` Vite plugin from the package root:
//
//   import { defineConfig } from "vitest/config";
//   import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
//   export default defineConfig({
//     plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
//     test: { /* ... */ },
//   });
//
// Plain Node packages use `defineConfig` with `test.environment: "node"`. Either
// kind is picked up by the globs below.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
