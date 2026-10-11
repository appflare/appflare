import type { SearchClient } from "fumadocs-core/search/client";
import type { AdvancedIndex } from "fumadocs-core/search/server";
import { appPath } from "../catalog/urls.ts";

/**
 * The parts of the site's search that the build (`/api/search.json`) and the
 * search dialog share. Nothing here imports the content, so the dialog can
 * load it.
 */

/**
 * How the build makes the index. Results are ranked by relevance and never
 * sorted by a field, so the index leaves out the search engine's sort data:
 * that was about a third of the file the dialog downloads.
 */
export const SEARCH_INDEX_OPTIONS = { sort: { enabled: false } } as const;

/**
 * The heading an app's keywords are filed under. The keywords only help the
 * search find the app; the dialog drops the line that holds them, and lists
 * the app's page as for any other match.
 */
export const KEYWORDS_ANCHOR = "search-keywords";

/** "NodeWarden" as `["Node", "Warden"]`, "OpenSEO" as `["Open", "SEO"]`, "2FA" as `["2", "FA"]`. */
function nameParts(name: string): string[] {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((word) =>
      word.split(
        /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u,
      ),
    )
    .filter((part) => part !== "");
}

/**
 * Words an app is found by besides its name and description: its slug and
 * the parts of both. The search matches the start of a word, so "warden"
 * finds NodeWarden only through `warden` on its own.
 */
export function searchKeywords(app: { slug: string; name: string }): string {
  const words = [
    app.slug,
    ...app.slug.split("-"),
    app.name.replace(/[^\p{L}\p{N}]+/gu, ""),
    ...nameParts(app.name),
  ];
  return [...new Set(words.map((word) => word.toLowerCase()).filter((word) => word !== ""))].join(
    " ",
  );
}

/** Each app's page, found by its name, what it does, its summary and its {@link searchKeywords}. */
export function appSearchIndexes(
  apps: ReadonlyArray<{ slug: string; name: string; pitch: string; summary: string }>,
): AdvancedIndex[] {
  return apps.map((app) => ({
    id: appPath(app.slug),
    url: appPath(app.slug),
    title: app.name,
    description: app.pitch,
    breadcrumbs: ["Apps"],
    structuredData: {
      headings: [],
      contents: [
        { heading: undefined, content: app.summary },
        { heading: KEYWORDS_ANCHOR, content: searchKeywords(app) },
      ],
    },
  }));
}

/** `client`'s results without the lines that hold an app's keywords. */
export function withoutKeywordLines(client: SearchClient): SearchClient {
  return {
    ...client,
    search: async (query) =>
      (await client.search(query)).filter((result) => !result.url.endsWith(`#${KEYWORDS_ANCHOR}`)),
  };
}
