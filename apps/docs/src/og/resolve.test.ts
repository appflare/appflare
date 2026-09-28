import type { Root } from "fumadocs-core/page-tree";
import { describe, expect, it } from "vitest";
import type { SiteApp } from "../catalog/site-catalog.ts";
import { type CardSources, docsSection, ogCardFor, siteCard } from "./resolve.ts";

const tree: Root = {
  name: "Docs",
  children: [
    { type: "page", name: "Home", url: "/" },
    { type: "separator", name: "Getting started" },
    { type: "page", name: "Install Appflare", url: "/start/install" },
    {
      type: "folder",
      name: "Guides",
      children: [{ type: "page", name: "Updates", url: "/guides/updates" }],
    },
    { type: "separator", name: "More" },
    { type: "page", name: "FAQ", url: "/faq" },
  ],
};

function app(slug: string, name: string, categories: string[]): SiteApp {
  return { slug, name, pitch: `${name} pitch`, categories, popularity: null } as SiteApp;
}

const sources: CardSources = {
  page: (slugs) =>
    slugs.join("/") === "start/install"
      ? { title: "Install Appflare", description: "Three ways.", url: "/start/install" }
      : null,
  tree,
  catalog: {
    apps: [app("veet", "Veet", ["chat"]), app("mailflare", "mailflare", ["email", "chat"])],
    categories: [
      { id: "chat", label: "Chat", count: 2 },
      { id: "email", label: "Email", count: 1 },
    ],
  },
  icons: { veet: "data:image/png;base64,AA==" },
};

describe("docsSection", () => {
  it("names the heading a page is listed under, in folders too", () => {
    expect(docsSection(tree, "/start/install")).toBe("Getting started");
    expect(docsSection(tree, "/guides/updates")).toBe("Getting started");
  });

  it("is null before the first heading, under the catch-all heading, and for unknown pages", () => {
    expect(docsSection(tree, "/")).toBeNull();
    expect(docsSection(tree, "/faq")).toBeNull();
    expect(docsSection(tree, "/nowhere")).toBeNull();
  });
});

describe("ogCardFor", () => {
  it("draws the site's card for the front page", () => {
    expect(ogCardFor([], sources)).toEqual(siteCard);
  });

  it("draws a docs page with its section, title and description", () => {
    expect(ogCardFor(["start", "install"], sources)).toEqual({
      kind: "docs",
      section: "Getting started",
      title: "Install Appflare",
      description: "Three ways.",
      path: "/start/install/",
    });
  });

  it("draws an app with its icon and category names, or its letter without an icon", () => {
    expect(ogCardFor(["apps", "veet"], sources)).toEqual({
      kind: "app",
      app: { name: "Veet", pitch: "Veet pitch", icon: "data:image/png;base64,AA==" },
      categories: ["Chat"],
      path: "/apps/veet/",
    });
    expect(ogCardFor(["apps", "mailflare"], sources)).toMatchObject({
      kind: "app",
      app: { icon: null },
      categories: ["Email", "Chat"],
    });
  });

  it("draws an app's install page", () => {
    expect(ogCardFor(["install", "veet"], sources)).toMatchObject({
      kind: "install",
      app: { name: "Veet" },
      path: "/install/veet/",
    });
  });

  it("draws the apps page and a category with their apps, those with icons first", () => {
    const apps = ogCardFor(["apps"], sources);
    expect(apps).toMatchObject({ kind: "apps", title: "2 apps, ready to install", path: "/apps/" });
    const chat = ogCardFor(["categories", "chat"], sources);
    expect(chat).toMatchObject({ kind: "category", id: "chat", title: "Chat apps" });
    expect(chat?.kind === "category" && chat.apps.map((a) => a.name)).toEqual([
      "Veet",
      "mailflare",
    ]);
    expect(chat?.kind === "category" && chat.description).toMatch(/^2 apps /);
  });

  it("is null for anything else", () => {
    for (const slugs of [
      ["apps", "nope"],
      ["install", "nope"],
      ["install"],
      ["categories", "nope"],
      ["categories"],
      ["apps", "veet", "extra"],
      ["nowhere"],
    ]) {
      expect(ogCardFor(slugs, sources)).toBeNull();
    }
  });
});
