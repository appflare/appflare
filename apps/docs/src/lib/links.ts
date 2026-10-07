import { type FileObject, type ScanResult, type UrlMeta, validateFiles } from "next-validate-link";
import { AGENT_PROMPTS } from "./agent-prompts.ts";
import { markdownUrl, pageUrl, searchIndexPath } from "./shared.ts";

/** What the link check needs to know about one page. */
export interface LinkTarget {
  slugs: string[];
  /** Heading anchors on the page, without `#`. */
  headings: string[];
}

/** Files the build writes besides the pages, which content may link to. */
const staticFiles = [
  ...Object.values(AGENT_PROMPTS).map((prompt) => prompt.path),
  "/llms.txt",
  "/llms-full.txt",
  "/sitemap.xml",
  searchIndexPath,
  "/favicon.svg",
  "/badge.svg",
  "/deploy-badge.svg",
];

/**
 * Every internal URL the site serves. A page answers at its canonical URL and
 * without the trailing slash (Workers static assets redirects that form), and
 * each docs page has its Markdown file. `pages` are the other pages the site
 * builds (the catalog's), by canonical URL, which have no Markdown file.
 */
export function siteUrls(
  targets: readonly LinkTarget[],
  pages: readonly string[] = [],
): ScanResult {
  const urls = new Map<string, UrlMeta>();
  for (const { slugs, headings } of targets) {
    const meta = { hashes: headings };
    const canonical = pageUrl(slugs);
    urls.set(canonical, meta);
    if (canonical !== "/") urls.set(canonical.slice(0, -1), meta);
    urls.set(markdownUrl(slugs), {});
  }
  for (const page of pages) {
    urls.set(page, {});
    if (page !== "/") urls.set(page.replace(/\/$/, ""), {});
  }
  for (const file of staticFiles) urls.set(file, {});
  return { urls, fallbackUrls: [] };
}

/**
 * Absolute URLs of this site written anywhere in the files, code blocks
 * included (the agent prompts are code blocks), that the site does not serve.
 * Markdown link checking skips absolute URLs as external.
 */
export function findBrokenSiteUrls(
  files: readonly FileObject[],
  targets: readonly LinkTarget[],
  siteUrl: string,
  pages: readonly string[] = [],
): BrokenLink[] {
  const { urls } = siteUrls(targets, pages);
  const pattern = new RegExp(`${siteUrl.replaceAll(".", "\\.")}(/[^\\s)"'\`<>]*)?`, "g");
  const broken: BrokenLink[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        // Punctuation that ends the sentence is not part of the URL.
        const url = match[0].replace(/[.,;:]+$/, "");
        // The query (`/install/?repo=owner/repo`) is read by the page, not the server.
        const path = (url.slice(siteUrl.length) || "/").split(/[?#]/)[0] || "/";
        if (!urls.has(path)) {
          broken.push({ file: file.path, url, line: index + 1, reason: "not-found" });
        }
      }
    });
  }
  return broken;
}

export interface BrokenLink {
  file: string;
  url: string;
  line: number;
  reason: string;
}

/**
 * Checks every link in the given Markdown and MDX files, and the `href` of
 * every `Card`, against the URLs the site serves, anchors included. External
 * links are not fetched.
 */
export async function findBrokenLinks(
  files: FileObject[],
  targets: readonly LinkTarget[],
  pages: readonly string[] = [],
): Promise<BrokenLink[]> {
  const results = await validateFiles(files, {
    scanned: siteUrls(targets, pages),
    markdown: { components: { Card: { attributes: ["href"] } } },
    checkRelativePaths: "as-url",
  });
  return results.flatMap((result) =>
    result.errors.map((error) => ({
      file: result.file,
      url: error.url,
      line: error.line,
      reason: error.reason instanceof Error ? error.reason.message : error.reason,
    })),
  );
}
