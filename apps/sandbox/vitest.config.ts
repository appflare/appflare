import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Worker test project: tests run inside workerd with a local R2 bucket as
// BUILDS. The containers themselves cannot run here (they need Cloudflare's
// container runtime), so the tests drive the build steps through a scripted
// fake of the sandbox interface, and wrangler.jsonc (whose `containers` block
// would need Docker) is not loaded: the bindings are declared below instead.
//
// Compatibility date: @cloudflare/vitest-pool-workers 0.22.0 bundles workerd
// 1.20260815, whose newest supported date is 2026-08-22.
//
// Resolution: `@appflare/source` first so `@appflare/schema` resolves to its
// TypeScript source (no `pnpm build` needed), then the Workers conditions.
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
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["BUILDS"],
        bindings: {
          APPFLARE_VERSION: "0.1.0",
          // wrangler.jsonc's version metadata binding, as the version it reports.
          CF_VERSION_METADATA: { id: "version-under-test", tag: "", timestamp: "" },
        },
      },
    }),
  ],
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
