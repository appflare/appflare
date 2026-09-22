import type { ViteUserConfig } from "vitest/config";

/**
 * Makes Vitest resolve `@appflare/*` workspace imports to their TypeScript
 * source instead of `dist/`, so tests never need a prior `pnpm build`.
 *
 * Every workspace package lists a custom `@appflare/source` export condition
 * first (pointing at `src/`), ahead of `types`/`import` (pointing at `dist/`).
 * tsc picks it up through `customConditions` in the root tsconfig.json; Vitest
 * picks it up here. Consumers outside the monorepo never set the condition, so
 * they get `dist/`.
 *
 * Setting `conditions` replaces Vite's defaults, so the remaining entries repeat
 * Vitest's own server defaults (`node` plus the development/production switch).
 * Vitest also forwards `ssr.resolve.conditions` to the Node test worker as
 * `--conditions`, which covers externalized imports.
 */
const conditions = ["@appflare/source", "node", "development|production"];

export const workspaceSourceResolution = {
  resolve: { conditions },
  ssr: { resolve: { conditions } },
} satisfies ViteUserConfig;
