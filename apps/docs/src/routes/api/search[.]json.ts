import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";
import { source } from "../../lib/source.ts";

const search = createFromSource(source);

/**
 * The search index, exported whole. The build writes it as a static JSON file
 * (served compressed), and the search dialog queries it in the browser.
 * Keep the path in step with `searchIndexPath` in lib/shared.ts.
 */
export const Route = createFileRoute("/api/search.json")({
  server: {
    handlers: {
      GET: () => search.staticGET(),
    },
  },
});
