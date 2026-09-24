import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regenerates the favicons and touch icon from the square logo in
 * docs/assets (the source of every logo file in the repository):
 *
 *   pnpm icons
 *
 * - apps/manager/public/favicon.svg and apps/docs/public/favicon.svg: the
 *   square logo, black in a light browser theme and white in a dark one (the
 *   cloud stays orange);
 * - apps/manager/public/favicon-32.png: 32x32 on a white rounded square (so
 *   it shows in dark tabs), for browsers without SVG favicons;
 * - apps/manager/public/apple-touch-icon.png: 180x180 on white, because iOS
 *   fills a transparent touch icon with black.
 *
 * The PNGs are drawn by ImageMagick 7 (`magick`, with its librsvg delegate),
 * which must be on the PATH. Run it again whenever docs/assets/logo_square.svg
 * changes, and commit what it writes.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (...parts: string[]) => path.join(root, ...parts);

const SQUARE = at("docs/assets/logo_square.svg");
/** The logo's dark parts; the colour files draw them in one group. */
const INK_GROUP = '<g fill="#000">';

/** The square logo with its dark parts following the browser's colour scheme. */
function adaptiveFavicon(squareSvg: string): string {
  if (!squareSvg.includes(INK_GROUP)) {
    throw new Error(`${SQUARE} has no ${INK_GROUP} group for the logo's dark parts.`);
  }
  const style =
    "<title>Appflare</title><style>.ink{fill:#000}@media (prefers-color-scheme:dark){.ink{fill:#fff}}</style>";
  return squareSvg
    .replace(/ role="img" aria-label="Appflare"/, "")
    .replace(/(<svg[^>]*>)/, `$1${style}`)
    .replace(INK_GROUP, '<g class="ink">');
}

function magick(args: string[]): void {
  const result = spawnSync("magick", args, { stdio: "inherit" });
  if (result.error !== undefined) {
    throw new Error(`Could not run ImageMagick (magick): ${result.error.message}`);
  }
  if (result.status !== 0) throw new Error(`magick exited with ${result.status}`);
}

function main(): void {
  const favicon = adaptiveFavicon(readFileSync(SQUARE, "utf8"));
  for (const target of ["apps/manager/public/favicon.svg", "apps/docs/public/favicon.svg"]) {
    writeFileSync(at(target), favicon);
    console.log(`wrote ${target}`);
  }
  // The logo at 26 px on a white rounded square, so it stays visible in a dark
  // tab strip. A high density first, so the downscale is sharp; -strip and no
  // date chunks keep the file the same on every run.
  magick([
    "-size",
    "32x32",
    "xc:none",
    "-fill",
    "white",
    "-draw",
    "roundrectangle 0,0 31,31 6,6",
    "(",
    "-background",
    "none",
    "-density",
    "1200",
    SQUARE,
    "-resize",
    "26x26",
    ")",
    "-gravity",
    "center",
    "-composite",
    "-strip",
    "-define",
    "png:exclude-chunks=date,time",
    `PNG32:${at("apps/manager/public/favicon-32.png")}`,
  ]);
  console.log("wrote apps/manager/public/favicon-32.png");
  // The logo at 144 px in a 180 px white square: the margin iOS's rounded mask needs.
  magick([
    "-background",
    "white",
    "-density",
    "1200",
    SQUARE,
    "-resize",
    "144x144",
    "-gravity",
    "center",
    "-extent",
    "180x180",
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-strip",
    "-define",
    "png:exclude-chunks=date,time",
    `PNG24:${at("apps/manager/public/apple-touch-icon.png")}`,
  ]);
  console.log("wrote apps/manager/public/apple-touch-icon.png");
}

main();
