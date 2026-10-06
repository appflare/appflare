import {
  type ArtifactManifest,
  accessOfferOf,
  appTokenPermissions,
  artifactManifestSchema,
  type CatalogManifest,
  type EntryWorkerPlaceholders,
  entryPlaceholderValues,
  hyperdriveDeclarations,
  type SandboxInstanceType,
  type TokenPermission,
} from "@appflare/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { readAccessPlaceholderValues } from "../access/placeholder-values.server";
import type { AccessPreflightProblem } from "../access/preflight.server";
import { PROTECT_MESSAGES, readInstallProtection } from "../access/protect.server";
import { effectiveManifest } from "../catalog/revisions.server";
import { createDb, type Database } from "../db/client";
import { type BuildKind, installs, resources } from "../db/schema";
import { jobCreator } from "../jobs/create-job.server";
import { entryWorkers, parseStoredManifest } from "../jobs/entry-workers";
import type { ReconfigureJobParams } from "../jobs/reconfigure";
import { type EmailAgainParts, emailLeftOut } from "../jobs/reconfigure/email-again";
import {
  changedVarNames,
  changesSecrets,
  connectionChangeProblems,
  type DatabaseSlot,
  databaseSlots,
  emailZones,
  enteredSecretProblems,
  nextStoredVars,
  parseStoredVars,
  type SecretSlot,
  secretChangeProblems,
  secretSlots,
} from "../jobs/reconfigure/plan";
import { recordedCatalog, settingsRunId } from "../jobs/self-deploying/phases";
import { emailZoneOnRecord, readEmailRouteRows } from "../jobs/update/email-routing";
import { lastDurableObjectTagOf, updatePath } from "../jobs/update/plan";
import { sandboxBinding } from "../sandbox/binding";
import { activeSandboxJob, sandboxBusyMessage } from "../sandbox/busy";
import { ENABLE_SANDBOX_PLACE } from "../sandbox/connect-copy";
import type { StartAccessChangeInput } from "./access-change-input";
import { accessRequiredOffRefusal } from "./access-offer";
import { readAppBaseUrl } from "./app-address.server";
import { appTokenSecret } from "./app-token-secret";
import { derivedVarValues, withDerivedSecrets } from "./derived-secrets";
import { recordedName } from "./install-names.server";
import {
  enteredDerivedVarProblems,
  enteredVarFields,
  type InstallVarField,
  installVarFields,
  missingRequiredVar,
  type PatchedVar,
  patchedVars,
  settingsVarFields,
  type VarsRefreshReason,
  varsNeedRefresh,
  varValueProblem,
} from "./install-vars";
import type { StartEmailAgainInput, StartReconfigureInput } from "./reconfigure-input";
import { EMAIL_ROUTE_KIND, HYPERDRIVE_KIND, WILDCARD_DOMAIN_KIND } from "./resource-kinds";
import { catalogOnlyManifest } from "./start-install.server";
import type { RefreshVars } from "./vars-refresh.server";
import {
  claim,
  readInstall,
  type StartJobDeps,
  statusRefusal,
  VersionActionError,
} from "./versions.server";
import { wildcardHostnameOf } from "./wildcard-domain-input";
import { workersDevBase } from "./workers-dev";

/**
 * Changing an installed app's settings: what the app page's Settings section
 * shows, and starting the `reconfigure` job that saves and redeploys them.
 * The job is claimed the way an update is (./versions.server.ts): refused
 * while any job of the install, or a self-update, is queued or running.
 * Secret VALUES go only into the Workflow params; `jobs.input_json` keeps
 * the names.
 */

/** One setting of the Settings section. */
export interface SettingField extends InstallVarField {
  /** The value the admin stored (placeholders as entered); null when it follows its default. */
  stored: string | null;
}

