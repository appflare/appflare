import { describe, expect, it } from "vitest";
import { ogImagePaths } from "./og-images.ts";

const site = "https://docs.example";

describe("ogImagePaths", () => {
  it("finds the page's own OpenGraph image, whatever the attribute order", () => {
    const html = [
      `<meta property="og:image" content="${site}/og/start/install/image.png"/>`,
      `<meta content='${site}/og/image.png' property='og:image'>`,
    ].join("");
    expect(ogImagePaths(html, site)).toEqual(["/og/start/install/image.png", "/og/image.png"]);
  });

  it("ignores other tags and images on other sites", () => {
    const html = [
      `<meta property="og:title" content="${site}/og/x/image.png"/>`,
      `<meta name="twitter:image" content="${site}/og/y/image.png"/>`,
      `<meta property="og:image" content="https://elsewhere.example/og/z/image.png"/>`,
      `<meta property="og:image" content="${site}.evil/og/w/image.png"/>`,
    ].join("");
    expect(ogImagePaths(html, site)).toEqual([]);
  });
});
