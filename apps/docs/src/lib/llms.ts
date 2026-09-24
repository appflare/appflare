import type * as PageTree from "fumadocs-core/page-tree";
import { formatLlmsIndex, type LlmsLink, type LlmsSection } from "./llms-format.ts";
import { markdownUrl, siteDescription, siteName, siteUrl } from "./shared.ts";
import { type DocsPage, source } from "./source.ts";

function pageLink(node: PageTree.Item): LlmsLink | undefined {
  const page = source.getNodePage(node);
  return page ? linkTo(page) : undefined;
}

function linkTo(page: DocsPage): LlmsLink {
  return {
    title: page.data.title,
    description: page.data.description,
    url: `${siteUrl}${markdownUrl(page.slugs)}`,
  };
}

/** The sidebar as `llms.txt` sections: each separator starts a section of page links. */
function sections(tree: PageTree.Root): LlmsSection[] {
  const out: LlmsSection[] = [];
  let current: LlmsSection = { title: "Pages", links: [] };
  const visit = (nodes: PageTree.Node[]) => {
    for (const node of nodes) {
      if (node.type === "separator") {
        if (current.links.length > 0) out.push(current);
        current = { title: typeof node.name === "string" ? node.name : "Pages", links: [] };
      } else if (node.type === "page") {
        const link = pageLink(node);
        if (link) current.links.push(link);
      } else {
        if (node.index) visit([node.index]);
        visit(node.children);
      }
    }
  };
  visit(tree.children);
  if (current.links.length > 0) out.push(current);
  // The home page is reached from the logo, not the sidebar; list it first.
  const home = source.getPage([]);
  if (home && out[0]) out[0].links.unshift(linkTo(home));
  return out;
}

/**
 * `llms.txt`: every page in sidebar order, linked to its Markdown file, and a
 * pointer to `llms-full.txt`.
 */
export function llmsIndex(): string {
  return formatLlmsIndex({
    title: siteName,
    summary: siteDescription,
    sections: sections(source.getPageTree()),
    optional: [
      {
        title: "Full text",
        description: "every page of these docs in one Markdown file.",
        url: `${siteUrl}/llms-full.txt`,
      },
    ],
  });
}
