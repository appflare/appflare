import { staticClient } from "fumadocs-core/search/client/orama-static";
import { createSearchAPI } from "fumadocs-core/search/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "../catalog/test-app.ts";
import {
  appSearchIndexes,
  KEYWORDS_ANCHOR,
  SEARCH_INDEX_OPTIONS,
  searchKeywords,
  withoutKeywordLines,
} from "./site-search.ts";

const APPS = [
  testApp({
    slug: "nodewarden",
    name: "NodeWarden",
    pitch: "A password manager server for Bitwarden clients",
    summary: "Runs on Workers with D1 and R2.",
  }),
  testApp({
    slug: "2fa",
    name: "2FA",
    pitch: "Two-factor codes in your own account",
    summary: "Imports from Google Authenticator, Aegis and Bitwarden.",
  }),
  testApp({ slug: "open-seo", name: "OpenSEO", pitch: "SEO tools", summary: "Keyword research." }),
];

let index = 0;

/** The dialog's client over an index built as the site builds it, served from a stubbed fetch. */
async function dialogClient() {
  const api = createSearchAPI("advanced", {
    ...SEARCH_INDEX_OPTIONS,
    indexes: appSearchIndexes(APPS),
  });
  const exported = await (await api.staticGET()).text();
  // The client keeps each index it loaded by address: a new one per test.
  const from = `/api/search-${index++}.json`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe(from);
      return new Response(exported, { headers: { "content-type": "application/json" } });
    }),
  );
  return { client: withoutKeywordLines(staticClient({ from })), exported: JSON.parse(exported) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchKeywords", () => {
  it.each([
    [{ slug: "nodewarden", name: "NodeWarden" }, "nodewarden node warden"],
    [{ slug: "open-seo", name: "OpenSEO" }, "open-seo open seo openseo"],
    [{ slug: "2fa", name: "2FA" }, "2fa 2 fa"],
    [{ slug: "agentic-inbox", name: "Agentic Inbox" }, "agentic-inbox agentic inbox agenticinbox"],
    [{ slug: "cut", name: "Cut" }, "cut"],
  ])("finds %o by %s", (app, words) => {
    expect(searchKeywords(app)).toBe(words);
  });
});

describe("the search dialog", () => {
  it("finds an app by a part of its name", async () => {
    const { client } = await dialogClient();
    const results = await client.search("warden");
    expect(results.map((result) => result.url)).toContain("/apps/nodewarden/");
    expect(results.find((result) => result.type === "page")?.url).toBe("/apps/nodewarden/");
  });

  it("finds an app by its slug", async () => {
    const { client } = await dialogClient();
    const pages = (await client.search("open-seo")).filter((result) => result.type === "page");
    expect(pages.map((result) => result.url)).toEqual(["/apps/open-seo/"]);
  });

  it("never shows the line of keywords itself", async () => {
    const { client } = await dialogClient();
    for (const query of ["warden", "node", "nodewarden", "2fa", "seo"]) {
      const results = await client.search(query);
      expect(results.length, query).toBeGreaterThan(0);
      for (const result of results) expect(result.url).not.toContain(KEYWORDS_ANCHOR);
    }
  });

  it("still finds what the description and the summary say", async () => {
    const { client } = await dialogClient();
    const pages = (await client.search("bitwarden")).filter((result) => result.type === "page");
    expect(pages.map((result) => result.url).sort()).toEqual(["/apps/2fa/", "/apps/nodewarden/"]);
  });

  it("is built without the search engine's sort data", async () => {
    const { exported } = await dialogClient();
    expect(exported.sorting).toEqual({ enabled: false });
  });
});
