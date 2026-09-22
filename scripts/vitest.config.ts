import { defineConfig } from "vitest/config";
import { workspaceSourceResolution } from "../vitest.shared.ts";

// Tests for the root release scripts. Not part of `pnpm check` (turbo runs package
// tasks only); CI runs them after `pnpm build` so the built manager is present:
//   pnpm exec vitest run --config scripts/vitest.config.ts
export default defineConfig({
  ...workspaceSourceResolution,
  test: {
    root: import.meta.dirname,
    environment: "node",
    // Packing the built manager spawns `wrangler deploy --dry-run`.
    testTimeout: 120_000,
  },
});
