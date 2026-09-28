import { findPath } from "fumadocs-core/page-tree";
import type { AdvancedIndex } from "fumadocs-core/search/server";
import { type DocsPage, source } from "./source.ts";

/**
 * The search index of the docs pages, as Fumadocs' `createFromSource` builds
 * it (each page's headings and paragraphs, with the sidebar folders above it
 * as breadcrumbs), written out so the index can hold the catalog's pages too.
 */

/** The sidebar folders above a page, outermost first. */
function breadcrumbs(page: DocsPage): string[] | undefined {
  const tree = source.getPageTree();
  const path = findPath(tree.children, (node) => node.type === "page" && node.url === page.url);
  if (!path) return undefined;
  path.pop();
  const names: string[] = [];
  if (typeof tree.name === "string" && tree.name !== "") names.push(tree.name);
  for (const node of path) {
    if (typeof node.name === "string" && node.name !== "") names.push(node.name);
  }
  return names;
}

export async function docsSearchIndexes(): Promise<AdvancedIndex[]> {
  return Promise.all(
    source.getPages().map(async (page) => {
      const { structuredData } = await page.data.load();
      return {
        id: page.url,
        url: page.url,
        title: page.data.title,
        description: page.data.description,
        breadcrumbs: breadcrumbs(page),
        structuredData,
      };
    }),
  );
}
