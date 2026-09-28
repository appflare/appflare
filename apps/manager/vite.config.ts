import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";
import { kumoLoaderAsAppflareLoader } from "./scripts/kumo-loader.ts";

/**
 * Workspace packages list a custom `@appflare/source` export condition first,
 * pointing at `src/` (see the root tsconfig.json). Vite does not know it, so it is
 * added here for the client environment and for the Worker ("ssr") environment,
 * which keeps the Cloudflare plugin's own `workerd`/`worker`/`module`/`browser`
 * conditions (Vite merges the arrays). Without it, dev would need a prior
 * `pnpm build` of the workspace packages.
 */
const SOURCE_CONDITION = "@appflare/source";

/**
 * `APPFLARE_VERSION` is baked into the Worker's vars at build time.
 * The release workflow sets it in the environment before `vite build`
 * (`APPFLARE_VERSION=<version> pnpm release:pack`); local builds and dev fall back
 * to `0.0.0-dev`, the value in wrangler.jsonc. The plugin's `config` object is
 * merged over wrangler.jsonc, so this wins in the generated dist/server/wrangler.json.
 * It is also written into the code as `__APPFLARE_BUILD_VERSION__`
 * (src/server/build-version.ts): a var can be edited on deploy, the code cannot.
 */
const APPFLARE_VERSION = process.env.APPFLARE_VERSION?.trim() || "0.0.0-dev";

/**
 * TanStack Start bundles a route manifest into the Worker that names each
 * route's source file by its absolute path on the machine that built it
 * (`filePath`, e.g. `/home/runner/work/.../src/routes/login.tsx`). The build
 * uses those paths to match routes to client chunks before this module is
 * written; nothing reads them at runtime, and TanStack Start has no option to
 * leave them out. This rewrites them relative to the app's root, so a release
 * carries no path from the machine that built it.
 */
const START_MANIFEST_MODULE = "\0tanstack-start-manifest:v";

function relativeRouteFilePaths(): Plugin {
  let rootPrefix = "";
  return {
    name: "appflare:relative-route-file-paths",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "ssr",
    configResolved(config) {
      rootPrefix = `${config.root.replaceAll("\\", "/").replace(/\/$/, "")}/`;
    },
    transform: {
      filter: { id: /^\0tanstack-start-manifest:v$/ },
      handler(code, id) {
        if (id !== START_MANIFEST_MODULE || !code.includes(rootPrefix)) return null;
        return { code: code.replaceAll(rootPrefix, ""), map: null };
      },
    },
  };
}

export default defineConfig({
  define: { __APPFLARE_BUILD_VERSION__: JSON.stringify(APPFLARE_VERSION) },
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  // Dev serves Kumo from Vite's pre-bundled dependencies, which skip the
  // plugins below, so the pre-bundler gets the Kumo loader swap as well.
  optimizeDeps: { rolldownOptions: { plugins: [kumoLoaderAsAppflareLoader()] } },
  environments: {
    ssr: {
      resolve: {
        conditions: [
          SOURCE_CONDITION,
          "workerd",
          "worker",
          "module",
          "browser",
          "development|production",
        ],
      },
      build: {
        rolldownOptions: {
          output: {
            // The Worker is emitted as ONE module. Updating a Worker in place
            // (a self-update, or any version upload) sends every module in one
            // request, and each module is Range-fetched from the release zip in
            // that same invocation, two subrequests apiece on a GitHub release
            // asset (the redirect plus the real request). A code-split build
            // (84 chunks) cannot fit the free plan's 50 subrequests per
            // invocation. `codeSplitting: false` is Rolldown's replacement for
            // Rollup's `inlineDynamicImports: true`. The client bundle keeps its
            // code splitting: its chunks are static assets, uploaded in batches.
            codeSplitting: false,
          },
        },
      },
    },
  },
  // Plugin order is settled. Tailwind is required by Kumo's
  // `@cloudflare/kumo/styles` entry (its Tailwind v4 variant, see src/styles.css).
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: { vars: { APPFLARE_VERSION } },
    }),
    tanstackStart({
      spa: {
        enabled: true,
        // The shell is written to `/index.html` (default `/_shell.html`) so
        // Workers static assets' `not_found_handling: "single-page-application"`,
        // which always falls back to `/index.html`, serves it for every route.
        prerender: { outputPath: "/index" },
      },
    }),
    react(),
    tailwindcss(),
    relativeRouteFilePaths(),
    kumoLoaderAsAppflareLoader(),
  ],
});
