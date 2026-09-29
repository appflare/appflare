import { readdirSync, readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { type OgPicture, pngPicture } from "./picture.ts";

/**
 * The docs' own screenshots (`public/screenshots/*.png`) for the OpenGraph
 * cards, by the address the pages use for them (`/screenshots/home-dashboard.png`).
 * The cards are drawn during the build from these bytes, never fetched.
 */
export const DOCS_SCREENSHOTS_MODULE = "virtual:appflare-og-docs-screenshots";

const screenshotsDir = new URL("../../public/screenshots/", import.meta.url);

/** Every PNG in `public/screenshots/`, by its address on the site. */
export function readDocsScreenshots(dir: URL = screenshotsDir): Record<string, OgPicture> {
  const pictures: Record<string, OgPicture> = {};
  const names = readdirSync(dir)
    .filter((file) => file.endsWith(".png"))
    .sort();
  for (const name of names) {
    const picture = pngPicture(readFileSync(new URL(name, dir)));
    if (picture !== null) pictures[`/screenshots/${name}`] = picture;
  }
  return pictures;
}

/** Serves {@link readDocsScreenshots} as a virtual module, read when first imported. */
export function docsScreenshots(): Plugin {
  const id = `\0${DOCS_SCREENSHOTS_MODULE}`;
  return {
    name: "appflare-og-docs-screenshots",
    resolveId(source) {
      return source === DOCS_SCREENSHOTS_MODULE ? id : null;
    },
    load(source) {
      if (source !== id) return null;
      const json = JSON.stringify(JSON.stringify(readDocsScreenshots()));
      return `export default JSON.parse(${json});\n`;
    },
  };
}
