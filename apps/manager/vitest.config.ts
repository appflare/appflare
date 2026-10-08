import { globSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Three test projects, run by one `vitest run` so that `--shard` (CI) splits all
// of them: `worker` and `worker-isolated` run inside workerd with the manager's
// real bindings from wrangler.jsonc (local D1 and KV, the JOBS workflow), and
// vitest.dom.config.ts runs the `*.dom.test.tsx` component tests in Node.
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
//
// Isolation: by default Vitest starts a fresh runtime for every test file, and
// each one imports the whole module graph again; that made this suite take
// eleven minutes in CI. The `worker` project instead runs its files one after
// another in one runtime per Vitest worker (`isolate: false`), so a file starts
// with the modules, and the module state, the files before it left.
// src/test/between-files.ts empties the bindings after each file, which a fresh
// runtime used to do. A module mock (`vi.mock`) or a global stub
// (`vi.stubGlobal`) would outlive its file too, so the files that use one run
// in `worker-isolated`, a runtime each; the list below finds them by reading
// every test file, so a new one needs no entry here.
const TEST_COMPATIBILITY_DATE = "2026-08-22";
const conditions = [
  "@appflare/source",
  "workerd",
  "worker",
  "module",
  "browser",
  "development|production",
];

const include = ["src/**/*.test.ts"];
const isolated = globSync(include, { exclude: ["node_modules/**"] }).filter((file) =>
  /\bvi\.(mock|doMock|stubGlobal)\(/.test(readFileSync(file, "utf8")),
);

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
    setupFiles: ["./src/test/between-files.ts"],
    projects: [
      { extends: true, test: { name: "worker", include, exclude: isolated, isolate: false } },
      { extends: true, test: { name: "worker-isolated", include: isolated } },
      "./vitest.dom.config.ts",
    ],
  },
});
