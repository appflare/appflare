import { defineConfig } from "vitest/config";

// The loader component, which needs a DOM: Node with happy-dom.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.dom.test.tsx"],
  },
});
