import { describe, expect, it } from "vitest";
import {
  appsSearchPath,
  catalogPagePaths,
  handoffPagePaths,
  missingAppWords,
  suggestAppUrl,
} from "./urls.ts";

describe("handoffPagePaths", () => {
  const catalog = { apps: [{ slug: "2fa" }, { slug: "veet" }], categories: [{ id: "security" }] };

  it("lists an install page per app, the repository install page and /my/", () => {
    expect(handoffPagePaths(catalog)).toEqual([
      "/install/",
      "/install/2fa/",
      "/install/veet/",
      "/my/",
    ]);
  });

  it("is kept apart from the pages the sitemap, llms.txt and search list", () => {
    const listed = new Set(catalogPagePaths(catalog));
    expect(handoffPagePaths(catalog).filter((path) => listed.has(path))).toEqual([]);
  });
});

describe("missingAppWords", () => {
  it.each([
    ["/apps/tradingedge/", "tradingedge"],
    ["/apps/trading-edge/", "trading edge"],
    ["/apps/trading-edge", "trading edge"],
    ["/apps/Karakeep_App/", "Karakeep App"],
    ["/apps/caf%C3%A9-notes/", "café notes"],
  ])("turns %s into a search for %s", (path, words) => {
    expect(missingAppWords(path)).toBe(words);
  });

  it.each([
    "/apps/",
    "/apps/glance/screenshots/",
    "/start/nothing/",
    "/categories/ai/",
    "/apps/%E0%A4%A/",
    "/apps/---/",
  ])("has nothing to search for at %s", (path) => {
    expect(missingAppWords(path)).toBeNull();
  });

  it("keeps the search short", () => {
    expect(missingAppWords(`/apps/${"a".repeat(500)}/`)?.length).toBe(60);
  });
});

describe("appsSearchPath", () => {
  it("puts the words in the apps page's search field", () => {
    expect(appsSearchPath("trading edge")).toBe("/apps/?q=trading%20edge");
  });
});

describe("suggestAppUrl", () => {
  it("opens a new issue on the catalog's repository, titled with the app", () => {
    const url = new URL(suggestAppUrl(" karakeep "));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/appflare/catalog/issues/new");
    expect(url.searchParams.get("title")).toBe("App request: karakeep");
    expect(url.searchParams.get("body")).toContain("repository");
  });

  it("leaves the name to fill in when there is none", () => {
    expect(new URL(suggestAppUrl()).searchParams.get("title")).toBe("App request: ");
  });
});
