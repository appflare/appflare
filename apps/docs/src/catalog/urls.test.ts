import { describe, expect, it } from "vitest";
import { catalogPagePaths, handoffPagePaths } from "./urls.ts";

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
