import { createFileRoute } from "@tanstack/react-router";
import { type AdvancedIndex, createSearchAPI } from "fumadocs-core/search/server";
import { siteCatalog } from "../../catalog/data.ts";
import { appPath } from "../../catalog/urls.ts";
import { docsSearchIndexes } from "../../lib/search-index.ts";

/** Each app page, found by its name, what it does, and its summary. */
function appIndexes(): AdvancedIndex[] {
  return siteCatalog.apps.map((app) => ({
    id: appPath(app.slug),
    url: appPath(app.slug),
    title: app.name,
    description: app.pitch,
    breadcrumbs: ["Apps"],
    structuredData: { headings: [], contents: [{ heading: undefined, content: app.summary }] },
  }));
}

const search = createSearchAPI("advanced", {
  indexes: async () => [...(await docsSearchIndexes()), ...appIndexes()],
});

/**
 * The search index, exported whole: every docs page and every app page. The
 * build writes it as a static JSON file (served compressed), and the search
 * dialog queries it in the browser. Keep the path in step with
 * `searchIndexPath` in lib/shared.ts.
 */
export const Route = createFileRoute("/api/search.json")({
  server: {
    handlers: {
      GET: () => search.staticGET(),
    },
  },
});
