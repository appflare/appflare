import { type ArtifactManifest, appWorkers, entryScriptName } from "@appflare/schema";
import { workersDevBase } from "./workers-dev";

/**
 * The Workers of an app of several Workers other than the primary one, as
 * the app's page lists them: each one's installed name, and its workers.dev
 * URL unless its catalog entry keeps it off workers.dev, in which case the
 * page says it is not reachable from the internet. Client-safe (no bindings).
 */

/** One Worker of the app other than the primary one. */
export interface OtherWorkerView {
  /** Its name within the catalog entry (`install.workers[].name`). */
  name: string;
  /** The Worker name it is installed under. */
  workerName: string;
  /** Whether it answers on its workers.dev URL. */
  public: boolean;
  /** Its workers.dev URL; null when it is not public or the subdomain is unknown. */
  url: string | null;
}

/** What the page says of a Worker kept off workers.dev. */
export const NOT_REACHABLE_NOTE =
  "Not reachable from the internet; the app's other Workers reach it through their bindings.";

/**
 * The Workers of `manifest` other than the primary one, in the catalog
 * entry's order, installed under `installWorkerName`. Empty for an app of one
 * Worker.
 */
export function otherWorkerViews(
  manifest: ArtifactManifest,
  installWorkerName: string,
  subdomain: string | null,
): OtherWorkerView[] {
  return appWorkers(manifest).flatMap((w) => {
    if (w.primary || w.name === null) return [];
    const workerName = entryScriptName(installWorkerName, w.name, false);
    return [
      {
        name: w.name,
        workerName,
        public: w.workersDev,
        url: w.workersDev && subdomain ? workersDevBase(workerName, subdomain) : null,
      },
    ];
  });
}
