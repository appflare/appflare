import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Worker test project: every test runs inside workerd with the manager's real
// bindings from wrangler.jsonc (local D1 and KV, the JOBS workflow).
//
// `main` points at a test entry rather than src/worker.ts: the real entry imports
// TanStack Start's virtual server modules, which only exist under the Start Vite
// plugin. The test entry exports the JobWorkflow class the JOBS binding needs.
//
// Compatibility date: @cloudflare/vitest-pool-workers 0.22.0 (the latest) bundles
// workerd 1.20260815, whose newest supported date is 2026-08-22, one month behind
// wrangler.jsonc. Tests pin that date; nothing tested here depends on newer flags.
//
// Resolution: test files run in Vite's `ssr` environment, which takes its
// conditions from `ssr.resolve.conditions` (the pool only adjusts the top-level,
// client `resolve.conditions`). Without `@appflare/source` there, `@appflare/*`
// resolve through `import` to `dist/`, which does not exist before `pnpm build`
// (CI runs `pnpm check` first). vitest.shared.ts is deliberately NOT spread: it
// hard-codes the `node` condition; these are the Workers conditions instead.
const TEST_COMPATIBILITY_DATE = "2026-08-22";
const conditions = [
  "@appflare/source",
  "workerd",
  "worker",
  "module",
  "browser",
  "development|production",
];

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test/entry.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { compatibilityDate: TEST_COMPATIBILITY_DATE },
    }),
  ],
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
