import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ICON_WIDTHS, iconImage } from "./icon-copies.ts";
import { dataUriBytes, makeIconCopies } from "./make-icon-copies.ts";

const PNG_URL = "https://appflare.github.io/catalog/apps/big/icon.png";
const SVG_URL = "https://appflare.github.io/catalog/apps/vector/icon.svg";

async function png(size: number): Promise<Uint8Array> {
  const image = sharp({
    create: { width: size, height: size, channels: 4, background: "#fb6b00" },
  });
  return new Uint8Array(await image.png().toBuffer());
}

const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><script>alert(1)</script><circle cx="12" cy="12" r="10" fill="#fb6b00"/></svg>',
);

describe("the icon copies", () => {
  it("writes each icon as a square WebP at every width, named by its bytes", async () => {
    const { copies, files } = await makeIconCopies(new Map([[PNG_URL, await png(512)]]));
    const name = copies[PNG_URL];
    expect(name).toMatch(/^[0-9a-f]{16}$/);
    expect([...files.keys()].sort()).toEqual(
      ICON_WIDTHS.map((width) => `assets/icons/${name}-${width}.webp`).sort(),
    );
    for (const width of ICON_WIDTHS) {
      const file = files.get(`assets/icons/${name}-${width}.webp`);
      const meta = await sharp(file).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", width, width]);
    }
  });

  it("draws an SVG as a picture, sharp at the largest width, so no SVG is served from the site", async () => {
    const { copies, files } = await makeIconCopies(new Map([[SVG_URL, svg]]));
    const largest = files.get(`assets/icons/${copies[SVG_URL]}-192.webp`);
    const meta = await sharp(largest).metadata();
    expect([meta.format, meta.width]).toEqual(["webp", 192]);
    for (const path of files.keys()) expect(path).toMatch(/\.webp$/);
  });

  it("leaves out an icon it cannot read, so the page links the catalog's", async () => {
    const warnings: string[] = [];
    const broken = new TextEncoder().encode("not an image");
    const { copies, files } = await makeIconCopies(new Map([[PNG_URL, broken]]), (message) =>
      warnings.push(message),
    );
    expect(copies).toEqual({});
    expect(files.size).toBe(0);
    expect(warnings).toEqual([expect.stringContaining(PNG_URL)]);
  });

  it("reads the bytes of the OpenGraph icons' data URIs", () => {
    expect(dataUriBytes("data:image/png;base64,AAEC")).toEqual(new Uint8Array([0, 1, 2]));
    expect(dataUriBytes(PNG_URL)).toBeNull();
  });
});

describe("an icon's <img> attributes", () => {
  it("offers the copies, sized as the icon is shown", () => {
    expect(iconImage(PNG_URL, 56, { [PNG_URL]: "abc" })).toEqual({
      src: "/assets/icons/abc-128.webp",
      srcSet:
        "/assets/icons/abc-64.webp 64w, /assets/icons/abc-128.webp 128w, /assets/icons/abc-192.webp 192w",
      sizes: "56px",
    });
  });

  it("links the catalog's own icon when the build made no copy", () => {
    expect(iconImage(PNG_URL, 56, {})).toEqual({ src: PNG_URL });
  });
});
