import {
  accessOfferOf,
  type CatalogManifest,
  enteredSecrets,
  hyperdriveDeclarations,
  needsWildcardHostname,
} from "@appflare/schema";
import type { AutoUpdateChoice } from "../auto-update/auto-update";
import type { InstallDomainInput } from "./install-input";
import { enteredVarFields, type InstallVarField, varValueProblem } from "./install-vars";

/**
 * "Install again" for an install that did not finish: the install form
 * opens on the app's catalog page, filled in with what the failed install
 * was given, and installing removes what the failed install left in the
 * account first (it is uninstalled, keeping nothing), then installs anew.
 * Removing first, rather than running the failed job again, is what keeps
 * it safe: the install job refuses names that already exist and never
 * adopts them, so a new install after a complete removal can neither
 * duplicate nor orphan anything, and it works whatever was fixed outside
 * Appflare in between (a token permission added, a domain freed).
 *
 * Secret values and connection strings are never stored, so they are
 * entered again; generated secrets get fresh values. Consent is never
 * carried over either: the Workers Paid, cost and requirements
 * confirmations are ticked again every time. Client-safe and pure.
 */

/** What Appflare recorded of a failed install, for its "Install again" form. */
export interface InstallAgainRecord {
  installId: string;
  /** The app key its catalog page opens with (`<catalog>:<slug>` for a custom catalog). */
  appKey: string;
  /** What the UI calls the install. */
  label: string;
  /** The version the failed install tried. */
  version: string;
  workerName: string;
  displayName: string | null;
  /** Settings as entered, placeholders kept (derived ones included). */
  vars: Record<string, string>;
  /** It was to be protected with Cloudflare Access. */
  access: boolean;
  /** The domain the form asked for besides workers.dev; null for none. */
  domain: InstallDomainInput | null;
  /** The zone whose email it was to receive; null for none. */
  emailZoneId: string | null;
  /** Its automatic-update choice, which the new install takes over. */
  autoUpdate: AutoUpdateChoice;
  /** What it left in the account, removed before the new install starts. */
  leftovers: Array<{ kind: string; name: string }>;
  /** The install job that failed, for "View log"; null when none is recorded. */
  failedJobId: string | null;
  /** Why it cannot be installed again now; null when it can. */
  refusal: string | null;
}

/** What the install form starts with for "Install again" (see `InstallForm`). */
export interface InstallFormPrefill {
  /** The failed install the new one replaces. */
  replaces: string;
  workerName: string;
  /** Empty: no display name. */
  displayName: string;
  /** Settings to start from, by name: only those the current version still takes. */
  vars: Record<string, string>;
  access: boolean;
  domain: InstallDomainInput | null;
  emailZoneId: string | null;
}

/** The catalog page that opens the form for "Install again", filled in. */
export function installAgainHref(installId: string, appKey: string): string {
  return `/catalog/${appKey}?again=${encodeURIComponent(installId)}#install`;
}

/** Whether an install is one "Install again" is offered for: a catalog app's install that did not finish. */
export function offersInstallAgain(install: { status: string; origin: string }): boolean {
  return install.status === "failed" && install.origin === "catalog";
}

/** What the version the form installs now is, as the catalog page knows it. */
export interface InstallAgainTarget {
  catalog: CatalogManifest;
  /** The version the form installs (the catalog's latest). */
  version: string;
  varFields: readonly InstallVarField[];
  /** The Worker name to use when the recorded one cannot be (the form's default). */
  defaultWorkerName: string;
  fixedWorkerName: boolean;
}

/**
 * The form's starting values for installing `record` again as `target`,
 * and what changed since, one sentence each: what the catalog changed and
 * what no longer applies. Anything that does not fit the version installed
 * now is left out and named.
 */
