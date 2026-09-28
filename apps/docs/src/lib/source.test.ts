import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMDXComponents } from "../components/mdx.tsx";
import { source } from "./source.ts";

/** Any Markdown image whose address is on another site. */
const REMOTE_IMAGE = /!\[[^\]]*\]\(https?:\/\//;

describe("images on other sites", () => {
  // Compiling a page used to download each remote image to read its size.
  // Cloudflare's Deploy button is one, and a slow or failed download broke
  // the build, so a remote image is left as written: no width or height, as
  // only a download could have supplied them.
  it("are not downloaded for their size when a page is built", async () => {
    const remoteImages: string[] = [];
    for (const page of source.getPages()) {
      if (!REMOTE_IMAGE.test(await page.data.getText("raw"))) continue;
      const { body } = await page.data.load();
      const html = renderToStaticMarkup(createElement(body, { components: getMDXComponents() }));
      for (const [img] of html.matchAll(/<img\b[^>]*\bsrc="https?:\/\/[^>]*>/g)) {
        remoteImages.push(`${page.path}: ${img}`);
      }
    }

    // The Deploy button appears on several pages; the check must see them.
    expect(remoteImages.length).toBeGreaterThan(0);
    expect(remoteImages.filter((img) => /\b(width|height)=/.test(img))).toEqual([]);
  }, 120_000);
});
