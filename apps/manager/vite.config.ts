import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/**
 * Workspace packages list a custom `@appflare/source` export condition first,
 * pointing at `src/` (see the root tsconfig.json). Vite does not know it, so it is
 * added here for the client environment and for the Worker ("ssr") environment,
 * which keeps the Cloudflare plugin's own `workerd`/`worker`/`module`/`browser`
 * conditions (Vite merges the arrays). Without it, dev would need a prior
 * `pnpm build` of the workspace packages.
 */
const SOURCE_CONDITION = "@appflare/source";

export default defineConfig({
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
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
    },
  },
  // Plugin order is settled. Tailwind is required by Kumo's
  // `@cloudflare/kumo/styles` entry (its Tailwind v4 variant, see src/styles.css).
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
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
  ],
});