/** What the Settings section of `/apps/$installId` shows. */
export interface InstallSettings {
  slug: string;
  /** How the running code was built; a self-deploying app's installer applies the settings. */
  kind: BuildKind;
  /** Why the settings cannot be changed now; null when an admin can change them. */
  unavailable: string | null;
  /** One per setting the installed version declares, in the catalog's order. */
  fields: SettingField[];
  /**
   * The vars the catalog entry's config patches set on its Workers: signed
   * config, shown read-only with the technical names. Absent means none.
   */
  fixedVars?: PatchedVar[];
  /** What the placeholders (`{{appUrl}}`, `{{workerName}}`, …) stand for in this install. */
  placeholders: {
    workerName: string;
    /** The workers.dev URL, for `{{workerUrl}}`; null while the subdomain is unknown. */
    workerUrl: string | null;
    /** Where the app is served, for `{{appUrl}}`: its custom domain while workers.dev is off. */
    appUrl: string | null;
    /** The wildcard domain's base hostname; null (filled in empty) without one. */
    wildcardHostname: string | null;
    /** The Access placeholders' values; null (filled in empty) while the app is not protected. */
    accessTeamDomain?: string | null;
    accessTeamName?: string | null;
    accessAud?: string | null;
    accessCertsUrl?: string | null;
    /** An app of several Workers: what the per-Worker forms (`{{appUrl:<name>}}`) become. */
    entryWorkers?: EntryWorkerPlaceholders;
  };
  /** Names and labels only; values are never read back. */
  secrets: SecretSlot[];
  /**
   * The databases the app reaches through Hyperdrive. Their connection
   * strings are never stored, so they are never shown; each can be replaced.
   */
  databases: DatabaseSlot[];
  /** Whether secrets the version does not need can be removed (not for a self-deploying app). */
  canRemoveSecrets: boolean;
  /**
   * For an app that receives email: the zone it receives for (the zone on
   * record, even when a version without email removed every route there;
   * null if none is recorded), zones an unfinished move left routes on, and what an update or
   * a rollback left out of the installed version's email there (`again`,
   * null when nothing is, or while a job of the app runs); null otherwise.
   */
  email: {
    zoneId: string | null;
    zoneName: string | null;
    leftover: string[];
    again: EmailAgainParts | null;
  } | null;
  /** Why the new settings cannot be checked on a preview before they serve; null when they can. */
  skipsPreview: string | null;
  /** A self-deploying app: the installer run whose cost the admin confirms; null otherwise. */
  installer: {
    pin: string;
    expectedMinutes?: number;
    instanceType?: SandboxInstanceType;
  } | null;
  /**
   * The Cloudflare token the app needs for itself (its `tokenPermissions`),
   * so Settings always says how to create one: `secret` is the secret that
   * takes it (`appTokenSecret`), shown with "Create token" next to its new
   * value, or null when the app takes the token in its own setup steps and
   * Settings shows it on its own. Null when the app needs no token of its
   * own, and for a self-deploying app, whose token card on the app's page
   * shows it.
   */
  appToken: { secret: string | null; permissions: TokenPermission[] } | null;
}

type InstallRow = typeof installs.$inferSelect;

/** What both the Settings section and the start need of an install. */
interface SettingsContext {
  catalog: CatalogManifest;
  fields: InstallVarField[];
  slots: SecretSlot[];
  databases: DatabaseSlot[];
  email: InstallSettings["email"];
  skipsPreview: string | null;
  installer: InstallSettings["installer"];
  /** Why the settings cannot be changed at all (whoever asks); null when they can. */
  problem: string | null;
}

