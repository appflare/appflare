import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { scopeExamples } from "../deploy/scope-examples.ts";
import type { OgPicture } from "../og/picture.ts";
import { fetchCatalogSnapshot } from "./fetch-snapshot.ts";
import type { IconCopies } from "./icon-copies.ts";
import { dataUriBytes, makeIconCopies } from "./make-icon-copies.ts";
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
  /** Each app's first screenshot for its OpenGraph cards, by slug; empty for the fixture. */
  ogScreenshots: Record<string, OgPicture>;
  /** The site's own copies of the icons (`icon-copies.ts`), by catalog address; empty for the fixture. */
  iconCopies: IconCopies;
  /** Those copies' files, by path under the site's root. */
  iconFiles: Map<string, Uint8Array>;
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
    const { snapshot, ogIcons, ogScreenshots } = await fetchCatalogSnapshot();
    const site = siteCatalog(snapshot);
    // The icons were fetched (and checked against the catalog's digests) for
    // the OpenGraph cards; the site's own copies are made from the same bytes.
    const icons = new Map<string, Uint8Array>();
    for (const app of site.apps) {
      const uri = ogIcons[app.slug];
      const bytes = uri === undefined ? null : dataUriBytes(uri);
      if (app.icon !== null && bytes !== null) icons.set(app.icon, bytes);
    }
    const { copies, files } = await makeIconCopies(icons);
    return { mode, site, ogIcons, ogScreenshots, iconCopies: copies, iconFiles: files };
  }
  const fixture: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const snapshot = parseCatalogSnapshot(fixture, "the checked-in fixture");
  return {
    mode,
    site: siteCatalog(snapshot),
    ogIcons: {},
    ogScreenshots: {},
    iconCopies: {},
    iconFiles: new Map(),
  };
}

/** The catalog, as the pages import it. */
export const CATALOG_MODULE = "virtual:appflare-catalog";
/** The OpenGraph icons, imported only by the route that draws the cards. */
export const OG_ICONS_MODULE = "virtual:appflare-catalog-og-icons";
/** The apps' first screenshots for the OpenGraph cards, imported by the same route. */
export const OG_SCREENSHOTS_MODULE = "virtual:appflare-catalog-og-screenshots";

/** The site's own copies of the icons, imported by the icon component. */
export const ICON_COPIES_MODULE = "virtual:appflare-icon-copies";

/**
 * The apps the deploy page names as examples of each permission it asks
 * for, worked out from the catalog (`deploy/scope-examples.ts`), so the
 * page carries a few names and not the whole catalog.
 */
export const SCOPE_EXAMPLES_MODULE = "virtual:appflare-scope-examples";

/** A module whose default export is `value`, parsed from JSON (faster than an object literal). */
function jsonModule(value: unknown): string {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(value))});\n`;
}

/** Serves the loaded catalog to the pages as virtual modules, each made when first loaded. */
export function catalogData(catalog: LoadedCatalog): Plugin {
  const modules = new Map<string, unknown>([
    [`\0${CATALOG_MODULE}`, catalog.site],
    [`\0${OG_ICONS_MODULE}`, catalog.ogIcons],
    [`\0${OG_SCREENSHOTS_MODULE}`, catalog.ogScreenshots],
    [`\0${SCOPE_EXAMPLES_MODULE}`, scopeExamples(catalog.site.apps)],
    [`\0${ICON_COPIES_MODULE}`, catalog.iconCopies],
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
      return modules.has(`\0${id}`) ? `\0${id}` : null;
    },
    load(id) {
      return modules.has(id) ? jsonModule(modules.get(id)) : null;
    },
    // The icon copies are written with the browser's files, and served as they are while developing.
    generateBundle() {
      if (this.environment.name !== "client") return;
      for (const [fileName, source] of catalog.iconFiles) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = catalog.iconFiles.get((request.url ?? "").slice(1));
        if (file === undefined) return next();
        response.setHeader("Content-Type", "image/webp");
        response.end(file);
      });
    },
  };
}
