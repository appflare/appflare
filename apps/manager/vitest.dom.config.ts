import { defineConfig } from "vitest/config";
import { workspaceSourceResolution } from "../../vitest.shared.ts";

// Browser-side component tests (`*.dom.test.tsx`): keyboard, paste and click
// behaviour that needs a DOM, which the Worker test pool in vitest.config.ts
// (workerd) does not have. They run in Node with happy-dom instead, as the
// `dom` project of vitest.config.ts.
export default defineConfig({
  ...workspaceSourceResolution,
  test: {
    name: "dom",
    environment: "happy-dom",
    include: ["src/**/*.dom.test.tsx"],
  },
});
