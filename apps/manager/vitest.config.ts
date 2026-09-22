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
// vitest.shared.ts is deliberately NOT spread here: it hard-codes the `node`
// condition, which the Workers pool removes. The pool adds workerd/worker/module/
// browser itself; the workspace source condition is added directly.
const TEST_COMPATIBILITY_DATE = "2026-08-22";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test/entry.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { compatibilityDate: TEST_COMPATIBILITY_DATE },
    }),
  ],
  resolve: { conditions: ["@appflare/source"] },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
