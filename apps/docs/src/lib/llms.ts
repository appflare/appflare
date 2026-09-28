import type * as PageTree from "fumadocs-core/page-tree";
import { siteCatalog } from "../catalog/data.ts";
import { type CatalogPageEntry, catalogPageEntries } from "../catalog/pages.ts";
import { agentInstructionsUrl } from "./agent-prompts.ts";
import { formatLlmsIndex, type LlmsLink, type LlmsSection } from "./llms-format.ts";
import { markdownUrl, SITE_URL, siteDescription, siteName } from "./shared.ts";
import { type DocsPage, source } from "./source.ts";

function pageLink(node: PageTree.Item): LlmsLink | undefined {
  const page = source.getNodePage(node);
  return page ? linkTo(page) : undefined;
}

function linkTo(page: DocsPage): LlmsLink {
  return {
    title: page.data.title,
    description: page.data.description,
    url: `${SITE_URL}${markdownUrl(page.slugs)}`,
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
  // Pages the sidebar leaves out, such as the privacy page, are still pages.
  const listed = new Set(out.flatMap((section) => section.links.map((link) => link.url)));
  const unlisted = source
    .getPages()
    .map(linkTo)
    .filter((link) => !listed.has(link.url));
  if (unlisted.length > 0) out.push({ title: "Other pages", links: unlisted });
  return out;
}

/** The step-by-step instructions the site's agent prompts point at. */
function agentSection(): LlmsSection {
  return {
    title: "Instructions for coding agents",
    links: [
      {
        title: "Install Appflare",
        description: "Install Appflare into the user's Cloudflare account with the installer.",
        url: agentInstructionsUrl("install"),
      },
      {
        title: "Add an app to the catalog",
        description: "Write an app's catalog manifest, check it, and open the pull request.",
        url: agentInstructionsUrl("submit"),
      },
    ],
  };
}

function catalogLink({ title, description, url }: CatalogPageEntry): LlmsLink {
  return { title, description, url: `${SITE_URL}${url}` };
}

/** The catalog's pages: the apps page and each app, then each category. */
function catalogSections(): LlmsSection[] {
  const { apps, appPages, categoryPages } = catalogPageEntries(siteCatalog);
  return [
    { title: "Apps", links: [apps, ...appPages].map(catalogLink) },
    { title: "App categories", links: categoryPages.map(catalogLink) },
  ];
}

/**
 * `llms.txt`: the instructions for coding agents, every page in sidebar
 * order, linked to its Markdown file, then the catalog's pages, and a pointer
 * to `llms-full.txt`.
 */
export function llmsIndex(): string {
  return formatLlmsIndex({
    title: siteName,
    summary: siteDescription,
    sections: [agentSection(), ...sections(source.getPageTree()), ...catalogSections()],
    optional: [
      {
        title: "Full text",
        description: "every page of these docs in one Markdown file.",
        url: `${SITE_URL}/llms-full.txt`,
      },
    ],
  });
}
