import type { ArtifactManifest, CatalogManifest, IndexApp } from "@appflare/schema";
import { type AppPrimitives, derivePrimitives } from "./primitives";

/**
 * What the catalog shows about an app beyond its index row: the primitives it
 * uses and its categories. Both come from the app's manifests (the index
 * carries neither), so before a manifest is read only the index's `requires`
 * are known.
 */
export interface AppFacts {
  primitives: AppPrimitives;
  categories: string[];
}

/**
 * The facts of `app` from its catalog manifest and, for an artifact tier
 * entry, the signed artifact manifest; from the index row alone when neither
 * is known. The sandbox and self-deploying tiers only list what their
 * catalog manifest names, since their bindings exist only once they run.
 */
export function appFacts(
  app: Pick<IndexApp, "tier" | "requires">,
  manifests: { catalog: CatalogManifest; manifest: ArtifactManifest | null } | null,
): AppFacts {
  if (manifests === null) {
    return {
      primitives: derivePrimitives({ requires: app.requires, complete: false }),
      categories: [],
    };
  }
  const { catalog, manifest } = manifests;
  const worker = manifest?.worker;
  return {
    primitives: derivePrimitives({
      bindings: worker?.bindings ?? [],
      migrations: worker?.migrations ?? [],
      crons: worker?.crons ?? [],
      queueConsumers: worker?.queueConsumers ?? [],
      requires: [...app.requires, ...catalog.requires],
      tokenPermissions: catalog.tokenPermissions,
      emailRouting: catalog.install.emailRouting !== undefined,
      complete: app.tier === "artifact" && manifest !== null,
    }),
    categories: catalog.categories,
  };
}
