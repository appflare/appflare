import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vitest/config";
import { workspaceSourceResolution } from "../../vitest.shared.ts";
import { catalogData, loadCatalog } from "./src/catalog/plugin.ts";
import { docsScreenshots } from "./src/og/plugin.ts";
import { manifestReference } from "./src/reference/integration.ts";

// Plain Node tests. The plugins give tests the same content the site is
// built from: the generated manifest reference, the pages compiled by
// Fumadocs MDX (the link check in src/links.test.ts reads them), and the
// catalog, always from the checked-in snapshot so tests never use the network.
export default defineConfig(async () => ({
  ...workspaceSourceResolution,
  plugins: [
    catalogData(await loadCatalog("fixture")),
    docsScreenshots(),
    manifestReference(),
    fumadocsMdx(),
  ],
  test: {
    environment: "node",
  },
}));
