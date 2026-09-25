import {
  type ArtifactManifest,
  artifactManifestSchema,
  type CatalogManifest,
  type SandboxInstanceType,
} from "@appflare/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { type BuildKind, installs, resources } from "../db/schema";
import type { ReconfigureJobParams } from "../jobs/reconfigure";
import {
  changedVarNames,
  changesSecrets,
  emailZones,
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
import {
  type InstallVarField,
  installVarFields,
  missingRequiredVar,
  varValueProblem,
} from "./install-vars";
import type { StartReconfigureInput } from "./reconfigure-input";
import { EMAIL_ROUTE_KIND } from "./resource-kinds";
import { catalogOnlyManifest } from "./start-install.server";
import {
  claim,
  readInstall,
  type StartJobDeps,
  statusRefusal,
  VersionActionError,
} from "./versions.server";

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
  /** What `{{workerName}}` and `{{workerUrl}}` stand for in this install. */
  placeholders: { workerName: string; workerUrl: string | null };
  /** Names and labels only; values are never read back. */
  secrets: SecretSlot[];
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
}

type InstallRow = typeof installs.$inferSelect;

/** What both the Settings section and the start need of an install. */
interface SettingsContext {
  catalog: CatalogManifest;
  fields: InstallVarField[];
  slots: SecretSlot[];
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
      name: resources.name,
      cfId: resources.cf_id,
      createdAt: resources.created_at,
    })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        inArray(resources.kind, ["secret", EMAIL_ROUTE_KIND]),
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
      fields: installVarFields(catalogOnlyManifest(catalog)),
      slots: secretSlots(catalog.secrets, secretNames),
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
  const manifest = parseManifest(install.manifest_json);
  if (manifest === null) return null;
  const path = updatePath(
    manifest,
    install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
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
    fields: installVarFields(manifest),
    slots: secretSlots(manifest.catalog.secrets, secretNames),
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
    placeholders: {
      workerName: install.worker_name,
      // Where the app is reached: its custom domain while workers.dev is off.
      workerUrl: await readAppBaseUrl(orm, install, deps.subdomain),
    },
    secrets: ctx.slots,
    canRemoveSecrets: install.build_kind !== "self-deploying",
    email: ctx.email,
    skipsPreview: ctx.skipsPreview,
    installer: ctx.installer,
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
  const fieldNames = ctx.fields.map((f) => f.name);
  const unknown = Object.keys(entered).filter((name) => !fieldNames.includes(name));
  if (unknown.length > 0) {
    throw new VersionActionError(`${ctx.catalog.name} has no setting ${unknown.join(", ")}.`);
  }
  for (const field of ctx.fields) {
    const value = (entered[field.name] ?? "").trim();
    if (missingRequiredVar(field, value)) {
      throw new VersionActionError(`${field.label} (${field.name}) is required.`);
    }
    const problem = varValueProblem(field, value);
    if (problem !== null) throw new VersionActionError(problem);
  }
  const before = parseStoredVars(install.config_json);
  const vars = nextStoredVars(before, fieldNames, entered);

  const secrets = {
    set: request.secrets?.set ?? {},
    unset: [...new Set(request.secrets?.unset ?? [])],
  };
  const secretProblems = secretChangeProblems(secrets, ctx.slots, { canRemove: !selfDeploying });
  if (secretProblems.length > 0) throw new VersionActionError(secretProblems.join(" "));

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
  const redeploy = changedVars.length > 0 || changesSecrets(secrets);
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
      "Nothing to save: the settings, secrets and email zone are as they are.",
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
      ...(zoneId === null ? {} : { emailRouting: { zoneId } }),
      ...(redeploy && ctx.skipsPreview !== null ? { confirmNoPreview: true } : {}),
      ...(selfDeploying ? { selfDeploying: true, buildConfirmed: true } : {}),
    },
  });
}
