import {
  MANAGER_SCOPE_REASONS,
  type RequestedGroupKey,
  type ScopeReason,
} from "@appflare/cf-api/scope-reasons";

/**
 * The apps the deploy page names as examples of why a permission is asked
 * for, worked out when the site is built from the catalog it is built with.
 * An app is an example of a permission only when the catalog says it uses
 * the reason's service (`services`, which the catalog works out from the
 * app's release and manifest), so every name shown is true of that release.
 */

/** Example app names by permission group; a group without examples is absent. */
export type ScopeExamples = Partial<Record<RequestedGroupKey, string[]>>;

/** What an app needs here: its name, what it uses, and what makes it a good example. */
export interface ExampleCandidate {
  name: string;
  services: readonly string[];
  icon: string | null;
  addedAt: string;
  popularity: { stars: number | null } | null;
}

/** How many apps a reason names at most. */
export const MAX_EXAMPLES = 2;

/**
 * Best known first: apps with an icon (finished catalog entries), then the
 * most GitHub stars, then the longest in the catalog (stable names), then
 * by name so the order never depends on the catalog's.
 */
function better(a: ExampleCandidate, b: ExampleCandidate): number {
  const icon = Number(b.icon !== null) - Number(a.icon !== null);
  if (icon !== 0) return icon;
  const stars = (b.popularity?.stars ?? -1) - (a.popularity?.stars ?? -1);
  if (stars !== 0) return stars;
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function scopeExamples(
  apps: readonly ExampleCandidate[],
  reasons: Readonly<Record<RequestedGroupKey, ScopeReason>> = MANAGER_SCOPE_REASONS,
  max = MAX_EXAMPLES,
): ScopeExamples {
  const out: ScopeExamples = {};
  for (const [group, reason] of Object.entries(reasons) as Array<
    [RequestedGroupKey, ScopeReason]
  >) {
    const service = reason.service;
    if (service === undefined) continue;
    const names = apps
      .filter((app) => app.services.includes(service))
      .sort(better)
      .slice(0, max)
      .map((app) => app.name);
    if (names.length > 0) out[group] = names;
  }
  return out;
}
