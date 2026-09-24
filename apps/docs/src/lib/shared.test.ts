import { describe, expect, it } from "vitest";
import {
  markdownUrl,
  ogImagePath,
  pageUrl,
  slugsFromMarkdownPath,
  slugsFromOgImagePath,
  slugsFromSplat,
  sourceFileUrl,
} from "./shared.ts";

describe("page URLs", () => {
  it("end in a slash, as the prerendered `<path>/index.html` files are served", () => {
    expect(pageUrl([])).toBe("/");
    expect(pageUrl(["start", "install"])).toBe("/start/install/");
  });

  it("read splat parameters with or without the trailing slash", () => {
    expect(slugsFromSplat(undefined)).toEqual([]);
    expect(slugsFromSplat("")).toEqual([]);
    expect(slugsFromSplat("start/install/")).toEqual(["start", "install"]);
    expect(slugsFromSplat("faq")).toEqual(["faq"]);
  });
});

describe("Markdown URLs", () => {
  it("add .md to the page path, and name the home page index.md", () => {
    expect(markdownUrl([])).toBe("/index.md");
    expect(markdownUrl(["faq"])).toBe("/faq.md");
    expect(markdownUrl(["start", "install"])).toBe("/start/install.md");
  });

  it("map back to the page's slugs", () => {
    for (const slugs of [[], ["faq"], ["start", "install"]]) {
      expect(slugsFromMarkdownPath(markdownUrl(slugs))).toEqual(slugs);
    }
  });
});

describe("OpenGraph image paths", () => {
  it("put image.png under /og/ and the page path", () => {
    expect(ogImagePath([])).toBe("/og/image.png");
    expect(ogImagePath(["guides", "cli"])).toBe("/og/guides/cli/image.png");
  });

  it("map back to the page's slugs, and reject anything else", () => {
    expect(slugsFromOgImagePath("guides/cli/image.png")).toEqual(["guides", "cli"]);
    expect(slugsFromOgImagePath("image.png")).toEqual([]);
    expect(slugsFromOgImagePath("guides/cli/other.png")).toBeUndefined();
  });
});

describe("sourceFileUrl", () => {
  it("links a content file on GitHub", () => {
    expect(sourceFileUrl("start/install.mdx")).toBe(
      "https://github.com/appflare/appflare/blob/main/apps/docs/content/docs/start/install.mdx",
    );
  });
});
