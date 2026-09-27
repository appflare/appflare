import {
  type ArtifactManifest,
  appServices,
  type CatalogManifest,
  combinedWorkerFacts,
  type IndexApp,
} from "@appflare/schema";
import type { AppLicense } from "./license";
import { type AppPrimitives, derivePrimitives, indexPrimitives } from "./primitives";

/**
 * What the catalog shows about an app beyond its name and summary: the
 * primitives it uses, its categories and its license. The catalog index
 * publishes them per app (`services`, `categories`, `license`); an index
 * written before it did leaves them to the app's manifests, and before a
 * manifest is read only the index's `requires` are known.
 */
export interface AppFacts {
  primitives: AppPrimitives;
  categories: string[];
  /** The license and its note; null until a row or manifest that states it is read. */
  appLicense: AppLicense | null;
}

type FactsRow = Pick<
  IndexApp,
  | "tier"
  | "requires"
  | "services"
  | "keyValueDurableObjects"
  | "categories"
  | "license"
  | "licenseNote"
>;

/** Whether `app`'s index row carries both facts, so no manifest is needed for them. */
export function indexHasFacts(app: Pick<IndexApp, "services" | "categories">): boolean {
  return app.services !== undefined && app.categories !== undefined;
}

/**
 * The facts of `app`: each from its index row when the row carries it,
 * otherwise from its catalog manifest and, for an artifact tier entry, the
 * signed artifact manifest (the same derivation the catalog runs), otherwise
 * from the row's `requires` alone. The sandbox and self-deploying tiers only
 * list what their catalog manifest names, since their bindings exist only
 * once they run.
 */
export function appFacts(
  app: FactsRow,
  manifests: { catalog: CatalogManifest; manifest: ArtifactManifest | null } | null,
): AppFacts {
  const fromIndex = indexPrimitives(app);
  return {
    primitives: fromIndex ?? manifestPrimitives(app, manifests),
    categories: app.categories ?? manifests?.catalog.categories ?? [],
    appLicense:
      app.license !== undefined
        ? { expression: app.license, note: app.licenseNote ?? null }
        : manifests != null
          ? { expression: manifests.catalog.license, note: manifests.catalog.licenseNote ?? null }
          : null,
  };
}

function manifestPrimitives(
  app: FactsRow,
  manifests: { catalog: CatalogManifest; manifest: ArtifactManifest | null } | null,
): AppPrimitives {
  if (manifests === null) return derivePrimitives({ requires: app.requires, complete: false });
  const { catalog, manifest } = manifests;
  const services = appServices(
    { ...catalog, requires: [...app.requires, ...catalog.requires] },
    manifest == null ? null : combinedWorkerFacts(manifest),
  );
  return { ...services, complete: app.tier === "artifact" && manifest !== null };
}
