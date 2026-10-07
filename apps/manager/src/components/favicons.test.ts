import { CLOUD_ORANGE } from "@appflare/brand/logo-paths";
import { describe, expect, it } from "vitest";
import logoSquare from "../../../../docs/assets/logo_square.svg?raw";
import favicon from "../../public/favicon.svg?raw";
import manifestText from "../../public/site.webmanifest?raw";
import { THEME_COLOR } from "./color-mode";
import { FAVICON_LINKS, FAVICON_META } from "./favicons";

/** The files in public/, by their URL path. */
const PUBLIC_FILES = new Set(
  Object.keys(import.meta.glob("../../public/*")).map((file) => file.slice("../../public".length)),
);

/** The `d` of every path in an SVG, in order, without the space after a leading `M`. */
function pathsOf(svg: string): string[] {
  return [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => (m[1] ?? "").replace(/^M /, "M"));
}

describe("favicons", () => {
  it("links the whole favicon set with the standard tags", () => {
    expect(FAVICON_LINKS).toEqual([
      { rel: "icon", type: "image/png", href: "/favicon-96x96.png", sizes: "96x96" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "shortcut icon", href: "/favicon.ico" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ]);
    expect(FAVICON_META).toEqual([{ name: "apple-mobile-web-app-title", content: "Appflare" }]);
  });

  it("links only files that are in public/", () => {
    for (const { href } of FAVICON_LINKS) expect(PUBLIC_FILES).toContain(href);
  });

  it("describes Appflare in the web app manifest, with icons that exist", () => {
    const manifest = JSON.parse(manifestText) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest).toMatchObject({
      name: "Appflare",
      short_name: "Appflare",
      start_url: "/",
      display: "standalone",
      theme_color: CLOUD_ORANGE,
      background_color: THEME_COLOR.light,
    });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons) expect(PUBLIC_FILES).toContain(icon.src);
  });

  it("draws the square logo in the SVG favicon, white in a dark browser theme", () => {
    const [light = "", dark = ""] = favicon.split('<g id="dark-icon">');
    const css = favicon.replace(/\s+/g, " ");
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) { #light-icon { display: none; } #dark-icon { display: inline; } }",
    );
    // Light: the four quadrants black, the cloud orange.
    expect(light.match(/fill="#000"/g)).toHaveLength(4);
    expect(light.toLowerCase()).toContain(`fill="${CLOUD_ORANGE}"`);
    // Dark: the logo's own paths, the quadrants white and the cloud still orange.
    expect(pathsOf(dark)).toEqual(pathsOf(logoSquare));
    expect(dark.replace(/\s+/g, " ")).toContain(".st0 { fill: #fff; }");
    expect(dark.replace(/\s+/g, " ")).toContain(`.st1 { fill: ${CLOUD_ORANGE}; }`);
  });
});
