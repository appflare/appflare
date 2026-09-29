import { describe, expect, it } from "vitest";
import { DOCS_URL } from "./components/auth-layout";
import { JOB_KINDS } from "./db/schema";
import { DOCS_TOPICS, type DocsTopic, docsUrl, jobFailureTopic } from "./docs-topics";

/**
 * The docs content, read at build time: each page's path on the site (its
 * file's path under content/docs without the extension, `index` being the
 * folder itself) and its raw Markdown.
 */
const files = import.meta.glob<string>("../../docs/content/docs/**/*.{md,mdx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const CONTENT_ROOT = "../../docs/content/docs/";
const pages = new Map(
  Object.entries(files).map(([file, raw]) => {
    const path = file
      .slice(CONTENT_ROOT.length)
      .replace(/\.mdx?$/, "")
      .replace(/(^|\/)index$/, "");
    return [path, raw] as const;
  }),
);

/** Heading text as the docs site's slugger (github-slugger) turns it into an id. */
function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, (c) => (c === "_" ? c : ""))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The ids of a page's headings, outside fenced code blocks, numbered on repeats. */
function headingIds(raw: string): string[] {
  const ids: string[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of raw.split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined) {
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const text = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (text === undefined) continue;
    const base = slug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.push(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

const topics = Object.keys(DOCS_TOPICS) as DocsTopic[];

describe("docs topics", () => {
  it("found the docs content", () => {
    expect(pages.has("start/overview")).toBe(true);
    expect(pages.has("guides/custom-domains")).toBe(true);
  });

  it("leads the Documentation links to a page of the docs, not the site's front page", () => {
    const path = new URL(DOCS_URL).pathname.replace(/^\/|\/$/g, "");
    expect(path).not.toBe("");
    expect([...pages.keys()]).toContain(path);
  });

  it.each(topics)("%s points at a page of the docs", (topic) => {
    const [path = ""] = DOCS_TOPICS[topic].split("#");
    expect([...pages.keys()]).toContain(path);
  });

  it.each(topics)("%s points at a heading of its page, when it names one", (topic) => {
    const [path = "", anchor] = DOCS_TOPICS[topic].split("#");
    if (anchor === undefined) return;
    expect(headingIds(pages.get(path) ?? "")).toContain(anchor);
  });

  it("turns headings into the ids the docs site gives them", () => {
    expect(headingIds("## 1. Connect Cloudflare\n## Turn off the workers.dev URL")).toEqual([
      "1-connect-cloudflare",
      "turn-off-the-workersdev-url",
    ]);
    expect(headingIds("```sh\n# not a heading\n```\n## `status`\n## Next\n## Next")).toEqual([
      "status",
      "next",
      "next-1",
    ]);
  });

  it("builds absolute URLs with the site's trailing slash", () => {
    expect(docsUrl("customDomains")).toBe("https://appflare.dev/guides/custom-domains/");
    expect(docsUrl("webhookSignature")).toBe(
      "https://appflare.dev/guides/notifications/#verify-the-signature",
    );
  });

  it("explains a failed job of every kind", () => {
    for (const kind of JOB_KINDS) expect(jobFailureTopic({ kind })).not.toBeNull();
    expect(jobFailureTopic({ kind: "rollback", restore: true })).toBe("databaseRestore");
    expect(jobFailureTopic({ kind: "uninstall", deleteRetained: true })).toBe("removedApps");
    expect(jobFailureTopic({ kind: "reconfigure" })).toBe("settingsChange");
    expect(jobFailureTopic({ kind: "move_address" })).toBe("appflareAddressMove");
  });
});
