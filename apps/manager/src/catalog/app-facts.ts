import type { IndexApp } from "@appflare/schema";
import type { AppLicense } from "./license";
import { type AppPrimitives, derivePrimitives, indexPrimitives } from "./primitives";

/**
 * What the catalog shows about an app beyond its name and summary: the
 * primitives it uses, its categories and its license, as the catalog index
 * publishes them per app (`services`, `categories`, `license`,
 * `licenseNote`), so the list reads no manifest for them.
 */
export interface AppFacts {
  primitives: AppPrimitives;
  categories: string[];
  /** The license and its note; null where no app is shown. */
  appLicense: AppLicense | null;
}

type FactsRow = Pick<
  IndexApp,
  "tier" | "services" | "keyValueDurableObjects" | "categories" | "license" | "licenseNote"
>;

/** The facts of `app`, from its index row. */
export function appFacts(app: FactsRow): AppFacts {
  return {
    primitives: indexPrimitives(app),
    categories: [...app.categories],
    appLicense: { expression: app.license, note: app.licenseNote ?? null },
  };
}

/** The facts where no app is shown (a slug no catalog lists). */
export const NO_APP_FACTS: AppFacts = {
  primitives: derivePrimitives({ requires: [], complete: false }),
  categories: [],
  appLicense: null,
};
