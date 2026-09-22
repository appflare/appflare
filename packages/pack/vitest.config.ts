import { defineConfig } from "vitest/config";

// Plain Node test project. Tests live next to the code under `src`; the
// `fixtures/` tree is a real wrangler project and must not be scanned for tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
