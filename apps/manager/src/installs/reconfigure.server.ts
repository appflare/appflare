import {
  type ArtifactManifest,
  appTokenPermissions,
  artifactManifestSchema,
  type CatalogManifest,
  type EntryWorkerPlaceholders,
  entryPlaceholderValues,
  type SandboxInstanceType,
  type TokenPermission,
} from "@appflare/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { effectiveManifest } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import { type BuildKind, installs, resources } from "../db/schema";
import { parseStoredManifest } from "../jobs/entry-workers";
import type { ReconfigureJobParams } from "../jobs/reconfigure";
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
import { lastDurableObjectTagOf, updatePath } from "../jobs/update/plan";
import { activeSandboxJob, sandboxBusyMessage } from "../sandbox/busy";
import { readAppBaseUrl } from "./app-address.server";
import { appTokenSecret } from "./app-token-secret";
import { derivedVarValues, withDerivedSecrets } from "./derived-secrets";
import {
  enteredDerivedVarProblems,
  enteredVarFields,
  type InstallVarField,
  installVarFields,
  missingRequiredVar,
  settingsVarFields,
  varsUseWildcardHostname,
  varValueProblem,
} from "./install-vars";
import type { StartReconfigureInput } from "./reconfigure-input";
import { EMAIL_ROUTE_KIND, HYPERDRIVE_KIND, WILDCARD_DOMAIN_KIND } from "./resource-kinds";
import { catalogOnlyManifest } from "./start-install.server";
import {
  claim,
  readInstall,
  type StartJobDeps,
  statusRefusal,
  VersionActionError,
} from "./versions.server";
import { wildcardHostnameOf } from "./wildcard-domain-input";

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
  /** What `{{workerName}}`, `{{workerUrl}}` and `{{wildcardHostname}}` stand for in this install. */
  placeholders: {
    workerName: string;
    workerUrl: string | null;
    /** The wildcard domain's base hostname; null (filled in empty) without one. */
    wildcardHostname: string | null;
    /** An app of several Workers: what `{{workerUrl:<name>}}` and `{{workerName:<name>}}` become. */
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
   * For an app that receives email: the zone it receives for (null if none is
   * recorded), and zones an unfinished move left routes on; null otherwise.
   */
  email: { zoneId: string | null; zoneName: string | null; leftover: string[] } | null;
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
  const rows = await createDb(db)
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
    .orderBy(sql`rowid`);
  const secretNames = rows.filter((r) => r.kind === "secret").map((r) => r.name);
  if (install.build_kind === "self-deploying") {
    const catalog = recordedCatalog(install.manifest_json);
    if (catalog === null || install.pin_sha === null) return null;
    const sandbox = catalog.install.sandbox;
    return {
      catalog,
      fields: settingsVarFields(installVarFields(catalogOnlyManifest(catalog))),
      slots: secretSlots(catalog.secrets, secretNames),
      // A self-deploying entry declares no databases (the schema refuses them).
      databases: [],
      email: null,
      skipsPreview: null,
      installer: {
        pin: install.pin_sha,
        ...(sandbox?.expectedMinutes === undefined
          ? {}
          : { expectedMinutes: sandbox.expectedMinutes }),
        ...(sandbox?.instanceType === undefined ? {} : { instanceType: sandbox.instanceType }),
      },
      problem: sandboxConnected
        ? null
        : "This app is deployed by its own installer in the account's sandbox Worker, and Appflare is not connected to one. Connect sandbox builds in Settings to change its settings.",
    };
  }
  const signed = parseManifest(install.manifest_json);
  if (signed === null) return null;
  // The form of the newest revision recorded for the release, if any.
  const manifest = await effectiveManifest(createDb(db), signed, install.artifact_digest);
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
  const zone = zones.current;
  let problem: string | null = null;
  if (install.build_kind === "sandbox" && !sandboxConnected) {
    problem =
      "This app was built in the account's sandbox Worker, which holds its build, and Appflare is not connected to one. Connect sandbox builds in Settings to change its settings.";
  } else if (path.fullDeploy !== null) {
    problem =
      "The Worker lacks Durable Object migrations its version declares. Update or reinstall the app to change its settings.";
  }
  return {
    catalog: manifest.catalog,
    // A seed-only var was used once by the install and is kept nowhere.
    fields: settingsVarFields(installVarFields(manifest)),
    slots: secretSlots(manifest.catalog.secrets, secretNames, manifest.catalog.vars),
    databases: databaseSlots(
      manifest.catalog.resources?.hyperdrive ?? [],
      rows.filter((r) => r.kind === HYPERDRIVE_KIND),
    ),
    email:
      manifest.catalog.install.emailRouting === undefined
        ? null
        : {
            zoneId: zone?.zoneId ?? null,
            zoneName: zone?.zoneName ?? null,
            leftover: zones.leftover.map((z) => z.zoneName),
          },
    skipsPreview: path.skipPreview,
    installer: null,
    problem,
  };
}

