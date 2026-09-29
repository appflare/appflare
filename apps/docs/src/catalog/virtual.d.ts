// The modules the catalog data plugin (plugin.ts) serves.

declare module "virtual:appflare-catalog" {
  const catalog: import("./site-catalog.ts").SiteCatalog;
  export default catalog;
}

declare module "virtual:appflare-catalog-og-icons" {
  /** Data URIs of app icons, by slug. */
  const icons: Record<string, string>;
  export default icons;
}

declare module "virtual:appflare-catalog-og-screenshots" {
  /** Each app's first screenshot, by slug. */
  const screenshots: Record<string, import("../og/picture.ts").OgPicture>;
  export default screenshots;
}

// Served by the docs screenshots plugin (og/plugin.ts).
declare module "virtual:appflare-og-docs-screenshots" {
  /** The docs' screenshots, by their address on the site (`/screenshots/<name>.png`). */
  const screenshots: Record<string, import("../og/picture.ts").OgPicture>;
  export default screenshots;
}