function parseManifest(json: string | null): ArtifactManifest | null {
  if (json === null) return null;
  try {
    const parsed = artifactManifestSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function settingsContext(
  db: D1Database,
  install: InstallRow,
  sandboxConnected: boolean,
): Promise<SettingsContext | null> {
  const signed =
    install.build_kind === "self-deploying" ? null : parseManifest(install.manifest_json);
  const [rows, effective, emailRows] = await Promise.all([
    createDb(db)
      .select({
        kind: resources.kind,
        binding: resources.binding,
        name: resources.name,
        cfId: resources.cf_id,
        createdAt: resources.created_at,
      })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, install.id),
          inArray(resources.kind, ["secret", EMAIL_ROUTE_KIND, HYPERDRIVE_KIND]),
          isNull(resources.deleted_at),
          isNull(resources.retained_at),
        ),
      )
      // Insertion order (created_at can tie within a millisecond).
      .orderBy(sql`rowid`),
    // The form of the newest revision recorded for the release, if any.
    signed === null ? null : effectiveManifest(createDb(db), signed, install.artifact_digest),
    // Live and removed: the zone on record, and what an update or a
    // rollback left out.
    signed === null ? [] : readEmailRouteRows(createDb(db), install.id),
  ]);
  // Secret rows: `name` is the secret's key, `binding` the name the Worker reads.
  const secretRows = rows.filter((r) => r.kind === "secret");
  if (install.build_kind === "self-deploying") {
    const catalog = recordedCatalog(install.manifest_json);
    if (catalog === null || install.pin_sha === null) return null;
    const container = catalog.install.container;
    return {
      catalog,
      fields: settingsVarFields(installVarFields(catalogOnlyManifest(catalog))),
      slots: secretSlots(catalog.secrets, secretRows),
      // A self-deploying entry declares no databases (the schema refuses them).
      databases: [],
      email: null,
      skipsPreview: null,
      installer: {
        pin: install.pin_sha,
        ...(container?.expectedMinutes === undefined
          ? {}
          : { expectedMinutes: container.expectedMinutes }),
        ...(container?.instanceType === undefined ? {} : { instanceType: container.instanceType }),
      },
      problem: sandboxConnected
        ? null
        : `This app is deployed by its own installer in the account's sandbox Worker, and Appflare is not connected to one. Connect sandbox builds in ${ENABLE_SANDBOX_PLACE} to change its settings.`,
    };
  }
  const manifest = effective;
  if (manifest === null) return null;
  const path = updatePath(
    manifest,
    install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
    // The installed version itself: its exports are the serving ones.
    manifest.worker.exports,
  );
  const zones = emailZones(
    rows
      .filter((r) => r.kind === EMAIL_ROUTE_KIND)
      .map((r) => ({ name: r.name, cfId: r.cfId, createdAt: r.createdAt.getTime() })),
  );
  // The newest live route's zone, else the one routes a version without
  // email removed from: setting the email up again happens there.
  const zone = emailZoneOnRecord(emailRows);
  let problem: string | null = null;
  if (install.build_kind === "sandbox" && !sandboxConnected) {
    problem = `This app was built in the account's sandbox Worker, which holds its build, and Appflare is not connected to one. Connect sandbox builds in ${ENABLE_SANDBOX_PLACE} to change its settings.`;
  } else if (path.fullDeploy !== null) {
    problem =
      "The Worker lacks Durable Object migrations its version declares. Update or reinstall the app to change its settings.";
  }
  return {
    catalog: manifest.catalog,
    // A seed-only var was used once by the install and is kept nowhere.
    fields: settingsVarFields(installVarFields(manifest)),
    slots: secretSlots(manifest.catalog.secrets, secretRows, manifest.catalog.vars),
    databases: databaseSlots(
      hyperdriveDeclarations(manifest.catalog.resources?.hyperdrive),
      rows.filter((r) => r.kind === HYPERDRIVE_KIND),
    ),
    email:
      manifest.catalog.install.emailRouting === undefined
        ? null
        : {
            zoneId: zone?.zoneId ?? null,
            zoneName: zone?.zoneName ?? null,
            leftover: zones.leftover.map((z) => z.zoneName),
            // Only between jobs: while one runs, its own steps change the records.
            again:
              install.status === "installed"
                ? emailLeftOut(manifest.catalog.install.emailRouting, emailRows, install.id)
                : null,
          },
    skipsPreview: path.skipPreview,
    installer: null,
    problem,
  };
}

/** What the settings' placeholders fill in: where the app is reached, and its names. */
async function settingsPlaceholders(
  orm: Database,
  install: InstallRow,
  subdomain: string | null,
): Promise<InstallSettings["placeholders"]> {
  const [appUrl, wildcard, access] = await Promise.all([
    // Where the app is reached: its custom domain while workers.dev is off.
    readAppBaseUrl(orm, install, subdomain),
    orm
      .select({ kind: resources.kind, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, install.id),
          eq(resources.kind, WILDCARD_DOMAIN_KIND),
          isNull(resources.deleted_at),
          isNull(resources.retained_at),
        ),
      ),
    readAccessPlaceholderValues(orm, install.id),
  ]);
  const catalog = parseStoredManifest(install.manifest_json)?.catalog;
  const entryWorkers =
    catalog === undefined
      ? undefined
      : entryPlaceholderValues(catalog, install.worker_name, subdomain, appUrl);
  return {
    workerName: install.worker_name,
    workerUrl: subdomain ? workersDevBase(install.worker_name, subdomain) : null,
    appUrl,
    wildcardHostname: wildcardHostnameOf(wildcard),
    accessTeamDomain: access?.teamDomain ?? null,
    accessTeamName: access?.teamName ?? null,
    accessAud: access?.aud ?? null,
    accessCertsUrl: access?.certsUrl ?? null,
    ...(entryWorkers === undefined ? {} : { entryWorkers }),
  };
}