export function installAgainPrefill(
  record: InstallAgainRecord,
  target: InstallAgainTarget,
): { prefill: InstallFormPrefill; changes: string[] } {
  const { catalog } = target;
  const changes: string[] = [];
  if (record.version !== target.version) {
    changes.push(
      `The catalog has version ${target.version} now; the install that did not finish tried ${record.version}. This installs ${target.version}.`,
    );
  }

  let workerName = record.workerName;
  if (target.fixedWorkerName && workerName !== target.defaultWorkerName) {
    workerName = target.defaultWorkerName;
    changes.push(
      `${catalog.name} only works as the Worker "${workerName}" now, so the address changes.`,
    );
  }

  // Settings this version still takes, as entered last time.
  const fields = new Map(enteredVarFields(target.varFields).map((f) => [f.name, f]));
  const derived = new Set(
    target.varFields.filter((f) => f.derivedFrom !== undefined).map((f) => f.name),
  );
  const vars: Record<string, string> = {};
  const gone: string[] = [];
  const refused: string[] = [];
  for (const [name, value] of Object.entries(record.vars)) {
    // A derived setting is computed again from its secret.
    if (derived.has(name)) continue;
    const field = fields.get(name);
    if (field === undefined) gone.push(name);
    else if (varValueProblem(field, value) !== null) refused.push(field.label);
    else vars[name] = value;
  }
  if (gone.length > 0) {
    changes.push(
      `${gone.length === 1 ? "A setting" : "Settings"} from last time ${gone.length === 1 ? "is" : "are"} no longer part of ${catalog.name}, so ${gone.length === 1 ? "it is" : "they are"} left out: ${gone.join(", ")}.`,
    );
  }
  if (refused.length > 0) {
    changes.push(
      `This version does not accept what was entered last time for ${refused.join(", ")}; ${refused.length === 1 ? "it starts" : "they start"} from the default.`,
    );
  }

  // Cloudflare Access, as chosen last time, unless the entry requires it now.
  const offer = accessOfferOf(catalog);
  const access = offer === "required" ? true : record.access;
  if (offer === "required" && !record.access) {
    changes.push(`${catalog.name} must run behind Cloudflare Access now, so protection is on.`);
  }

  // The domain, when it still fits: a wildcard domain for an app that needs
  // every name under its hostname, an exact one for any other.
  let domain = record.domain;
  const wildcard = needsWildcardHostname(catalog.install);
  if (domain !== null && (domain.kind === "wildcard") !== wildcard) {
    changes.push(
      wildcard
        ? `${catalog.name} needs every name under its hostname now, so ${domain.hostname} is left out. Choose a wildcard domain.`
        : `${catalog.name} answers on exact hostnames now, so the wildcard domain *.${domain.hostname} is left out. Choose a custom domain.`,
    );
    domain = null;
  }

  let emailZoneId = record.emailZoneId;
  if (emailZoneId !== null && catalog.install.emailRouting === undefined) {
    changes.push(`${catalog.name} no longer receives email, so no zone is needed.`);
    emailZoneId = null;
  }

  return {
    prefill: {
      replaces: record.installId,
      workerName,
      displayName: record.displayName ?? "",
      vars,
      access,
      domain,
      emailZoneId,
    },
    changes,
  };
}

/**
 * What the form says it needs again: secret values and connection strings
 * are never stored, and generated secrets get new values. Null when the
 * app takes neither.
 */
export function reenterNote(catalog: CatalogManifest): string | null {
  const secrets = enteredSecrets(catalog.secrets);
  const generated = secrets.some((s) => s.generate !== undefined);
  const databases = hyperdriveDeclarations(catalog.resources?.hyperdrive).length > 0;
  if (secrets.length === 0 && !databases) return null;
  const what =
    secrets.length > 0 && databases
      ? "secrets and database connections"
      : secrets.length > 0
        ? "secrets"
        : "database connections";
  return `Appflare never stores the values of ${what}, so enter them again.${generated ? " Generated secrets have new values." : ""}`;
}

/** Under the install form's Secrets heading when installing again. */
export const SECRETS_AGAIN_NOTE =
  "Their values from last time are not stored, so enter them again; generated ones have new values.";
