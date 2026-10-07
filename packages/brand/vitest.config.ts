import { defineConfig } from "vitest/config";

// The motion's geometry, in plain Node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
