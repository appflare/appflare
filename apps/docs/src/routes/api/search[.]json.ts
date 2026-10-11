import { createFileRoute } from "@tanstack/react-router";
import { createSearchAPI } from "fumadocs-core/search/server";
import { siteCatalog } from "../../catalog/data.ts";
import { docsSearchIndexes } from "../../lib/search-index.ts";
import { appSearchIndexes, SEARCH_INDEX_OPTIONS } from "../../lib/site-search.ts";

const search = createSearchAPI("advanced", {
  ...SEARCH_INDEX_OPTIONS,
  indexes: async () => [...(await docsSearchIndexes()), ...appSearchIndexes(siteCatalog.apps)],
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
