import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vitest/config";
import { manifestReference } from "./src/reference/integration.ts";

// Plain Node tests. The two plugins give tests the same content the site is
// built from: the generated manifest reference, and the pages compiled by
// Fumadocs MDX (the link check in src/links.test.ts reads them).
export default defineConfig({
  plugins: [manifestReference(), fumadocsMdx()],
  test: {
    environment: "node",
  },
});
