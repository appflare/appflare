import { defineConfig } from "vitest/config";

// Plain Node test project. A Worker package would instead add the `cloudflareTest`
// plugin from `@cloudflare/vitest-pool-workers` to `plugins` (see the root
// vitest.config.ts for the full opt-in snippet).
export default defineConfig({
  test: {
    environment: "node",
  },
});
