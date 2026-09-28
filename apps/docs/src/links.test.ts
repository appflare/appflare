import type { FileObject } from "next-validate-link";
import { beforeAll, describe, expect, it } from "vitest";
import { siteCatalog } from "./catalog/data.ts";
import { catalogPagePaths } from "./catalog/urls.ts";
import {
  type BrokenLink,
  findBrokenLinks,
  findBrokenSiteUrls,
  type LinkTarget,
} from "./lib/links.ts";
import { pageUrl, siteUrl } from "./lib/shared.ts";
import { source } from "./lib/source.ts";

async function contentTargets(): Promise<LinkTarget[]> {
  return Promise.all(
    source.getPages().map(async (page) => {
      const { toc } = await page.data.load();
      return { slugs: page.slugs, headings: toc.map((item) => item.url.replace(/^#/, "")) };
    }),
  );
}

async function contentFiles(): Promise<FileObject[]> {
  return Promise.all(
    source.getPages().map(async (page) => ({
      path: page.absolutePath ?? page.path,
      content: await page.data.getText("raw"),
      url: pageUrl(page.slugs),
    })),
  );
}

/**
 * Loading the pages compiles every MDX file on first import, and the scan
 * parses each one again: several seconds on a shared CI runner, past the
 * default per-test timeout. Both run once, before the checks that read them,
 * with a timeout well past what they need.
 */
const scanTimeout = 120_000;

/** The catalog's pages, which content may link to. */
const catalogPages = catalogPagePaths(siteCatalog);

describe("internal links", () => {
  let files: FileObject[];
  let targets: LinkTarget[];
  let brokenLinks: BrokenLink[];

  beforeAll(async () => {
    [files, targets] = await Promise.all([contentFiles(), contentTargets()]);
    brokenLinks = await findBrokenLinks(files, targets, catalogPages);
  }, scanTimeout);

  it("point at pages and headings that exist", () => {
    const report = brokenLinks.map(
      ({ file, line, url, reason }) => `${file}:${line} ${url} (${reason})`,
    );
    expect(report).toEqual([]);
  });

  it("written as absolute URLs of this site, as in the agent prompts, exist", () => {
    const broken = findBrokenSiteUrls(files, targets, siteUrl, catalogPages);
    expect(broken.map(({ file, line, url }) => `${file}:${line} ${url}`)).toEqual([]);
  });

  it("covers every page, including the generated manifest reference", () => {
    const urls = source.getPages().map((page) => pageUrl(page.slugs));
    expect(urls).toContain("/");
    expect(urls).toContain("/catalog/manifest-reference/");
    expect(urls).toContain("/start/install-with-an-agent/");
    expect(urls).toContain("/catalog/submit-with-an-agent/");
  });
});

describe("findBrokenLinks", () => {
  const targets: LinkTarget[] = [
    { slugs: [], headings: [] },
    { slugs: ["start", "install"], headings: ["requirements"] },
  ];
  const file = (content: string, path = "page.mdx"): FileObject => ({ path, content, url: "/" });

  it("accepts links to pages, anchors, Markdown files, and generated files", async () => {
    const content = [
      "[a](/start/install/) [b](/start/install) [c](/start/install/#requirements)",
      "[d](/start/install.md) [e](/llms.txt) [f](https://example.com/missing) [g](#top)",
      '<Card title="x" href="/start/install/" />',
    ].join("\n");
    expect(await findBrokenLinks([file(content)], targets)).toEqual([]);
  });

  it("accepts links to the catalog's pages, which have no Markdown file", async () => {
    const content = "[a](/apps/) [b](/apps/cut/) [c](/apps/cut) [d](/categories/email/)";
    const pages = ["/apps/", "/apps/cut/", "/categories/email/"];
    expect(await findBrokenLinks([file(content)], targets, pages)).toEqual([]);
    const broken = await findBrokenLinks(
      [file("[a](/apps/cut.md) [b](/apps/gone/)")],
      targets,
      pages,
    );
    expect(broken.map(({ url }) => url)).toEqual(["/apps/cut.md", "/apps/gone/"]);
  });

  it("reports a missing page, a missing heading, and a broken Card", async () => {
    const content = [
      "[a](/start/missing/)",
      "",
      "[b](/start/install/#no-such-heading)",
      "",
      '<Card title="x" href="/nowhere/" />',
    ].join("\n");
    const broken = await findBrokenLinks([file(content)], targets);
    expect(broken.map(({ url, line, reason }) => ({ url, line, reason }))).toEqual([
      { url: "/start/missing/", line: 1, reason: "not-found" },
      { url: "/start/install/#no-such-heading", line: 3, reason: "invalid-fragment" },
      { url: "/nowhere/", line: 5, reason: "not-found" },
    ]);
  });

  it("finds absolute URLs of the site that do not exist, in code blocks too", () => {
    const content = [
      "```text",
      "read https://docs.example/start/install.md and https://docs.example/llms.txt",
      "then https://docs.example/start/gone.md, https://docs.example/ and https://docs.example",
      "```",
    ].join("\n");
    const broken = findBrokenSiteUrls([file(content)], targets, "https://docs.example");
    expect(broken.map(({ url, line }) => ({ url, line }))).toEqual([
      { url: "https://docs.example/start/gone.md", line: 3 },
    ]);
  });

  it("parses .md files as Markdown, so angle brackets in prose are not JSX", async () => {
    const content = 'An app named "Appflare (<your hostname>)". [a](/start/missing/)';
    const broken = await findBrokenLinks([file(content, "page.md")], targets);
    expect(broken.map(({ url }) => url)).toEqual(["/start/missing/"]);
  });
});
