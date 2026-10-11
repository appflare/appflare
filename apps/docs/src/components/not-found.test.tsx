import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissingApp } from "./not-found.tsx";

describe("the page for an app that is not in the catalog", () => {
  const html = renderToStaticMarkup(<MissingApp words="trading edge" />);

  it("offers to search the apps for the words of its address", () => {
    expect(html).toContain('href="/apps/?q=trading%20edge"');
    expect(html).toContain("Search apps for “trading edge”");
  });

  it("offers to ask for the app", () => {
    const suggest = /<a href="([^"]+)"[^>]*>Suggest an app<\/a>/.exec(html)?.[1] ?? "";
    const url = new URL(suggest.replaceAll("&amp;", "&"));
    expect(url.pathname).toBe("/appflare/catalog/issues/new");
    expect(url.searchParams.get("title")).toBe("App request: trading edge");
  });
});
