import { defineConfig } from "vitest/config";
import { workspaceSourceResolution } from "../../vitest.shared.ts";

// Plain Node test project. Tests live next to the code under `src`; the
// `fixtures/` tree is a real wrangler project and must not be scanned for tests.
export default defineConfig({
  ...workspaceSourceResolution,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
