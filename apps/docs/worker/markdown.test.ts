import { describe, expect, it } from "vitest";
import { markdownPath, prefersMarkdown } from "./markdown.ts";

describe("prefersMarkdown", () => {
  it("is true when Markdown is named and HTML is not preferred over it", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.5")).toBe(true);
    expect(prefersMarkdown("text/html;q=0.9, text/markdown")).toBe(true);
  });

  it("is false for a browser, for no header, and for Markdown refused or ranked below HTML", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
    expect(prefersMarkdown("text/html, text/markdown;q=0.5")).toBe(false);
  });
});

describe("markdownPath", () => {
  it("is llms.txt for the front page and the .md beside any other page", () => {
    expect(markdownPath("/")).toBe("/llms.txt");
    expect(markdownPath("/start/install/")).toBe("/start/install.md");
    expect(markdownPath("/start/install")).toBe("/start/install.md");
  });

  it("is null for a file", () => {
    expect(markdownPath("/robots.txt")).toBeNull();
    expect(markdownPath("/start/install.md")).toBeNull();
  });
});
