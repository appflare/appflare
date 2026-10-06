import {
  accessOfferOf,
  type CatalogManifest,
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
 *
 * An install from a repository, or of a catalog app from source, is
 * installed again from the build it was installed from: the form opens on
 * that build's review instead of the catalog page, and the new install reads
 * the same build, whose files stay under the failed install's prefix in the
 * sandbox Worker's bucket (the removal keeps them; the new install's own
 * uninstall deletes them). When that build is gone (sandbox builds were
 * turned off, which deletes the bucket), the review offers to build the same
 * repository and branch again; that build's review then opens filled in.
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
  /** Where its code came from (`INSTALL_ORIGINS`). */
  origin: string;
  /** Not from the catalog: the build it was installed from; null for a catalog app. */
  source: InstallAgainSource | null;
}

/** The build an install from a repository (or from source) was installed from. */
export interface InstallAgainSource {
  origin: "repository" | "source";
  /** `owner/repo` on GitHub. */
  repo: string;
  /** The branch, tag or commit it was built from; null when not recorded. */
  ref: string | null;
  /** The commit it was built from; null when not recorded. */
  commit: string | null;
  /** The `source_builds` row; null when the install job recorded none. */
  buildId: string | null;
  /**
   * Whether that build can be installed again: `ready`; `gone`, because
   * Appflare has no usable record of it, sandbox builds are off (turning
   * them off deletes every build), or its files are missing; or `unknown`
   * when the sandbox Worker did not answer. `reason` says why, for the admin.
   */
  build:
    | { state: "ready" }
    | { state: "gone"; cause: "unrecorded" | "no-sandbox" | "missing"; reason: string }
    | { state: "unknown"; reason: string };
}

/**
 * Whether the review of `build` installs `record` again: an install from a
 * repository (or from source) of the build's app, from its own build or a
 * new build of the same repository.
 */
export function installAgainFitsBuild(
  record: InstallAgainRecord,
  build: {
    id: string;
    purpose: string;
    origin: string;
    repo: string;
    app: { slug: string } | null;
  },
): boolean {
  const source = record.source;
  if (source === null || build.purpose !== "install") return false;
  if (source.buildId === build.id) return true;
  if (build.origin !== source.origin) return false;
  return build.origin === "source" ? build.app?.slug === record.appKey : build.repo === source.repo;
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

/**
 * The review of a build that opens the form for "Install again" of an
 * install from a repository: the build it was installed from, or a new one
 * of the same repository. The page starts at the top, where it says what
 * installing again does; the form follows the review.
 */
export function sourceInstallAgainHref(installId: string, buildId: string): string {
  return `/catalog/source/${encodeURIComponent(buildId)}?again=${encodeURIComponent(installId)}`;
}

/** What says where "Install again" opens for an install. */
export interface InstallAgainTargetOf {
  id: string;
  status: string;
  origin: string;
  /** The app key of its catalog page. */
  appKey: string;
  /** Not from the catalog: the build its install job recorded; null when none. */
  buildId: string | null;
}

/**
 * Where "Install again" opens for an install that did not finish, or null
 * when it is not offered: the catalog page for a catalog app, the review of
 * the build it was installed from for one from a repository or from source.
 */
export function installAgainLink(install: InstallAgainTargetOf): string | null {
  if (install.status !== "failed") return null;
  if (install.origin === "catalog") return installAgainHref(install.id, install.appKey);
  return install.buildId === null ? null : sourceInstallAgainHref(install.id, install.buildId);
}

/** The build an install or update job recorded (`buildId` in `jobs.input_json`), or null. */
export function buildIdOfInput(inputJson: string | null): string | null {
  if (inputJson === null) return null;
  try {
    const value = (JSON.parse(inputJson) as { buildId?: unknown }).buildId;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
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
  /** The form installs a build for review (its version is the build's), not the catalog's release. */
  fromBuild?: boolean;
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
      target.fromBuild === true
        ? `This build is version ${target.version}; the install that did not finish tried ${record.version}. This installs ${target.version}.`
        : `The catalog has version ${target.version} now; the install that did not finish tried ${record.version}. This installs ${target.version}.`,
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
 * What the banner says must be entered again: database connection strings,
 * which have no note of their own; null when the app has none. Secrets are
 * said next to their fields ({@link SECRETS_AGAIN_NOTE}), once.
 */
export function reenterNote(catalog: CatalogManifest): string | null {
  if (hyperdriveDeclarations(catalog.resources?.hyperdrive).length === 0) return null;
  return "Appflare never stores database connection strings, so enter them again.";
}

/** Under the install form's Secrets heading when installing again. */
export const SECRETS_AGAIN_NOTE =
  "Their values from last time are not stored, so enter them again; generated ones have new values.";
