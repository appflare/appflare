/**
 * The site's own copies of the apps' icons. The catalog publishes each icon
 * as it came (often a 512 px PNG, or an SVG) on GitHub Pages, which allows a
 * browser to keep it for ten minutes. A build from the published catalog
 * (`CATALOG_SNAPSHOT=live`) writes each icon again as small WebP files under
 * `/assets/icons/`, named by their content so they can be cached for good
 * (`_headers`), and the pages show those. A build from the checked-in fixture
 * makes none, and the pages show the catalog's own address.
 *
 * This file is read in the browser too; the copies are made in
 * `make-icon-copies.ts`, which runs only during the build.
 */

/**
 * The widths each icon is written at. Icons are shown 36 to 88 px wide; the
 * browser picks the copy that fits the size and the screen's density.
 */
export const ICON_WIDTHS = [64, 128, 192] as const;

/** Each icon's catalog address, mapped to the name its copies share (a digest of its bytes). */
export type IconCopies = Record<string, string>;

/** Where the copy of `name` at `width` is served: `/assets/icons/<name>-<width>.webp`. */
export function iconCopyPath(name: string, width: number): string {
  return `/assets/icons/${name}-${width}.webp`;
}

/** The `<img>` attributes for an icon shown `size` px wide: its copies when the build made them, else the catalog's address. */
export function iconImage(
  src: string,
  size: number,
  copies: IconCopies,
): { src: string; srcSet?: string; sizes?: string } {
  const name = copies[src];
  if (name === undefined) return { src };
  return {
    src: iconCopyPath(name, 128),
    srcSet: ICON_WIDTHS.map((width) => `${iconCopyPath(name, width)} ${width}w`).join(", "),
    sizes: `${size}px`,
  };
}
