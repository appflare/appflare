import { createHash } from "node:crypto";
import sharp from "sharp";
import { ICON_WIDTHS, type IconCopies, iconCopyPath } from "./icon-copies.ts";

/** The copies of the apps' icons, for the pages (`copies`) and for the build to write (`files`). */
export interface MadeIconCopies {
  copies: IconCopies;
  /** File contents by path under the site's root, without the leading `/`. */
  files: Map<string, Uint8Array>;
}

/** A transparent background, so an icon that is not square keeps its own shape. */
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Writes each icon (`icons`: bytes by catalog address) as a square WebP at
 * every width in {@link ICON_WIDTHS}. An SVG is drawn as a picture too: the
 * site never serves a catalog's SVG from its own address, where a script in
 * it would run as appflare.dev. An icon that cannot be read is left out, so
 * its page shows the catalog's address instead, and `warn` says so.
 */
export async function makeIconCopies(
  icons: ReadonlyMap<string, Uint8Array>,
  warn: (message: string) => void = console.warn,
): Promise<MadeIconCopies> {
  const copies: IconCopies = {};
  const files = new Map<string, Uint8Array>();
  for (const [url, bytes] of icons) {
    const name = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    try {
      const svg = new URL(url).pathname.endsWith(".svg");
      for (const width of ICON_WIDTHS) {
        const path = iconCopyPath(name, width).slice(1);
        if (!files.has(path)) files.set(path, await webp(bytes, width, svg));
      }
      copies[url] = name;
    } catch (error) {
      warn(`The icon at ${url} could not be copied, so the pages link it: ${String(error)}`);
    }
  }
  return { copies, files };
}

async function webp(bytes: Uint8Array, width: number, svg: boolean): Promise<Uint8Array> {
  // An SVG is drawn at a density that makes it at least `width` pixels on its
  // shorter side before it is resized, so a small viewBox is not blown up blurry.
  let density: number | undefined;
  if (svg) {
    const { width: w = 0, height: h = 0 } = await sharp(bytes).metadata();
    const shorter = Math.max(1, Math.min(w, h));
    density = Math.min(2400, Math.max(72, Math.ceil((72 * width) / shorter)));
  }
  const output = await sharp(bytes, density === undefined ? {} : { density })
    .resize(width, width, { fit: "contain", background: CLEAR })
    .webp({ quality: 85 })
    .toBuffer();
  return new Uint8Array(output);
}

/** The bytes in a `data:` URI (as the OpenGraph icons are kept), or null for anything else. */
export function dataUriBytes(uri: string): Uint8Array | null {
  const match = /^data:[^;,]+;base64,(.*)$/.exec(uri);
  return match?.[1] === undefined ? null : new Uint8Array(Buffer.from(match[1], "base64"));
}
