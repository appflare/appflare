import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { fetchCatalogSnapshot } from "./fetch-snapshot.ts";
import { type SiteCatalog, siteCatalog } from "./site-catalog.ts";
import { parseCatalogSnapshot } from "./snapshot.ts";

/**
 * Where the catalog pages get their data. `CATALOG_SNAPSHOT=live` (the
 * deploy workflow sets it) fetches the published catalog when Vite starts;
 * otherwise the site is built from a small snapshot checked in next to this
 * file, so tests and ordinary builds never touch the network. Either way the
 * snapshot is checked before any page is made, and a failed fetch or check
 * fails the build.
 */

export type SnapshotMode = "live" | "fixture";

/** The checked-in snapshot: a few real apps, taken from the live catalog. */
export const fixtureUrl = new URL("./fixture.json", import.meta.url);

/** The data source `CATALOG_SNAPSHOT` asks for; anything but `live`, `fixture` or unset is refused. */
export function snapshotMode(value: string | undefined): SnapshotMode {
  if (value === undefined || value === "" || value === "fixture") return "fixture";
  if (value === "live") return "live";
  throw new Error(`CATALOG_SNAPSHOT must be "live" or "fixture", not "${value}"`);
}

export interface LoadedCatalog {
  mode: SnapshotMode;
  site: SiteCatalog;
  /** Icons drawn into the apps' OpenGraph cards, by slug; empty for the fixture. */
  ogIcons: Record<string, string>;
}

/**
 * One load per process. A build reads the Vite config several times (the
 * build itself, then the preview servers that prerender the pages and draw
 * their images), each time as a fresh module, so the catalog is kept on
 * `globalThis`: fetched once, and every page and image drawn from the same data.
 */
const loaded = Symbol.for("appflare.docs.catalog");
type LoadCache = Partial<Record<SnapshotMode, Promise<LoadedCatalog>>>;

export function loadCatalog(mode: SnapshotMode): Promise<LoadedCatalog> {
  const store = globalThis as { [loaded]?: LoadCache };
  store[loaded] ??= {};
  const cache = store[loaded];
  const pending = cache[mode] ?? readCatalog(mode);
  cache[mode] = pending;
  // A failed load is not kept, so a later build in the same process tries again.
  pending.catch(() => {
    if (cache[mode] === pending) delete cache[mode];
  });
  return pending;
}

async function readCatalog(mode: SnapshotMode): Promise<LoadedCatalog> {
  if (mode === "live") {
    const { snapshot, ogIcons } = await fetchCatalogSnapshot();
    return { mode, site: siteCatalog(snapshot), ogIcons };
  }
  const fixture: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const snapshot = parseCatalogSnapshot(fixture, "the checked-in fixture");
  return { mode, site: siteCatalog(snapshot), ogIcons: {} };
}

/** The catalog, as the pages import it. */
export const CATALOG_MODULE = "virtual:appflare-catalog";
/** The OpenGraph icons, imported only by the route that draws the cards. */
export const OG_ICONS_MODULE = "virtual:appflare-catalog-og-icons";

/** A module whose default export is `value`, parsed from JSON (faster than an object literal). */
function jsonModule(value: unknown): string {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(value))});\n`;
}

/** Serves the loaded catalog to the pages as two virtual modules. */
export function catalogData(catalog: LoadedCatalog): Plugin {
  const modules = new Map<string, string>([
    [`\0${CATALOG_MODULE}`, jsonModule(catalog.site)],
    [`\0${OG_ICONS_MODULE}`, jsonModule(catalog.ogIcons)],
  ]);
  return {
    name: "appflare-catalog-data",
    enforce: "pre",
    configResolved(config) {
      const { apps, categories } = catalog.site;
      config.logger.info(
        `Catalog: ${apps.length} apps in ${categories.length} categories, from ${
          catalog.mode === "live" ? "the published catalog" : "the checked-in fixture"
        }`,
      );
    },
    resolveId(id) {
      if (id === CATALOG_MODULE || id === OG_ICONS_MODULE) return `\0${id}`;
      return null;
    },
    load(id) {
      return modules.get(id) ?? null;
    },
  };
}
