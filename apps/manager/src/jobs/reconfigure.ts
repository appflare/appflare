import { NonRetryableError } from "cloudflare:workflows";
import type { VersionMetadata } from "@appflare/cf-api";
import {
  type AccessPlaceholderValues,
  type ArtifactManifest,
  accessOfferOf,
  artifactManifestSchema,
  connectionStringProblems,
  hyperdriveDeclarations,
  withRevisedCatalog,
  workerUploadProblem,
} from "@appflare/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accessPlaceholderValues,
  readAccessPlaceholderValues,
} from "../access/placeholder-values.server";
import { effectiveManifest } from "../catalog/revisions.server";
import { appPlace } from "../components/app-links";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { accessRequiredOffRefusal } from "../installs/access-offer";
import { VARS_REFRESH_REASONS, varsNeedRefresh } from "../installs/install-vars";
import { EMAIL_ROUTE_KIND, HYPERDRIVE_KIND } from "../installs/resource-kinds";
import { wildcardHostnameOf } from "../installs/wildcard-domain-input";
import { appBaseUrl, domainHostnames, workersDevSubdomain } from "../installs/workers-dev";
import { sandboxBinding } from "../sandbox/binding";
import { ENABLE_SANDBOX_PLACE } from "../sandbox/connect-copy";
import {
  entryBindings,
  entryPlaceholders,
  entryScriptNamesOf,
  entryWorkers,
  mergedWorkerVersions,
  workerLabel,
} from "./entry-workers";
import { protectInstalledPhase, unprotectPhase } from "./install/access";
import { sha256Hex } from "./install/artifact";
import {
  checkEmailRoutingPhase,
  type EmailRouteRecord,
  emailRoutingJobInput,
  provisionEmailRoutingPhase,
  removeEmailRoutesPhase,
} from "./install/email-routing";
import {
  deployOtherWorkerVersionPhase,
  type EntryUploadContext,
  type OtherWorkerUpdate,
  promoteOtherWorkerPhase,
  reconfigureOtherWorkerPhase,
  secretChangesFor,
} from "./install/entry-worker-phases";
import { healthColumns, healthLabel } from "./install/health";
import { buildScriptMetadata, installVars } from "./install/metadata";
import {
  checkLiveHealthPhase,
  lookupSubdomainPhase,
  probeUntilHealthy,
  resourceId,
  uploadAssetsPhase,
} from "./install/phases";
import { newSinkTokenPhase } from "./install/pipelines";
import { assignRateLimitsPhase } from "./install/rate-limits";
import {
  type ConnectionReplacement,
  createReplacementPhase,
  deleteConfigPhase,
  deleteSupersededPhase,
  supersededConfigs,
  switchConnectionRecords,
} from "./reconfigure/hyperdrive";
import {
  changedVarNames,
  changesSecrets,
  connectionChangesSchema,
  emailRouteZoneId,
  emailZones,
  parseStoredVars,
  type SecretChanges,
  type SecretSlot,
  secretChangeProblems,
  secretChangesSchema,
  secretSlots,
  storedVarsJson,
} from "./reconfigure/plan";
import { applySecretChangesPhase, undoSecretChangesPhase } from "./reconfigure/secrets";
import type { JobContext } from "./run-job";
import { runSelfDeployingReconfigure } from "./self-deploying/reconfigure";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";
import { settleUnit } from "./units/result";
import type { ArtifactHost } from "./units/units";
import { CANARY_MAX_ATTEMPTS } from "./update";
import {
  canarySkipReason,
  diffBindings,
  lastDurableObjectTagOf,
  previewUrl,
  type RecordedResource,
  updatePath,
  vectorizeShapesOf,
} from "./update/plan";
import { takeSnapshotPhase } from "./update/snapshot";

/**
 * The `reconfigure` job: redeploys the version an app runs with changed
 * settings (vars), secrets, or Email Routing zone, without downtime and with
 * a way back. The same checks as an update, minus everything that changes
 * the code:
 *
 * 1. Plan: the recorded artifact manifest (its digest must match the one
 *    recorded) and the install's resources must still fit together; the
 *    secret changes must be allowed (see ./reconfigure/plan.ts); a new
 *    Email Routing zone is inspected before anything changes.
 * 2. Snapshot, as an update takes it, with the settings before the change.
 * 3. Upload a version of the same artifact (the signed release, or for a
 *    sandbox tier app the build the sandbox Worker stored, never a new
 *    build) with every non-secret binding sent explicitly, the new vars, and
 *    `keep_bindings: ["secret_text"]`.
 * 4. Set and remove secrets on that version through the versions secrets
 *    API, before anything serves it (./reconfigure/secrets.ts).
 * 5. Canary on the final version's preview URL, as an update.
 * 6. Promote it to 100% of traffic, then record the settings and secrets.
 * 7. Move Email Routing to the new zone (new rules first, then the old ones
 *    are removed), then the live health check, recorded as an update's.
 *
 * A new connection string for a database the app reaches through Hyperdrive
 * becomes a new Hyperdrive configuration, made after the snapshot and bound
 * by the uploaded version; once that version serves, the records move to it
 * and the configuration it replaced is kept as superseded, so a rollback to
 * this change's snapshot still binds a live one. Configurations an earlier
 * change superseded are deleted once the new version serves, since this
 * change's snapshot is then the latest (./reconfigure/hyperdrive.ts).
 *
 * Turning Cloudflare Access protection on or off (`access`) runs here too,
 * since the app's settings may be filled in with it (`{{accessAud}}` and
 * the other two): on, the app is protected before step 2, so the version
 * deployed carries the new values; off, the protection is removed after
 * step 6, once the serving version carries them empty. Steps 2 to 6 then
 * run only when a setting uses them (`refreshVars: ["access"]`), and the
 * live health check always follows.
 *
 * Steps 2 to 6 run only when settings, secrets or connections change: Email Routing rules
 * name the Worker, not a version, so moving email alone deploys nothing. A
 * move whose removal of the old routes failed is finished by asking for the
 * same zone again: the new zone is set up again (idempotent) and whatever
 * other zones still have records is removed. When the job fails after it
 * patched secrets and before promoting, it puts the serving version's
 * secrets back on the newest version (./reconfigure/secrets.ts).
 *
 * Subrequests in the job's own invocation: about 20 plus one bookmark per
 * D1 database and the probes (up to 6 for the canary, 12 for the live
 * check): the settings and the snapshot come from D1, the assets are already
 * stored in the account (one session call), the version upload is one unit
 * call, and every secret change rides on one list and one patch. Moving
 * Email Routing adds its inspection (one unit call) and one to four requests
 * per rule on each zone.
 *
 * The install is `updating` while the job runs and returns to `installed`
 * whatever happens. Nothing the app serves changes before the promotion; a
 * failure after it records what serves.
 */

