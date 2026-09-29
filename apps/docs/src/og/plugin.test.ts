import screenshots from "virtual:appflare-og-docs-screenshots";
import { describe, expect, it } from "vitest";
import { readDocsScreenshots } from "./plugin.ts";

describe("the docs' screenshots for the cards", () => {
  it("are every PNG in public/screenshots, by address, with its size", () => {
    const pictures = readDocsScreenshots();
    expect(pictures["/screenshots/home-dashboard.png"]).toMatchObject({
      width: 2352,
      height: 1384,
    });
    for (const [path, picture] of Object.entries(pictures)) {
      expect(path).toMatch(/^\/screenshots\/[\w.-]+\.png$/);
      expect(picture.src).toMatch(/^data:image\/png;base64,/);
      expect(picture.width).toBeGreaterThan(0);
    }
  });

  it("are served to the route as a module", () => {
    expect(Object.keys(screenshots)).toEqual(Object.keys(readDocsScreenshots()));
  });
});
