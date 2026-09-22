import { defineConfig } from "vitest/config";
import { workspaceSourceResolution } from "../../vitest.shared.ts";

// Plain Node test project; tests live next to the code under `src` and never
// touch the network or a Cloudflare account (wrangler and fetch are faked).
export default defineConfig({
  ...workspaceSourceResolution,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