export const reconfigureJobParams = z.object({
  kind: z.literal("reconfigure"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  /**
   * Every setting the admin changed from its default: the install's next
   * `config_json`. Settings are not secret; they are shown on the app page.
   */
  vars: z.record(z.string(), z.string()),
  /**
   * New secret values and names to remove. VALUES live only here (Workflows
   * stores params encrypted at rest); `jobs.input_json` keeps the names.
   */
  secrets: secretChangesSchema,
  /**
   * New connection strings by Hyperdrive binding. Credentials, like secret
   * values: they live only here. Optional; a job started by an earlier
   * manager version carries none.
   */
  hyperdrive: connectionChangesSchema.optional(),
  /** The zone the app should receive email for instead of the current one. */
  emailRouting: emailRoutingJobInput.optional(),
  /** The admin accepted that the new settings cannot be checked on a preview first. */
  confirmNoPreview: z.boolean().optional(),
  /**
   * Deploy the settings again although none changed: the values they are
   * filled in with that changed (`wildcardHostname`: the wildcard domain was
   * assigned or removed; `appUrl`: the address the app is served at moved
   * between workers.dev and a domain). `vars` are the stored settings,
   * unchanged.
   */
  refreshVars: z.array(z.enum(VARS_REFRESH_REASONS)).min(1).optional(),
  /**
   * Turn Cloudflare Access protection of the app on or off. On: the app is
   * protected first, then (with `refreshVars: ["access"]`, when its settings
   * use the Access placeholders) deployed again with the new values. Off:
   * deployed again first with the values empty (an app that checks them
   * then refuses everyone rather than trusting anything), then its
   * protection is removed. Refused for an app whose catalog entry requires
   * protection. Optional; a job started by an earlier version has none.
   */
  access: z.enum(["on", "off"]).optional(),
  /**
   * A self-deploying tier app: its own installer runs again with the new
   * settings (see ./self-deploying/reconfigure.ts); none of the steps below apply.
   */
  selfDeploying: z.boolean().optional(),
  /** For a self-deploying app: the admin confirmed the cost of running its installer. */
  buildConfirmed: z.boolean().optional(),
});
export type ReconfigureJobParams = z.infer<typeof reconfigureJobParams>;

/**
 * What the install records once the new version serves: the version, the
 * settings, and the secrets it has. Written by the job's record step, and
 * again when a later step fails; every write converges.
 */
async function recordSettings(
  orm: Database,
  target: {
    installId: string;
    versionId: string;
    vars: Readonly<Record<string, string>>;
    secrets: SecretChanges;
    at: Date;
    /**
     * An app of several Workers: the versions its other Workers now serve, by
     * Worker name (null: not known).
     */
    otherVersions?: Readonly<Record<string, string | null>>;
  },
): Promise<void> {
  const { installId, at } = target;
  await orm
    .update(installs)
    .set({
      current_version_id: target.versionId,
      config_json: storedVarsJson(target.vars),
      ...(target.otherVersions === undefined || Object.keys(target.otherVersions).length === 0
        ? {}
        : { worker_versions_json: mergedWorkerVersions(target.otherVersions) }),
      updated_at: at,
    })
    .where(eq(installs.id, installId));
  for (const name of Object.keys(target.secrets.set)) {
    await orm
      .insert(resources)
      .values({
        id: resourceId(installId, "secret", name),
        install_id: installId,
        kind: "secret",
        binding: name,
        name,
        cf_id: null,
        created_at: at,
      })
      .onConflictDoUpdate({
        target: resources.id,
        set: { deleted_at: null, retained_at: null },
      });
  }
  if (target.secrets.unset.length > 0) {
    await orm
      .update(resources)
      .set({ deleted_at: at })
      .where(
        and(
          eq(resources.install_id, installId),
          eq(resources.kind, "secret"),
          inArray(resources.name, target.secrets.unset),
          isNull(resources.deleted_at),
        ),
      );
  }
}

/** What the failure report says about new secret values the job had put on an unpromoted version. */
function secretsNote(undo: "undone" | "not-needed" | "left" | "failed" | null): string {
  switch (undo) {
    case "undone":
      return " The Worker's newest version has the previous secret values back, so the next update does not pick up the new ones.";
    case "left":
      return " Another version was uploaded meanwhile; it keeps whatever secrets it was given.";
    case "failed":
      return " Appflare could not give the Worker's newest version the previous secret values back: the next update would carry the new ones. Save the settings again, or set the secrets back, before updating.";
    default:
      return "";
  }
}

/**
 * What a failed change of Cloudflare Access protection left, or null when
 * there is nothing to add: protection made but the settings not deployed
 * with its values (an app that checks them refuses everyone until they
 * are), or the settings deployed without the values but the protection not
 * removed (the same, until it is turned off again).
 */
export function accessFailureNote(
  access: "on" | "off" | undefined,
  reached: "protected" | "unprotected" | null,
  deployed: boolean,
): string | null {
  if (access === "on" && reached === "protected" && !deployed) {
    return "The app is protected with Cloudflare Access now, but its settings were not deployed again with the Access values; an app that checks them turns everyone away until they are. Turn protection on again to finish.";
  }
  if (access === "off" && reached === null && deployed) {
    return "The app's settings no longer carry its Access values, but its protection was not removed, so an app that checks them turns everyone away. Turn protection off again to finish.";
  }
  return null;
}

export async function runReconfigure(ctx: JobContext): Promise<void> {
  const parsed = reconfigureJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid reconfigure job payload");
  const params = parsed.data;
  if (params.selfDeploying === true) {
    await runSelfDeployingReconfigure(ctx, params);
    return;
  }
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  const secretsChange = changesSecrets(params.secrets);
  /** New connection strings by Hyperdrive binding; read only where a configuration is made. */
  const connections = params.hyperdrive ?? {};
  const replacing = Object.keys(connections).sort();
  /** Configurations made from the new connection strings, as they are created. */
  const replacements: ConnectionReplacement[] = [];
  /** Set once the new version exists / serves traffic, for the failure report. */
  let uploadedVersionId: string | null = null;
  let servingVersionId: string | null = null;
  /** The version that served before the job (from its snapshot), and the job's own upload. */
  let snapshotVersionId: string | null = null;
  let ownUploadId: string | null = null;
  /** What undoing unpromoted secret changes needs, once the plan is known. */
  let undoContext: { slots: SecretSlot[]; workerName: string; changes: SecretChanges } | null =
    null;
  /** The removal of the old zone's email routes began (a failure leaves a move to finish). */
  let emailMoveStarted = false;
  /** How far a change of Cloudflare Access protection got, for the failure report. */
  let accessChanged: "protected" | "unprotected" | null = null;
  /**
   * An app of several Workers: its other Workers that got a new version with
   * secret changes, for a failure before their promotion to put them back.
   */
  const othersPatched: Array<{
    workerName: string;
    label: string;
    uploadedVersionId: string;
    servingVersionId: string;
    changes: SecretChanges;
  }> = [];
  const promotedOthers: string[] = [];
  /** The other Workers whose promotion started, and the version each serves once promoted. */
  const attemptedOthers: string[] = [];
  const promotedVersions: Record<string, string> = {};
  /** The version each changed other Worker served when the snapshot was taken. */
  let snapshotOthers: Record<string, string> = {};

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const [install] = await orm
        .select()
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      if (install.status !== "updating") {
        throw new JobError(`the install is ${install.status}, not being changed`);
      }
      if (install.build_kind === "self-deploying") {
        throw new JobError(
          "the app is deployed by its own installer; its installer applies settings",
        );
      }
      if (install.manifest_json === null) {
        throw new JobError("the install has no recorded artifact manifest to deploy again");
      }
      const digest = await sha256Hex(new TextEncoder().encode(install.manifest_json));
      if (install.artifact_digest !== null && digest !== install.artifact_digest) {
        throw new JobError(
          "the recorded artifact manifest does not match its recorded digest; update or reinstall the app instead",
        );
      }
      // The newest revision of the release's form this manager verified, read
      // once here so every replay of the job uses the same one.
      const signed = artifactManifestSchema.safeParse(JSON.parse(install.manifest_json));
      const effective = signed.success ? await effectiveManifest(orm, signed.data, digest) : null;
      const revisedCatalog =
        signed.success && effective !== null && effective.catalog !== signed.data.catalog
          ? effective.catalog
          : null;
      const rows = await orm
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            isNull(resources.retained_at),
          ),
        )
        // Insertion order: it decides which zone's email records are newest.
        .orderBy(sql`rowid`);
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Changing the settings of ${install.app_slug} ${install.catalog_version} on Worker "${install.worker_name}"; the code stays as it is.`,
      );
      return {
        accountId: settings.account_id,
        slug: install.app_slug,
        workerName: install.worker_name,
        version: install.catalog_version,
        recordedVersionId: install.current_version_id,
        appliedDoTag: install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
        vectorizeShapes: vectorizeShapesOf(install.manifest_json),
        digest,
        revisedCatalog,
        zipUrl: install.artifact_url,
        sandboxBuild: install.build_kind === "sandbox",
        storedVars: parseStoredVars(install.config_json),
        workersDev: install.workers_dev_enabled,
        servedDomain: install.served_domain,
        // The app's domains, live ones first, for where it is reached below.
        domains: domainHostnames(rows) as string[] | undefined,
        // What `{{wildcardHostname}}` becomes (absent in a step output recorded before it existed).
        wildcardHostname: wildcardHostnameOf(rows) as string | null | undefined,
        // What the Access placeholders become; null when the app is not protected
        // (absent in a step output recorded before they existed).
        access: (await readAccessPlaceholderValues(orm, params.installId)) as
          | AccessPlaceholderValues
          | null
          | undefined,
        // Whether the signed catalog entry requires protection (`access.mode`).
        accessRequired: signed.success && accessOfferOf(signed.data.catalog) === "required",
        resources: rows
          .filter((r) => r.kind !== EMAIL_ROUTE_KIND)
          .map(
            (r): RecordedResource => ({
              id: r.id,
              kind: r.kind,
              binding: r.binding,
              name: r.name,
              cfId: r.cf_id,
            }),
          ),
        emailRoutes: rows
          .filter((r) => r.kind === EMAIL_ROUTE_KIND)
          .map((r): EmailRouteRecord & { createdAt: number } => ({
            id: r.id,
            name: r.name,
            cfId: r.cf_id,
            createdAt: r.created_at.getTime(),
          })),
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName, workersDev } = started;

    // The manifest the install recorded, read again outside the step (step
    // results are kept small) and held to the digest the step checked.
    steps.current = "load recorded manifest";
    const [recorded] = await createDb(env.DB)
      .select({ manifestJson: installs.manifest_json })
      .from(installs)
      .where(eq(installs.id, params.installId))
      .limit(1);
    const manifestText = recorded?.manifestJson ?? null;
    if (
      manifestText === null ||
      (await sha256Hex(new TextEncoder().encode(manifestText))) !== started.digest
    ) {
      throw new JobError("the recorded artifact manifest changed while the job ran");
    }
    const signed: ArtifactManifest = artifactManifestSchema.parse(JSON.parse(manifestText));
    // The signed Worker, with the form of the revision the start step read.
    const manifest =
      started.revisedCatalog === null ? signed : withRevisedCatalog(signed, started.revisedCatalog);
    const host: ArtifactHost = started.sandboxBuild ? { kind: "sandbox" } : { kind: "catalog" };
    // An app of several Workers: the primary one is the install's Worker; the
    // others get a new version only when a changed setting or secret goes to
    // them, and are promoted before it.
    const workers = entryWorkers(manifest, workerName);
    const primary = workers.find((w) => w.primary);
    if (primary === undefined) throw new JobError("the artifact has no primary Worker");
    const primaryManifest = primary.manifest;
    const entryNames = entryScriptNamesOf(manifest, workerName);
    const databases = hyperdriveDeclarations(manifest.catalog.resources?.hyperdrive);
    const diff = diffBindings(
      workerName,
      entryBindings(manifest),
      started.resources,
      started.vectorizeShapes,
      databases,
      manifest.catalog.resources?.pipelines,
    );
    // The installed version itself: its exports are the serving ones.
    const path = updatePath(primaryManifest, started.appliedDoTag, primaryManifest.worker.exports);
    const slots = secretSlots(
      manifest.catalog.secrets,
      started.resources.filter((r) => r.kind === "secret").map((r) => r.name),
    );
    const emailConfig = manifest.catalog.install.emailRouting;
    const zones = emailZones(started.emailRoutes);
    const currentZone = zones.current;
    /** The zone the app should receive email for, when the change names one. */
    const targetZoneId = params.emailRouting?.zoneId ?? null;
    const movesEmail = targetZoneId !== null && targetZoneId !== currentZone?.zoneId;
    /**
     * Records on other zones than the target, removed once the target is set
     * up: the zone moved away from, and what an unfinished move left behind.
     */
    const oldRoutes =
      targetZoneId === null
        ? []
        : started.emailRoutes.filter((r) => emailRouteZoneId(r.cfId) !== targetZoneId);
    /**
     * The zone to set up: the target of a move, or of a move being finished
     * (setting up is idempotent, and a move may have stopped part way through
     * setting it up; nothing is removed before it is complete).
     */
    const newZoneId = movesEmail || oldRoutes.length > 0 ? targetZoneId : null;
    const changedVars = changedVarNames(started.storedVars, params.vars);
    /**
     * Only settings, secrets and database connections need a new version;
     * Email Routing names the Worker, not a version.
     */
    const refreshed = params.refreshVars ?? [];
    const refresh = refreshed.length > 0;
    const redeploy = changedVars.length > 0 || secretsChange || replacing.length > 0 || refresh;
    // Each Worker gets the secret changes of the secrets that go to it; a
    // secret the catalog no longer declares is the primary Worker's.
    const declaredSecrets = new Set(manifest.catalog.secrets.map((s) => s.name));
    const secretsOf = (w: (typeof workers)[number]) => {
      const own = new Set(w.manifest.catalog.secrets.map((s) => s.name));
      return secretChangesFor(
        params.secrets,
        [...Object.keys(params.secrets.set), ...params.secrets.unset].filter(
          (name) => own.has(name) || (w.primary && !declaredSecrets.has(name)),
        ),
      );
    };
    const primaryChanges = secretsOf(primary);
    const primarySecretsChange = changesSecrets(primaryChanges);
    const changedSecrets = [...Object.keys(params.secrets.set), ...params.secrets.unset];
    const affectedOthers = workers.filter(
      (w) =>
        !w.primary &&
        (varsNeedRefresh(w.manifest, params.vars, refreshed) ||
          changedVars.some((n) => w.manifest.catalog.vars.some((v) => v.name === n)) ||
          changedSecrets.some((n) => w.manifest.catalog.secrets.some((s) => s.name === n))),
    );
    /** The recorded configuration each replaced connection's binding uses now. */
    const currentConfigs = new Map(
      started.resources
        .filter((r) => r.kind === HYPERDRIVE_KIND && r.binding !== null && r.cfId !== null)
        .map((r) => [r.binding, { rowId: r.id, name: r.name, cfId: r.cfId as string }]),
    );
    /** Configurations an earlier change superseded: deleted once this change serves. */
    const supersededAtStart = supersededConfigs(started.resources);
    undoContext = {
      slots,
      workerName,
      changes: primaryChanges,
    };
    const healthPath = manifest.catalog.install.health.path;
    const healthMode = manifest.catalog.install.health.mode;

    await run("plan settings change", async ({ log }) => {
      const problems = [
        ...diff.problems,
        ...secretChangeProblems(params.secrets, slots),
        // Names the binding and the part at fault, never the string.
        ...connectionStringProblems(databases, connections, { required: false }),
      ];
      for (const binding of replacing) {
        if (databases.some((d) => d.binding === binding) && !currentConfigs.has(binding)) {
          problems.push(
            `Appflare has no record of the Hyperdrive configuration ${binding} uses; reinstall the app to connect it.`,
          );
        }
      }
      // A settings change creates nothing: every binding that needs a resource
      // must have one recorded. (Workflows and Durable Object classes belong
      // to the script and come with the upload, as an update treats them.)
      const missing = diff.toCreate.map((r) => r.binding);
      if (missing.length > 0) {
        problems.push(
          `The installed version binds ${missing.join(", ")}, which Appflare has no record of; update or reinstall the app instead.`,
        );
      }
      if (path.fullDeploy !== null) {
        problems.push(
          `The Worker lacks Durable Object migrations up to "${path.fullDeploy.new_tag}" that its version declares; update or reinstall the app instead.`,
        );
      }
      if (redeploy && path.skipPreview !== null && params.confirmNoPreview !== true) {
        problems.push(
          `${path.skipPreview}. Confirm saving without that check to change the settings.`,
        );
      }
      if (started.sandboxBuild && sandboxBinding(env) === undefined) {
        problems.push(
          `This app was built in the account's sandbox Worker, and Appflare is not connected to it; connect sandbox builds in ${ENABLE_SANDBOX_PLACE} to read the stored build.`,
        );
      }
      if (params.emailRouting !== undefined && emailConfig === undefined) {
        problems.push("This app does not receive email; it takes no zone.");
      }
      for (const w of workers) {
        const tooBig = workerUploadProblem(
          w.manifest.worker.modules,
          w.primary ? "This version" : `The Worker "${w.name}" of this version`,
        );
        if (tooBig !== null) problems.push(tooBig);
      }
      if (params.access === "off" && started.accessRequired === true) {
        problems.push(accessRequiredOffRefusal(manifest.catalog.name));
      }
      if (
        !redeploy &&
        newZoneId === null &&
        oldRoutes.length === 0 &&
        params.access === undefined
      ) {
        problems.push(
          "Nothing changes: the settings, secrets, database connections and email zone are as they are.",
        );
      }
      if (problems.length > 0) throw new JobError(problems.join(" "));
      if (changedVars.length > 0) log.info(`Settings changed: ${changedVars.join(", ")}.`);
      if (refreshed.includes("wildcardHostname")) {
        log.info(
          `Settings that use {{wildcardHostname}} are filled in again: ${started.wildcardHostname ? started.wildcardHostname : "empty, since the app has no wildcard domain now"}.`,
        );
      }
      if (params.access === "on") {
        log.info(
          "Turning Cloudflare Access protection on: the app is protected first, then its settings that use the Access values are deployed again with them.",
        );
      } else if (params.access === "off") {
        log.info(
          "Turning Cloudflare Access protection off: settings that use the Access values are deployed again with them empty first, then the protection is removed.",
        );
      }
      if (refreshed.includes("appUrl")) {
        log.info(
          `Settings that use the app's address ({{appUrl}}) are filled in again with ${started.workersDev ? "its workers.dev URL, since workers.dev serves it now" : "the domain that serves it now"}.`,
        );
      }
      const set = Object.keys(params.secrets.set).sort();
      if (set.length > 0) log.info(`Secrets with a new value: ${set.join(", ")}.`);
      if (params.secrets.unset.length > 0) {
        log.info(`Secrets to remove: ${[...params.secrets.unset].sort().join(", ")}.`);
      }
      if (replacing.length > 0) {
        log.info(
          `Database connections to replace: ${replacing.join(", ")}. A new Hyperdrive configuration is made for each, and the old one is deleted once the new version serves.`,
        );
      }
      if (movesEmail) {
        log.info(
          `Email moves from ${currentZone?.zoneName ?? "no zone"} to the zone ${newZoneId}; the new routes are set up before the old ones are removed.`,
        );
      } else if (oldRoutes.length > 0) {
        log.info(
          `Finishing a move of email to ${currentZone?.zoneName ?? targetZoneId}: removing the routes left on ${[...new Set(zones.leftover.map((z) => z.zoneName))].join(", ")}.`,
        );
      }
      if (redeploy) {
        log.info(
          started.sandboxBuild
            ? `The build of ${started.version} the sandbox Worker stored is deployed again; nothing is built.`
            : `The signed release of ${started.version} is deployed again.`,
        );
      } else if (params.access !== undefined) {
        log.info("No setting uses the Access values; the Worker is not deployed again.");
      } else {
        log.info("Only Email Routing changes; the Worker is not deployed again.");
      }
      return {};
    });

    // A new zone is inspected before anything changes, as an install does.
    const emailInspection =
      newZoneId === null || emailConfig === undefined
        ? null
        : await checkEmailRoutingPhase(steps, {
            zoneId: newZoneId,
            config: emailConfig,
            workerName,
          });

    const subdomain = await lookupSubdomainPhase(steps);
    // Where the app is served, for `{{appUrl}}` and the health check.
    const appBase = appBaseUrl({
      workerName,
      subdomain,
      workersDev,
      // A step output recorded before `domains` existed has only the resources.
      domains: started.domains ?? domainHostnames(started.resources),
      served: started.servedDomain,
    });
    const url = `${appBase}${healthPath}`;

    // Protection on comes first, so the version deployed below carries the
    // audience tag and team domain it now has. Protection off comes last.
    let accessNow = started.access ?? null;
    if (params.access === "on") {
      accessNow = accessPlaceholderValues(await protectInstalledPhase(steps, params.installId));
      accessChanged = "protected";
    } else if (params.access === "off") {
      accessNow = null;
    }

    if (redeploy) {
      // Snapshot, before anything changes (the settings before the change included).
      const snapshot = await takeSnapshotPhase(steps, {
        // What the serving version's Access values were filled in with, before this job.
        accessAud: started.access === undefined ? null : (started.access?.aud ?? ""),
        installId: params.installId,
        jobId: params.jobId,
        workerName,
        recordedVersionId: started.recordedVersionId,
        resources: started.resources,
        appliedDoTag: started.appliedDoTag,
        targetVersion: started.version,
        otherWorkers: affectedOthers,
      });
      snapshotVersionId = snapshot.versionId;
      snapshotOthers = snapshot.otherVersions;

      // A new Hyperdrive configuration per replaced connection string, made
      // (and so checked by Cloudflare against the database) before the
      // version that binds it is uploaded; the old one keeps serving.
      for (const binding of replacing) {
        const current = currentConfigs.get(binding);
        const decl = databases.find((d) => d.binding === binding);
        if (current === undefined || decl === undefined) continue;
        replacements.push(
          await createReplacementPhase(steps, {
            installId: params.installId,
            jobId: params.jobId,
            workerName,
            binding,
            protocol: decl.protocol,
            current,
            connection: connections[binding],
          }),
        );
      }
      const bound = diff.existing.map((res) => {
        const replaced = replacements.find((r) => r.binding === res.binding);
        return res.type === "hyperdrive" && replaced !== undefined
          ? { ...res, name: replaced.next.name, cfId: replaced.next.cfId }
          : res;
      });

      const rateLimitIds = await assignRateLimitsPhase(
        steps,
        params.installId,
        entryBindings(manifest),
      );
      // Cloudflare keeps assets account-wide by hash, so the files the version
      // already uses are not uploaded again; the session still yields the
      // completion token the upload needs.
      const assetsJwt = await uploadAssetsPhase(
        steps,
        workerName,
        started.zipUrl,
        primaryManifest.assets.files,
        host,
      );
      const placeholders = entryPlaceholders(manifest, workerName, subdomain, appBase);
      const vars = installVars(primaryManifest, params.vars, {
        workerName,
        subdomain,
        accountId: steps.accountId(),
        appUrl: appBase,
        wildcardHostname: started.wildcardHostname ?? null,
        access: accessNow,
        ...(placeholders === undefined ? {} : { entryWorkers: placeholders }),
      });

      // The other Workers the change reaches: a version each, checked, not serving yet.
      const entryContext: EntryUploadContext = {
        installId: params.installId,
        installWorkerName: workerName,
        source: { zipUrl: started.zipUrl, host },
        resources: diff.existing,
        workflowNames: diff.workflowNames,
        rateLimitIds,
        userVars: params.vars,
        subdomain,
        accountId: steps.accountId(),
        appUrl: appBase,
        wildcardHostname: started.wildcardHostname ?? null,
        access: accessNow,
        placeholders,
        entryNames,
      };
      const otherVersions: OtherWorkerUpdate[] = [];
      for (const w of affectedOthers) {
        const changes = secretsOf(w);
        const made = await reconfigureOtherWorkerPhase(steps, step, entryContext, w, {
          changes,
          slug: started.slug,
          version: started.version,
          jobId: params.jobId,
          canaryAttempts: CANARY_MAX_ATTEMPTS,
        });
        const serving = snapshot.otherVersions[w.scriptName];
        if (made.secretsPatched && serving !== undefined) {
          othersPatched.push({
            workerName: w.scriptName,
            label: workerLabel(w),
            uploadedVersionId: made.uploadedVersionId,
            servingVersionId: serving,
            changes,
          });
        }
        otherVersions.push(made);
      }

      const uploaded = await run("upload Worker version", async ({ log }) => {
        for (const warning of vars.warnings) log.warn(warning);
        const { migrations: _none, ...base } = buildScriptMetadata({
          manifest: primaryManifest,
          workerName,
          resources: bound,
          vars: vars.vars,
          assetsJwt,
          workflowNames: diff.workflowNames,
          rateLimitIds,
          entryWorkers: entryNames,
        });
        const metadata: VersionMetadata = {
          ...base,
          // The secrets are the only bindings carried over; everything else is sent above.
          keep_bindings: ["secret_text"],
          annotations: {
            "workers/message": `Appflare: settings of ${started.slug} ${started.version}`,
            "workers/tag": started.version,
          },
        };
        const result = settleUnit(
          await steps.units.api.uploadWorker({
            accountId: steps.accountId(),
            artifact: { zipUrl: started.zipUrl, host },
            workerName,
            modules: primaryManifest.worker.modules,
            metadata,
            target: "version",
          }),
          log,
        );
        if (result.versionId === null) {
          throw new JobError("Cloudflare did not report the id of the uploaded version");
        }
        log.info(
          `Uploaded version ${result.versionId} with the new settings (${result.modules} module(s)); it serves no traffic yet.`,
          {
            versionId: result.versionId,
            bindings: (metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`),
          },
        );
        return { versionId: result.versionId, hasPreview: result.hasPreview };
      });
      uploadedVersionId = uploaded.versionId;
      ownUploadId = uploaded.versionId;
      await run("record Worker version", async ({ orm }) => {
        await orm
          .update(jobs)
          .set({ worker_version_id: uploaded.versionId })
          .where(eq(jobs.id, params.jobId));
        return {};
      });

      // Secrets go on a version of their own, made from the upload, before
      // anything serves either.
      const final = primarySecretsChange
        ? await applySecretChangesPhase(steps, {
            jobId: params.jobId,
            workerName,
            uploadedVersionId: uploaded.versionId,
            version: started.version,
            changes: primaryChanges,
          })
        : { versionId: uploaded.versionId };
      uploadedVersionId = final.versionId;

      const skip = path.skipPreview ?? canarySkipReason(uploaded.hasPreview, 0);
      if (skip !== null) {
        await run("skip canary", async ({ log }) => {
          log.warn(`${skip}.`);
          return {};
        });
      } else {
        await run("enable version previews", async ({ log, cf }) => {
          // The workers.dev URL stays as the admin left it; previews are always on.
          await cf().workers.enableSubdomain(workerName, workersDevSubdomain(workersDev));
          log.info("Preview URLs are enabled for this Worker.");
          return {};
        });
        await probeUntilHealthy(steps, step, {
          label: "canary",
          url: previewUrl(final.versionId, workerName, subdomain, healthPath),
          healthyMessage: `version ${final.versionId} is serving with the new settings`,
          maxAttempts: CANARY_MAX_ATTEMPTS,
          expectVersion: started.version,
          mode: healthMode,
          installId: params.installId,
        });
      }

      // The other Workers first, the primary one last.
      for (const other of otherVersions) {
        attemptedOthers.push(other.worker.scriptName);
        promotedVersions[other.worker.scriptName] = await promoteOtherWorkerPhase(
          steps,
          entryContext,
          other,
          started.version,
          "Appflare: settings change",
        );
        promotedOthers.push(other.worker.scriptName);
      }

      await run("promote version", async ({ log, cf }) => {
        await cf().versions.createDeployment(workerName, {
          versions: [{ version_id: final.versionId, percentage: 100 }],
          annotations: { "workers/message": "Appflare: settings change" },
        });
        log.info(`Version ${final.versionId} now serves all traffic.`);
        return {};
      });
      servingVersionId = final.versionId;

      await run("record settings", async ({ log, orm }) => {
        await recordSettings(orm, {
          installId: params.installId,
          versionId: final.versionId,
          vars: params.vars,
          secrets: params.secrets,
          at: new Date(now()),
          otherVersions: promotedVersions,
        });
        log.info("Recorded the new settings and secret names on the install.");
        return {};
      });

      // The new version binds the new configurations: record that. The ones
      // they replaced are kept as superseded, since this change's snapshot
      // binds them and a rollback to it must still reach the database.
      if (replacements.length > 0) {
        await run("record database connections", async ({ log, orm }) => {
          await switchConnectionRecords(orm, params.installId, replacements);
          log.info(
            `Recorded the new Hyperdrive configurations: ${replacements.map((r) => `${r.binding} uses "${r.next.name}"`).join(", ")}. The replaced ${replacements.map((r) => `"${r.old.name}"`).join(", ")} stay until the next update or settings change, so rolling back to the previous version still reaches its database.`,
          );
          return {};
        });
      }
      // This change's snapshot is the latest now: configurations an earlier
      // change superseded are bound only by older versions.
      await deleteSupersededPhase(steps, supersededAtStart);

      // A new token for a Pipelines sink: the version that has it serves now.
      for (const res of diff.plan.resources) {
        if (res.type !== "pipelines") continue;
        const token = params.secrets.set[res.pipeline.declared.sink.tokenSecret];
        if (token !== undefined) await newSinkTokenPhase(steps, res, token);
      }
    }

    // Protection off, once no version the app serves carries its values.
    if (params.access === "off") {
      await unprotectPhase(steps, params.installId);
      accessChanged = "unprotected";
    }

    // Email Routing: the new zone's routes first, so mail is never unrouted,
    // then the other zones' are removed as an uninstall removes them. If a
    // removal fails, the new zone is recorded as newest, so the app page
    // offers to finish the move, which removes only what is left.
    if (emailInspection !== null) {
      const zoneId = emailInspection.zoneId;
      await run("clear removed email records of the zone", async ({ orm }) => {
        // A zone the app received email for before has records marked
        // deleted under the same ids; setting it up again records them anew.
        const gone = await orm
          .select({ id: resources.id, cfId: resources.cf_id })
          .from(resources)
          .where(
            and(
              eq(resources.install_id, params.installId),
              eq(resources.kind, EMAIL_ROUTE_KIND),
              isNotNull(resources.deleted_at),
            ),
          );
        const ids = gone.filter((r) => emailRouteZoneId(r.cfId) === zoneId).map((r) => r.id);
        if (ids.length > 0) await orm.delete(resources).where(inArray(resources.id, ids));
        return {};
      });
      await provisionEmailRoutingPhase(steps, params.installId, emailInspection, workerName);
    }
    if (oldRoutes.length > 0) {
      emailMoveStarted = true;
      await removeEmailRoutesPhase(steps, oldRoutes, workerName);
    }

    // Recorded rather than fatal, as an update's: the new version serves. The
    // app's URL was serving before this job, so a plain 404 is the app's own
    // answer (a setting such as a 404 home page), not a route going live.
    const health =
      redeploy || params.access !== undefined
        ? await checkLiveHealthPhase(steps, step, url, healthMode, {
            routeWasLive: true,
            installId: params.installId,
          })
        : null;

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            ...(health === null ? {} : healthColumns(health, new Date(health.checkedAt))),
            updated_at: at,
          })
          .where(and(eq(installs.id, params.installId), eq(installs.status, "updating"))),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      log.info(
        health === null
          ? `Changed where ${started.slug} receives email.`
          : params.access !== undefined
            ? `Turned Cloudflare Access protection of ${started.slug} ${params.access} at ${url} (health: ${healthLabel(health)}).`
            : `Changed the settings of ${started.slug} at ${url} (health: ${healthLabel(health)}).`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    const version = uploadedVersionId;
    const serving = servingVersionId;
    // Unpromoted new secret values on the Worker's newest version would ride
    // along with its next upload (see ./reconfigure/secrets.ts): put the
    // serving version's back first.
    let secretsUndo: "undone" | "not-needed" | "left" | "failed" | null = null;
    if (
      serving === null &&
      undoContext !== null &&
      changesSecrets(undoContext.changes) &&
      snapshotVersionId !== null &&
      ownUploadId !== null
    ) {
      try {
        secretsUndo = await undoSecretChangesPhase(steps, {
          jobId: params.jobId,
          workerName: undoContext.workerName,
          uploadedVersionId: ownUploadId,
          servingVersionId: snapshotVersionId,
          changes: undoContext.changes,
          slots: undoContext.slots,
        });
      } catch {
        secretsUndo = "failed";
      }
    }
    // The same for each other Worker whose new version was not promoted.
    for (const other of othersPatched) {
      if (promotedOthers.includes(other.workerName) || undoContext === null) continue;
      try {
        await undoSecretChangesPhase(steps, {
          jobId: params.jobId,
          workerName: other.workerName,
          uploadedVersionId: other.uploadedVersionId,
          servingVersionId: other.servingVersionId,
          changes: other.changes,
          slots: undoContext.slots,
          label: other.label,
        });
      } catch {
        // Reported with the primary Worker's outcome below; nothing serves the values.
      }
    }
    // Configurations made from new connection strings that never served are
    // deleted again; after the promotion the new ones serve, and the ones
    // they replaced are recorded as superseded, as on success.
    let unusedConfigs: "removed" | "left" | null = null;
    if (serving === null && replacements.length > 0) {
      try {
        for (const r of replacements) {
          await deleteConfigPhase(steps, r.next, ", made for this change, which never served");
        }
        unusedConfigs = "removed";
      } catch {
        unusedConfigs = "left";
      }
    }
    const switched = serving !== null ? [...replacements] : [];
    const moveEmail = emailMoveStarted;
    // The primary Worker still serves the previous settings: the other
    // Workers whose promotion started go back to the versions the snapshot
    // kept (one deployment call each, harmless when repeated).
    const othersLeft: Record<string, string | null> = {};
    if (serving === null) {
      for (const name of attemptedOthers) {
        const back = snapshotOthers[name];
        try {
          if (back === undefined) throw new Error("the snapshot has no version of it");
          await deployOtherWorkerVersionPhase(
            steps,
            { primary: false, scriptName: name },
            back,
            "the previous settings",
          );
        } catch {
          othersLeft[name] = promotedVersions[name] ?? null;
        }
      }
    }
    const othersRecorded = serving !== null ? promotedVersions : othersLeft;
    await step.do("mark settings change failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      // The new version serves: the record says so even if the step that
      // writes it is the one that failed.
      if (serving !== null) {
        await recordSettings(orm, {
          installId: params.installId,
          versionId: serving,
          vars: params.vars,
          secrets: params.secrets,
          at,
          otherVersions: othersRecorded,
        });
        // The serving version binds the new configurations.
        await switchConnectionRecords(orm, params.installId, switched);
      } else if (Object.keys(othersRecorded).length > 0) {
        // Other Workers left on the new settings: a rollback to the snapshot puts them back.
        await orm
          .update(installs)
          .set({ worker_versions_json: mergedWorkerVersions(othersRecorded) })
          .where(eq(installs.id, params.installId));
      }
      await orm
        .update(installs)
        .set({ status: "installed", updated_at: at })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      if (moveEmail) {
        log.error(
          `Settings change failed at "${failedAt}" while removing the old zone's email routes. The new zone already receives the app's email; finish the move under ${appPlace(params.installId, "email-zone", "Email in the app's settings")} to remove what is left.${serving === null ? "" : ` Version ${serving} serves all traffic with the new settings, and they are recorded.`}`,
          serving === null ? undefined : { versionId: serving },
        );
      } else if (serving !== null) {
        log.error(
          `Settings change failed at "${failedAt}" after version ${serving} was promoted: it serves all traffic with the new settings, and they are recorded. Roll back from ${appPlace(params.installId, "versions", "the app's versions")} if the app misbehaves.`,
          { versionId: serving },
        );
      } else if (version !== null) {
        log.error(
          `Settings change failed at "${failedAt}". Version ${version} was uploaded but never promoted; the previous version keeps serving all traffic with the previous settings and secrets.${secretsNote(secretsUndo)}`,
          { versionId: version },
        );
      } else {
        log.error(
          `Settings change failed at "${failedAt}". Nothing was deployed; the app keeps its previous settings and secrets.`,
        );
      }
      const accessNote = accessFailureNote(params.access, accessChanged, serving !== null);
      if (accessNote !== null) log.warn(accessNote);
      if (unusedConfigs === "left") {
        log.warn(
          `The Hyperdrive configurations made for this change (${replacements.map((r) => r.next.name).join(", ")}) could not all be deleted; they are recorded, and uninstalling the app deletes them.`,
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