/**
 * The Settings section of an install; null when the install is gone, or
 * never got far enough to have settings to change.
 */
export async function readInstallSettingsCore(
  deps: { db: D1Database; sandboxConnected: boolean; subdomain: string | null },
  installId: string,
): Promise<InstallSettings | null> {
  const orm = createDb(deps.db);
  const [install] = await orm.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (install === undefined || install.status === "uninstalled") return null;
  const ctx = await settingsContext(deps.db, install, deps.sandboxConnected);
  if (ctx === null) return null;
  const stored = parseStoredVars(install.config_json);
  return {
    slug: install.app_slug,
    kind: install.build_kind,
    unavailable: ctx.problem ?? statusRefusal(install.status),
    fields: ctx.fields.map((f) => ({ ...f, stored: stored[f.name] ?? null })),
    placeholders: await (async () => {
      // Where the app is reached: its custom domain while workers.dev is off.
      const workerUrl = await readAppBaseUrl(orm, install, deps.subdomain);
      const catalog = parseStoredManifest(install.manifest_json)?.catalog;
      const entryWorkers =
        catalog === undefined
          ? undefined
          : entryPlaceholderValues(catalog, install.worker_name, deps.subdomain, workerUrl);
      const wildcard = await orm
        .select({ kind: resources.kind, name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, install.id),
            eq(resources.kind, WILDCARD_DOMAIN_KIND),
            isNull(resources.deleted_at),
            isNull(resources.retained_at),
          ),
        );
      return {
        workerName: install.worker_name,
        workerUrl,
        wildcardHostname: wildcardHostnameOf(wildcard),
        ...(entryWorkers === undefined ? {} : { entryWorkers }),
      };
    })(),
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

/**
 * After the install's wildcard domain was assigned or removed: when any var
 * the Worker gets is filled in with it (`{{wildcardHostname}}`), starts the
 * `reconfigure` job with the stored settings unchanged and `refreshVars`, so
 * the serving version is deployed again with the new value, as a settings
 * change deploys it. Returns the job id; null when no var uses it (or the
 * app is not one Appflare deploys itself), so nothing needs deploying.
 * Refused like any settings change while another job of the app runs.
 */
export async function startVarsRefreshCore(
  deps: StartReconfigureDeps,
  installId: string,
): Promise<{ jobId: string } | null> {
  const install = await readInstall(deps.db, installId);
  if (install.build_kind === "self-deploying") return null;
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  const ctx = await settingsContext(deps.db, install, deps.sandboxConnected === true);
  const signed = parseManifest(install.manifest_json);
  if (ctx === null || signed === null) return null;
  const stored = parseStoredVars(install.config_json);
  // The primary Worker's vars, with the form of the newest revision: the
  // wildcard domain routes to the primary Worker, which is what reads it.
  if (!varsUseWildcardHostname({ catalog: ctx.catalog, worker: signed.worker }, stored)) {
    return null;
  }
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
      refreshVars: true,
    }),
    params: {
      kind: "reconfigure",
      jobId,
      installId: install.id,
      vars: stored,
      secrets: { set: {}, unset: [] },
      refreshVars: true,
      // Nothing the admin entered changes; the value it follows already did.
      ...(ctx.skipsPreview !== null ? { confirmNoPreview: true } : {}),
    },
  });
}
