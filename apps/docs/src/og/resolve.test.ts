import type { Root } from "fumadocs-core/page-tree";
import { describe, expect, it } from "vitest";
import type { SiteApp } from "../catalog/site-catalog.ts";
import type { OgPicture } from "./picture.ts";
import {
  type CardSources,
  docsSection,
  firstScreenshot,
  ogCardFor,
  siteCardText,
} from "./resolve.ts";

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

const picture = (name: string): OgPicture => ({ src: `data:${name}`, width: 2352, height: 1384 });
const dashboard = picture("dashboard");
const users = picture("users");
const veetShot = picture("veet");

const sources: CardSources = {
  page: (slugs) => {
    const path = slugs.join("/");
    if (path === "start/install") {
      return {
        title: "Install Appflare",
        description: "Three ways.",
        url: "/start/install",
        screenshot: "/screenshots/users-list.png",
      };
    }
    if (path === "faq") return { title: "FAQ", url: "/faq", screenshot: null };
    return null;
  },
  tree,
  catalog: {
    apps: [app("veet", "Veet", ["chat"]), app("mailflare", "mailflare", ["email", "chat"])],
    categories: [
      { id: "chat", label: "Chat", count: 2 },
      { id: "email", label: "Email", count: 1 },
    ],
  },
  icons: { veet: "data:image/png;base64,AA==" },
  appScreenshots: { veet: veetShot },
  docsScreenshots: {
    "/screenshots/home-dashboard.png": dashboard,
    "/screenshots/users-list.png": users,
  },
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

describe("firstScreenshot", () => {
  it("finds the first of the docs' screenshots a page shows", () => {
    const markdown = [
      "Intro with a [link](/start/install).",
      "![Deploy](https://deploy.workers.cloudflare.com/button)",
      "![Users list](/screenshots/users-list.png)",
      "![Passkeys](/screenshots/users-passkeys.png)",
    ].join("\n\n");
    expect(firstScreenshot(markdown)).toBe("/screenshots/users-list.png");
    expect(firstScreenshot('<img src="/screenshots/a-b.png" alt="" />')).toBe(
      "/screenshots/a-b.png",
    );
    expect(firstScreenshot("No pictures here.")).toBeNull();
  });
});

describe("ogCardFor", () => {
  it("draws the site's card for the front page, with the manager's Home", () => {
    expect(ogCardFor([], sources)).toEqual({ kind: "site", ...siteCardText, dashboard });
  });

  it("draws a docs page with its section, title, description and first screenshot", () => {
    expect(ogCardFor(["start", "install"], sources)).toEqual({
      kind: "docs",
      section: "Getting started",
      title: "Install Appflare",
      description: "Three ways.",
      path: "/start/install/",
      screenshot: { path: "/screenshots/users-list.png", picture: users },
    });
  });

  it("draws the manager's Home for a docs page without a screenshot", () => {
    expect(ogCardFor(["faq"], sources)).toMatchObject({
      kind: "docs",
      screenshot: { path: "/screenshots/home-dashboard.png", picture: dashboard },
    });
    const bare = { ...sources, docsScreenshots: {} };
    expect(ogCardFor(["faq"], bare)).toMatchObject({ kind: "docs", screenshot: null });
    expect(ogCardFor([], bare)).toMatchObject({ kind: "site", dashboard: null });
  });

  it("draws an app with its icon, category names and first screenshot", () => {
    expect(ogCardFor(["apps", "veet"], sources)).toEqual({
      kind: "app",
      app: { name: "Veet", pitch: "Veet pitch", icon: "data:image/png;base64,AA==" },
      categories: ["Chat"],
      path: "/apps/veet/",
      screenshot: veetShot,
    });
    expect(ogCardFor(["apps", "mailflare"], sources)).toMatchObject({
      kind: "app",
      app: { icon: null },
      categories: ["Email", "Chat"],
      screenshot: null,
    });
  });

  it("draws an app's install page", () => {
    expect(ogCardFor(["install", "veet"], sources)).toMatchObject({
      kind: "install",
      app: { name: "Veet" },
      path: "/install/veet/",
      screenshot: veetShot,
    });
  });

  it("draws the apps page and a category with their apps, those with icons first", () => {
    const apps = ogCardFor(["apps"], sources);
    expect(apps).toMatchObject({
      kind: "apps",
      title: "2 apps for your Cloudflare account",
      path: "/apps/",
    });
    const chat = ogCardFor(["categories", "chat"], sources);
    expect(chat).toMatchObject({ kind: "category", title: "Chat", path: "/categories/chat/" });
    expect(chat?.kind === "category" && chat.apps.map((a) => a.name)).toEqual([
      "Veet",
      "mailflare",
    ]);
    expect(chat?.kind === "category" && chat.description).toMatch(/^2 apps /);
    const email = ogCardFor(["categories", "email"], sources);
    expect(email?.kind === "category" && email.description).toMatch(/^1 app /);
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
