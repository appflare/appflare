import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { faviconLinks } from "./favicons.ts";

const publicDir = new URL("../../public/", import.meta.url);
const publicFiles = new Set(readdirSync(publicDir).map((file) => `/${file}`));

describe("favicons", () => {
  it("links only files that are in public/", () => {
    for (const { href } of faviconLinks) expect(publicFiles).toContain(href);
  });

  it("names the docs in the web app manifest, with icons that exist", () => {
    const manifest = JSON.parse(readFileSync(new URL("site.webmanifest", publicDir), "utf8")) as {
      name: string;
      start_url: string;
      display: string;
      icons: { src: string }[];
    };
    expect(manifest).toMatchObject({
      name: "Appflare docs",
      start_url: "/",
      display: "standalone",
    });
    for (const icon of manifest.icons) expect(publicFiles).toContain(icon.src);
  });

  it("switches the SVG favicon to its white mark in a dark browser theme", () => {
    const svg = readFileSync(new URL("favicon.svg", publicDir), "utf8").replace(/\s+/g, " ");
    expect(svg).toContain(
      "@media (prefers-color-scheme: dark) { #light-icon { display: none; } #dark-icon { display: inline; } }",
    );
  });
});
