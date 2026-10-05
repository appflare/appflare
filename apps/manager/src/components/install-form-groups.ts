import { type CatalogSecret, enteredSecrets, isOptionalSecret, isSeedOnly } from "@appflare/schema";
import type { InstallVarField } from "../installs/install-vars";

/**
 * Which fields of the install form are asked up front and which fold into
 * its "Optional settings". Up front: what the install cannot go without, a
 * secret it must have (generated ones included, since a generated password
 * is often what the admin signs in with) and a setting that is required and
 * has no default, plus everything seed-only, which is asked once and never
 * again. Folded: optional secrets, and settings that are optional, have a
 * default, or are computed by Appflare. A folded field never stops the
 * install unless its value was changed into one that cannot be used, and
 * then the fold opens (see {@link foldStartsOpen}).
 */

/** Whether a secret's field goes into the fold. */
export function foldsSecret(secret: Pick<CatalogSecret, "optional" | "seedOnly">): boolean {
  return isOptionalSecret(secret) && !isSeedOnly(secret);
}

/** Whether a setting's field goes into the fold. */
export function foldsVar(
  field: Pick<InstallVarField, "required" | "shownDefault" | "derivedFrom" | "seedOnly">,
): boolean {
  if (field.seedOnly === true) return false;
  if (field.derivedFrom !== undefined) return true;
  return !field.required || field.shownDefault.trim().length > 0;
}

/** The form's fields in its two groups, in catalog order within each. */
export interface InstallFormGroups<S, V> {
  needed: { secrets: S[]; vars: V[] };
  folded: { secrets: S[]; vars: V[] };
}

export function installFormGroups<
  S extends Pick<CatalogSecret, "optional" | "seedOnly" | "derive">,
  V extends Pick<InstallVarField, "required" | "shownDefault" | "derivedFrom" | "seedOnly">,
>(secrets: readonly S[], vars: readonly V[]): InstallFormGroups<S, V> {
  const entered = enteredSecrets(secrets);
  return {
    needed: {
      secrets: entered.filter((s) => !foldsSecret(s)),
      vars: vars.filter((v) => !foldsVar(v)),
    },
    folded: {
      secrets: entered.filter(foldsSecret),
      vars: vars.filter(foldsVar),
    },
  };
}

/**
 * Whether the fold starts open: when it already holds something the admin
 * should see, a value for a folded secret or a setting that differs from
 * its default (a form filled in again from an earlier install, say), or a
 * setting whose value cannot be used.
 */
export function foldStartsOpen(
  folded: { secrets: readonly { name: string }[]; vars: readonly InstallVarField[] },
  values: {
    secrets: Readonly<Record<string, string | undefined>>;
    vars: (field: InstallVarField) => string;
    varProblem: (field: InstallVarField, value: string) => string | null;
  },
): boolean {
  return (
    folded.secrets.some((s) => (values.secrets[s.name] ?? "").length > 0) ||
    folded.vars.some((f) => {
      const value = values.vars(f);
      return value !== f.shownDefault || values.varProblem(f, value) !== null;
    })
  );
}

/**
 * The line under the fold's trigger: the first few labels, then how many
 * more ("Name in Appflare, OpenRouter API key and 5 more").
 */
export function foldSummary(labels: readonly string[], shown = 3): string {
  if (labels.length <= shown + 1) {
    if (labels.length <= 1) return labels.join("");
    return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  }
  return `${labels.slice(0, shown).join(", ")} and ${labels.length - shown} more`;
}