/**
 * The Settings section of an install; null when the install is gone, or
 * never got far enough to have settings to change.
 */
export async function readInstallSettingsCore(
  deps: { db: D1Database; sandboxConnected: boolean; subdomain: string | null },
  installId: string,
  /** The install's row, when the caller read it already (undefined: there is none). */
  known?: { install: InstallRow | undefined },
): Promise<InstallSettings | null> {
  const orm = createDb(deps.db);
  const install =
    known === undefined
      ? (await orm.select().from(installs).where(eq(installs.id, installId)).limit(1))[0]
      : known.install;
  if (install === undefined || install.status === "uninstalled") return null;
  const [ctx, placeholders] = await Promise.all([
    settingsContext(deps.db, install, deps.sandboxConnected),
    settingsPlaceholders(orm, install, deps.subdomain),
  ]);
  if (ctx === null) return null;
  const stored = parseStoredVars(install.config_json);
  return {
    slug: install.app_slug,
    kind: install.build_kind,
    unavailable: ctx.problem ?? statusRefusal(install.status),
    fields: ctx.fields.map((f) => ({ ...f, stored: stored[f.name] ?? null })),
    fixedVars: patchedVars(ctx.catalog),
    placeholders,
    // Derived secrets are never entered; their source's row says they follow it.
    secrets: ctx.slots.filter((slot) => slot.derivedFrom === undefined),
    databases: ctx.databases,
    canRemoveSecrets: install.build_kind !== "self-deploying",
    email: ctx.email,
    skipsPreview: ctx.skipsPreview,
    installer: ctx.installer,
    appToken: (() => {
      const permissions = appTokenPermissions(ctx.catalog);
      if (permissions.length === 0 || install.build_kind === "self-deploying") return null;
      return { secret: appTokenSecret(ctx.catalog), permissions };
    })(),
  };
}

export interface StartReconfigureDeps extends StartJobDeps<ReconfigureJobParams> {
  /** Whether this manager has its `SANDBOX` binding to the sandbox Worker. */
  sandboxConnected?: boolean;
}

/**
 * Starts the `reconfigure` job: checks the new settings against the
 * installed version (required settings, JSON settings, which secrets may be
 * replaced or removed, the email zone, the confirmations), then claims the
 * install and creates the Workflow instance. Returns the job id for
 * `/jobs/$jobId`.
 */
