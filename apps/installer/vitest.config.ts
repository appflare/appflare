import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Worker test project: tests run inside workerd with wrangler.jsonc's bindings
// (a local D1 as DB, the development vars). Every outgoing request goes to the
// fakes in src/test/, never to Cloudflare or GitHub.
//
// Compatibility date: @cloudflare/vitest-pool-workers 0.22.0 bundles workerd
// 1.20260815, whose newest supported date is 2026-08-22.
//
// Resolution: `@appflare/source` first so the workspace packages resolve to
// their TypeScript source, then the Workers conditions.
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
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { compatibilityDate: "2026-08-22" },
    }),
  ],
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
