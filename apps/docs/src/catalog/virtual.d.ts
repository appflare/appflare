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