export async function startReconfigureCore(
  deps: StartReconfigureDeps,
  request: StartReconfigureInput,
): Promise<{ jobId: string }> {
  const install = await readInstall(deps.db, request.installId);
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  const ctx = await settingsContext(deps.db, install, deps.sandboxConnected === true);
  if (ctx === null) {
    throw new VersionActionError(
      "Appflare has no readable record of this app's version; update or reinstall it to change its settings.",
    );
  }
  if (ctx.problem !== null) throw new VersionActionError(ctx.problem);
  const selfDeploying = install.build_kind === "self-deploying";

  const entered = request.vars ?? {};
  const unknown = Object.keys(entered).filter((name) => !ctx.fields.some((f) => f.name === name));
  if (unknown.length > 0) {
    throw new VersionActionError(`${ctx.catalog.name} has no setting ${unknown.join(", ")}.`);
  }
  // A derived var is never entered: it follows its source secret.
  const derivedProblems = enteredDerivedVarProblems(Object.keys(entered), ctx.fields);
  if (derivedProblems.length > 0) throw new VersionActionError(derivedProblems.join(" "));
  const fields = enteredVarFields(ctx.fields);
  for (const field of fields) {
    const value = (entered[field.name] ?? "").trim();
    if (missingRequiredVar(field, value)) {
      throw new VersionActionError(`${field.label} (${field.name}) is required.`);
    }
    const problem = varValueProblem(field, value);
    if (problem !== null) throw new VersionActionError(problem);
  }
  const before = parseStoredVars(install.config_json);

  const enteredSecrets = request.secrets?.set ?? {};
  const enteredProblems = enteredSecretProblems(enteredSecrets, ctx.slots);
  if (enteredProblems.length > 0) throw new VersionActionError(enteredProblems.join(" "));
  const secrets = {
    // A new value of a source secret replaces what is derived from it too.
    set: await withDerivedSecrets(ctx.catalog.secrets, enteredSecrets),
    unset: [...new Set(request.secrets?.unset ?? [])],
  };
  // Derived vars keep their stored value unless their source gets a new one.
  const vars = {
    ...nextStoredVars(
      before,
      fields.map((f) => f.name),
      entered,
    ),
    ...(await derivedVarValues(ctx.catalog.vars, enteredSecrets)),
  };
  const secretProblems = secretChangeProblems(secrets, ctx.slots, { canRemove: !selfDeploying });
  if (secretProblems.length > 0) throw new VersionActionError(secretProblems.join(" "));

  // New connection strings replace the databases' Hyperdrive configurations.
  const connections: Record<string, string> = {};
  for (const [binding, value] of Object.entries(request.hyperdrive ?? {})) {
    connections[binding] = value.trim();
  }
  const connectionProblems = connectionChangeProblems(connections, ctx.databases);
  if (connectionProblems.length > 0) throw new VersionActionError(connectionProblems.join(" "));
  const replacesConnections = Object.keys(connections).length > 0;

  let zoneId: string | null = null;
  if (request.emailRouting !== undefined) {
    if (ctx.email === null) {
      throw new VersionActionError(`${ctx.catalog.name} does not receive email; it takes no zone.`);
    }
    // The same zone again finishes a move that left routes on another zone.
    if (request.emailRouting.zoneId !== ctx.email.zoneId || ctx.email.leftover.length > 0) {
      zoneId = request.emailRouting.zoneId;
    }
  }

  const changedVars = changedVarNames(before, vars);
  // Only a new version needs a preview check; moving email deploys nothing.
  const redeploy = changedVars.length > 0 || changesSecrets(secrets) || replacesConnections;
  if (redeploy && ctx.skipsPreview !== null && request.confirmNoPreview !== true) {
    throw new VersionActionError(
      `${ctx.skipsPreview}. Confirm saving without that check to change the settings.`,
    );
  }
  if (selfDeploying) {
    if (request.buildConfirmed !== true) {
      throw new VersionActionError(
        `${ctx.catalog.name}'s own installer applies the settings in your sandbox Worker. Confirm its cost to save them.`,
      );
    }
    // Storing a secret restarts the sandbox Worker, and the run needs it free.
    const busy = await activeSandboxJob(createDb(deps.db));
    if (busy !== null) {
      const message = sandboxBusyMessage(busy);
      throw new VersionActionError(`${message[0]?.toUpperCase() ?? ""}${message.slice(1)}.`);
    }
  }

  if (!redeploy && zoneId === null) {
    throw new VersionActionError(
      "Nothing to save: the settings, secrets, database connections and email zone are as they are.",
    );
  }

  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "reconfigure",
    inputJson: JSON.stringify({
      installId: install.id,
      version: install.catalog_version,
      vars: changedVars,
      secrets: { set: Object.keys(secrets.set).sort(), unset: [...secrets.unset].sort() },
      // Binding names only: connection strings hold database passwords.
      ...(replacesConnections ? { hyperdrive: Object.keys(connections).sort() } : {}),
      ...(zoneId === null ? {} : { emailRouting: { zoneId } }),
      ...(selfDeploying
        ? {
            selfDeploying: true,
            buildConfirmed: true,
            sandboxRun: settingsRunId(jobId),
          }
        : {}),
    }),
    params: {
      kind: "reconfigure",
      jobId,
      installId: install.id,
      vars,
      secrets,
      ...(replacesConnections ? { hyperdrive: connections } : {}),
      ...(zoneId === null ? {} : { emailRouting: { zoneId } }),
      ...(redeploy && ctx.skipsPreview !== null ? { confirmNoPreview: true } : {}),
      ...(selfDeploying ? { selfDeploying: true, buildConfirmed: true } : {}),
    },
  });
}

