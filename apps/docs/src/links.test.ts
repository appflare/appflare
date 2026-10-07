import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FileObject } from "next-validate-link";
import { beforeAll, describe, expect, it } from "vitest";
import { siteCatalog } from "./catalog/data.ts";
import { catalogPagePaths, handoffPagePaths } from "./catalog/urls.ts";
import { DEPLOY_PATH } from "./deploy/paths.ts";
import { AGENT_PROMPTS } from "./lib/agent-prompts.ts";
import {
  type BrokenLink,
  findBrokenLinks,
  findBrokenSiteUrls,
  type LinkTarget,
} from "./lib/links.ts";
import { pageUrl, SITE_URL } from "./lib/shared.ts";
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

/** The front page, the catalog's pages, the install pages and the deploy page, which content may link to. */
const catalogPages = [
  "/",
  DEPLOY_PATH,
  ...catalogPagePaths(siteCatalog),
  ...handoffPagePaths(siteCatalog),
];

/** The instructions the agent prompts point at, served as they are from `public/agent/`. */
function agentFiles(): FileObject[] {
  return Object.values(AGENT_PROMPTS).map(({ path: url }) => ({
    path: `public${url}`,
    content: readFileSync(new URL(`../public${url}`, import.meta.url), "utf8"),
    url,
  }));
}

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

  it("written as absolute URLs of this site, as in the agent instructions, exist", () => {
    const broken = findBrokenSiteUrls([...files, ...agentFiles()], targets, SITE_URL, catalogPages);
    expect(broken.map(({ file, line, url }) => `${file}:${line} ${url}`)).toEqual([]);
  });

  it("covers every page, including the generated manifest reference", () => {
    const urls = source.getPages().map((page) => pageUrl(page.slugs));
    expect(urls).toContain("/start/overview/");
    expect(urls).toContain("/catalog/manifest-reference/");
    expect(urls).toContain("/privacy/");
    // `/` is the front page, a route of its own, not a docs page.
    expect(urls).not.toContain("/");
  });
});

/**
 * The preview deploy's address, assembled so this file does not contain it.
 * Only the files that describe the preview may name it.
 */
const PREVIEW_ADDRESS = ["appflare-docs", "appflare-dev", "workers", "dev"].join(".");
const DESCRIBES_THE_PREVIEW = new Set([
  ".github/workflows/docs.yml",
  "apps/docs/README.md",
  // The deploy page signs in to Cloudflare there too: its OAuth callback is registered.
  "apps/docs/src/deploy/config.ts",
  // The hosted installer behind the preview answers for that origin.
  "apps/installer/wrangler.jsonc",
  "apps/installer/src/deploy/deploy.test.ts",
  // A manager installed from the preview reconnects Cloudflare through the preview's callback.
  "apps/manager/src/cloudflare/oauth-client.test.ts",
  "apps/manager/src/cloudflare/reconnect.server.test.ts",
  "docs/RELEASING.md",
]);
/** Files that are not text a person or a build reads as links. */
const NOT_TEXT =
  /(^|\/)pnpm-lock\.yaml$|\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|zip|gz|tgz|pdf|wasm)$/i;

describe("the preview deploy's address", () => {
  it("appears in no tracked file but those that describe the preview", () => {
    const run = (args: string[], cwd: string) =>
      execFileSync("git", args, { cwd, encoding: "utf8" });
    const root = run(["rev-parse", "--show-toplevel"], import.meta.dirname).trim();
    const tracked = run(["ls-files", "-z"], root)
      .split("\0")
      .filter((file) => file !== "" && !DESCRIBES_THE_PREVIEW.has(file) && !NOT_TEXT.test(file));
    const naming = tracked.filter((file) => {
      let text: string;
      try {
        text = readFileSync(path.join(root, file), "utf8");
      } catch {
        // Listed but deleted from the working tree and not yet staged.
        return false;
      }
      return !text.includes("\0") && text.includes(PREVIEW_ADDRESS);
    });
    expect(naming).toEqual([]);
    expect(tracked.length).toBeGreaterThan(100);
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
      "https://docs.example/start/install/?repo=owner/repo https://docs.example/gone/?x=1",
      "```",
    ].join("\n");
    const broken = findBrokenSiteUrls([file(content)], targets, "https://docs.example");
    expect(broken.map(({ url, line }) => ({ url, line }))).toEqual([
      { url: "https://docs.example/start/gone.md", line: 3 },
      { url: "https://docs.example/gone/?x=1", line: 4 },
    ]);
  });

  it("parses .md files as Markdown, so angle brackets in prose are not JSX", async () => {
    const content = 'An app named "Appflare (<your hostname>)". [a](/start/missing/)';
    const broken = await findBrokenLinks([file(content, "page.md")], targets);
    expect(broken.map(({ url }) => url)).toEqual(["/start/missing/"]);
  });
});