/** Whether two descriptions of setting the email up again name the same parts. */
function sameEmailParts(a: StartEmailAgainInput["parts"], b: EmailAgainParts): boolean {
  const key = (p: StartEmailAgainInput["parts"]) =>
    JSON.stringify([
      p.zoneId,
      [...p.addresses].sort(),
      p.catchAll,
      p.remove.map((r) => `${r.kind}:${r.name}`).sort(),
    ]);
  return key(a) === key(b);
}

/**
 * Starts the `reconfigure` job with `emailAgain`: sets the app's email up
 * again on the domain it receives email for, finishing what an update or a
 * rollback left out (see jobs/reconfigure/email-again.ts). `parts` are what
 * the confirmation named; a page left open while they changed (another job
 * set something up, a revision changed the version's email) is refused with
 * a request to reload, so nobody confirms a change they did not see. Refused
 * when nothing is left out, and while another job of the app runs. Returns
 * the job id.
 */
export async function startEmailAgainCore(
  deps: StartReconfigureDeps,
  request: StartEmailAgainInput,
): Promise<{ jobId: string }> {
  const install = await readInstall(deps.db, request.installId);
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  const ctx = await settingsContext(deps.db, install, deps.sandboxConnected === true);
  if (ctx === null || install.build_kind === "self-deploying") {
    throw new VersionActionError(
      "Appflare has no readable record of this app's version; update or reinstall it to set up its email.",
    );
  }
  if (ctx.email === null) {
    throw new VersionActionError(`${ctx.catalog.name} does not receive email.`);
  }
  const parts = ctx.email.again;
  if (parts === null) {
    throw new VersionActionError(
      `Nothing is left out of ${ctx.catalog.name}'s email: it is set up as its version asks.`,
    );
  }
  if (!sameEmailParts(request.parts, parts)) {
    throw new VersionActionError(
      "What is left out of the app's email changed since this page was loaded. Reload it to see what setting it up again does now.",
    );
  }
  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "reconfigure",
    inputJson: JSON.stringify({
      installId: install.id,
      version: install.catalog_version,
      vars: [],
      secrets: { set: [], unset: [] },
      emailAgain: true,
    }),
    params: {
      kind: "reconfigure",
      jobId,
      installId: install.id,
      vars: parseStoredVars(install.config_json),
      secrets: { set: {}, unset: [] },
      emailAgain: true,
    },
  });
}

/**
 * After a value the app's settings are filled in with changed (`changed`:
 * the wildcard domain was assigned or removed, or the address the app is
 * served at moved between workers.dev and a domain): when any var the
 * Worker gets uses it (`{{wildcardHostname}}`, `{{appUrl}}`,
 * `{{appHostname}}`), starts the `reconfigure` job with the stored settings
 * unchanged and `refreshVars`, so the serving version is deployed again with
 * the new value, as a settings change deploys it. Returns the job id; null
 * when no var uses it (or the app is not one Appflare deploys itself), so
 * nothing needs deploying. Refused like any settings change while another
 * job of the app runs.
 */
export async function startVarsRefreshCore(
  deps: StartReconfigureDeps,
  installId: string,
  changed: readonly VarsRefreshReason[],
): Promise<{ jobId: string } | null> {
  const install = await readInstall(deps.db, installId);
  if (install.build_kind === "self-deploying") return null;
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  const ctx = await settingsContext(deps.db, install, deps.sandboxConnected === true);
  const signed = parseManifest(install.manifest_json);
  if (ctx === null || signed === null) return null;
  const stored = parseStoredVars(install.config_json);
  // Every Worker of the app, with the form of the newest revision: the
  // domain routes to the primary Worker, but another Worker of the app may
  // be the one that names it (the settings change job deploys each Worker
  // whose vars use it).
  const workers = entryWorkers({ ...signed, catalog: ctx.catalog }, install.worker_name);
  if (!workers.some((w) => varsNeedRefresh(w.manifest, stored, changed))) return null;
  if (ctx.problem !== null) throw new VersionActionError(ctx.problem);
  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "reconfigure",
    inputJson: JSON.stringify({
      installId: install.id,
      version: install.catalog_version,
      vars: [],
      secrets: { set: [], unset: [] },
      refreshVars: changed,
    }),
    params: {
      kind: "reconfigure",
      jobId,
      installId: install.id,
      vars: stored,
      secrets: { set: {}, unset: [] },
      refreshVars: [...changed],
      // Nothing the admin entered changes; the value it follows already did.
      ...(ctx.skipsPreview !== null ? { confirmNoPreview: true } : {}),
    },
  });
}

export interface StartAccessChangeDeps extends StartReconfigureDeps {
  /**
   * Why the account or the token cannot protect an app now
   * (`accessCapabilityProblem`), null when they can; asked before turning
   * protection on. Without it the job's first Access step refuses instead.
   */
  accessPreflight?: () => Promise<AccessPreflightProblem | null>;
}

/**
 * Turns Cloudflare Access protection of an installed app on or off: checks
 * what can be checked now, then starts the `reconfigure` job with `access`
 * (see jobs/reconfigure.ts), which changes the protection under the Access
 * lock, checking again there, and deploys the app's settings again when
 * they use the Access placeholders (`refreshVars: ["access"]`): after the
 * protection is made when turning it on, before it is removed when turning
 * it off. Refused for an app deployed by its own installer, for turning off
 * an app whose catalog entry requires protection (or one that is not
 * protected), while another job of the app runs, and when the account
 * cannot protect apps. Turning it
 * on for an app already protected brings its protection in step again (a
 * repair, after "Appflare users" was made anew, say). Returns the job id.
 */
export async function startAccessChangeCore(
  deps: StartAccessChangeDeps,
  request: StartAccessChangeInput,
): Promise<{ jobId: string }> {
  const install = await readInstall(deps.db, request.installId);
  const name = recordedName(install);
  if (install.build_kind === "self-deploying") {
    throw new VersionActionError(PROTECT_MESSAGES.selfDeploying(name));
  }
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  const signed = parseManifest(install.manifest_json);
  const ctx = await settingsContext(deps.db, install, deps.sandboxConnected === true);
  if (signed === null || ctx === null) {
    throw new VersionActionError(
      "Appflare has no readable record of this app's version; update or reinstall it to change its protection.",
    );
  }
  const isProtected = (await readInstallProtection(deps.db, install.id)) !== null;
  if (request.access === "off") {
    // The form of the newest revision: a revision may make protection required.
    if (accessOfferOf(ctx.catalog) === "required") {
      throw new VersionActionError(accessRequiredOffRefusal(ctx.catalog.name));
    }
    if (!isProtected) {
      throw new VersionActionError(
        `${name} is not protected with Cloudflare Access by Appflare; there is nothing to turn off.`,
      );
    }
  } else {
    if (deps.accessPreflight !== undefined) {
      // Its words read on their own, a refusal or "could not ask".
      const problem = await deps.accessPreflight();
      if (problem !== null) throw new VersionActionError(problem.message);
    }
  }
  const stored = parseStoredVars(install.config_json);
  // Every Worker of the app, with the form of the newest revision, as a
  // settings refresh reads them.
  const workers = entryWorkers({ ...signed, catalog: ctx.catalog }, install.worker_name);
  const refresh = workers.some((w) => varsNeedRefresh(w.manifest, stored, ["access"]));
  if (refresh && ctx.problem !== null) throw new VersionActionError(ctx.problem);
  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "reconfigure",
    inputJson: JSON.stringify({
      installId: install.id,
      version: install.catalog_version,
      vars: [],
      secrets: { set: [], unset: [] },
      access: request.access,
      ...(refresh ? { refreshVars: ["access"] } : {}),
    }),
    params: {
      kind: "reconfigure",
      jobId,
      installId: install.id,
      vars: stored,
      secrets: { set: {}, unset: [] },
      access: request.access,
      ...(refresh ? { refreshVars: ["access" as const] } : {}),
      // Nothing the admin entered changes; the values the settings follow do.
      ...(refresh && ctx.skipsPreview !== null ? { confirmNoPreview: true } : {}),
    },
  });
}

/**
 * The settings refresh (`startVarsRefreshCore`) of this manager, for the
 * domain and workers.dev actions that change a value the settings are
 * filled in with.
 */
export function varsRefresher(env: Pick<Env, "DB" | "JOBS"> & { SANDBOX?: unknown }): RefreshVars {
  return (installId, changed) =>
    startVarsRefreshCore(
      {
        db: env.DB,
        workflows: env.JOBS,
        sandboxConnected: sandboxBinding(env) !== undefined,
        createJob: jobCreator(env.JOBS),
      },
      installId,
      changed,
    );
}
