import { NonRetryableError } from "cloudflare:workflows";
import type { VersionMetadata } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  appHealthMode,
  appHealthPath,
  artifactManifestSchema,
  tooManyModulesMessage,
} from "@appflare/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { EMAIL_ROUTE_KIND } from "../installs/resource-kinds";
import { sandboxBinding } from "../sandbox/binding";
import { sha256Hex } from "./install/artifact";
import {
  checkEmailRoutingPhase,
  type EmailRouteRecord,
  emailRoutingJobInput,
  provisionEmailRoutingPhase,
  removeEmailRoutesPhase,
} from "./install/email-routing";
import { healthLabel } from "./install/health";
import { buildScriptMetadata, installVars } from "./install/metadata";
import {
  checkLiveHealthPhase,
  lookupSubdomainPhase,
  probeUntilHealthy,
  resourceId,
  uploadAssetsPhase,
} from "./install/phases";
import { assignRateLimitsPhase } from "./install/rate-limits";
import {
  changedVarNames,
  changesSecrets,
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
 * Steps 2 to 6 run only when settings or secrets change: Email Routing rules
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
  /** The zone the app should receive email for instead of the current one. */
  emailRouting: emailRoutingJobInput.optional(),
  /** The admin accepted that the new settings cannot be checked on a preview first. */
  confirmNoPreview: z.boolean().optional(),
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
  },
): Promise<void> {
  const { installId, at } = target;
  await orm
    .update(installs)
    .set({
      current_version_id: target.versionId,
      config_json: storedVarsJson(target.vars),
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
  /** Set once the new version exists / serves traffic, for the failure report. */
  let uploadedVersionId: string | null = null;
  let servingVersionId: string | null = null;
  /** The version that served before the job (from its snapshot), and the job's own upload. */
  let snapshotVersionId: string | null = null;
  let ownUploadId: string | null = null;
  /** What undoing unpromoted secret changes needs, once the plan is known. */
  let undoContext: { slots: SecretSlot[]; workerName: string } | null = null;
  /** The removal of the old zone's email routes began (a failure leaves a move to finish). */
  let emailMoveStarted = false;

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
        zipUrl: install.artifact_url,
        sandboxBuild: install.build_kind === "sandbox",
        storedVars: parseStoredVars(install.config_json),
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
    const { workerName } = started;

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
    const manifest: ArtifactManifest = artifactManifestSchema.parse(JSON.parse(manifestText));
    const host: ArtifactHost = started.sandboxBuild ? { kind: "sandbox" } : { kind: "catalog" };
    const diff = diffBindings(
      workerName,
      manifest.worker.bindings,
      started.resources,
      started.vectorizeShapes,
    );
    const path = updatePath(manifest, started.appliedDoTag);
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
    /** Only settings and secrets need a new version; Email Routing names the Worker, not a version. */
    const redeploy = changedVars.length > 0 || secretsChange;
    undoContext = {
      slots,
      workerName,
    };
    const healthPath = appHealthPath(manifest.catalog.install);
    const healthMode = appHealthMode(manifest.catalog.install);

    await run("plan settings change", async ({ log }) => {
      const problems = [...diff.problems, ...secretChangeProblems(params.secrets, slots)];
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
          "This app was built in the account's sandbox Worker, and Appflare is not connected to it; connect sandbox builds in Settings to read the stored build.",
        );
      }
      if (params.emailRouting !== undefined && emailConfig === undefined) {
        problems.push("This app does not receive email; it takes no zone.");
      }
      const tooMany = tooManyModulesMessage(manifest.worker.modules.length, "This version");
      if (tooMany !== null) problems.push(tooMany);
      if (!redeploy && newZoneId === null && oldRoutes.length === 0) {
        problems.push("Nothing changes: the settings, secrets and email zone are as they are.");
      }
      if (problems.length > 0) throw new JobError(problems.join(" "));
      if (changedVars.length > 0) log.info(`Settings changed: ${changedVars.join(", ")}.`);
      const set = Object.keys(params.secrets.set).sort();
      if (set.length > 0) log.info(`Secrets with a new value: ${set.join(", ")}.`);
      if (params.secrets.unset.length > 0) {
        log.info(`Secrets to remove: ${[...params.secrets.unset].sort().join(", ")}.`);
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
    const url = `https://${workerName}.${subdomain}.workers.dev${healthPath}`;

    if (redeploy) {
      // Snapshot, before anything changes (the settings before the change included).
      const snapshot = await takeSnapshotPhase(steps, {
        installId: params.installId,
        jobId: params.jobId,
        workerName,
        recordedVersionId: started.recordedVersionId,
        resources: started.resources,
        appliedDoTag: started.appliedDoTag,
        targetVersion: started.version,
      });
      snapshotVersionId = snapshot.versionId;

      const rateLimitIds = await assignRateLimitsPhase(
        steps,
        params.installId,
        manifest.worker.bindings,
      );
      // Cloudflare keeps assets account-wide by hash, so the files the version
      // already uses are not uploaded again; the session still yields the
      // completion token the upload needs.
      const assetsJwt = await uploadAssetsPhase(
        steps,
        workerName,
        started.zipUrl,
        manifest.assets.files,
        host,
      );
      const vars = installVars(manifest, params.vars, { workerName, subdomain });

      const uploaded = await run("upload Worker version", async ({ log }) => {
        for (const warning of vars.warnings) log.warn(warning);
        const { migrations: _none, ...base } = buildScriptMetadata({
          manifest,
          workerName,
          resources: diff.existing,
          vars: vars.vars,
          assetsJwt,
          workflowNames: diff.workflowNames,
          rateLimitIds,
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
            modules: manifest.worker.modules,
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
      const final = secretsChange
        ? await applySecretChangesPhase(steps, {
            jobId: params.jobId,
            workerName,
            uploadedVersionId: uploaded.versionId,
            version: started.version,
            changes: params.secrets,
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
          await cf().workers.enableSubdomain(workerName, { enabled: true, previews_enabled: true });
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
        });
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
        });
        log.info("Recorded the new settings and secret names on the install.");
        return {};
      });
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

    // Recorded rather than fatal, as an update's: the new version serves.
    const health = redeploy ? await checkLiveHealthPhase(steps, step, url, healthMode) : null;

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            ...(health === null
              ? {}
              : {
                  health_status: health.status,
                  health_checked_at: new Date(health.checkedAt),
                }),
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
      secretsChange &&
      undoContext !== null &&
      snapshotVersionId !== null &&
      ownUploadId !== null
    ) {
      try {
        secretsUndo = await undoSecretChangesPhase(steps, {
          jobId: params.jobId,
          workerName: undoContext.workerName,
          uploadedVersionId: ownUploadId,
          servingVersionId: snapshotVersionId,
          changes: params.secrets,
          slots: undoContext.slots,
        });
      } catch {
        secretsUndo = "failed";
      }
    }
    const moveEmail = emailMoveStarted;
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
        });
      }
      await orm
        .update(installs)
        .set({ status: "installed", updated_at: at })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      if (moveEmail) {
        log.error(
          `Settings change failed at "${failedAt}" while removing the old zone's email routes. The new zone already receives the app's email; finish the move from the Settings section of the install page to remove what is left.${serving === null ? "" : ` Version ${serving} serves all traffic with the new settings, and they are recorded.`}`,
          serving === null ? undefined : { versionId: serving },
        );
      } else if (serving !== null) {
        log.error(
          `Settings change failed at "${failedAt}" after version ${serving} was promoted: it serves all traffic with the new settings, and they are recorded. Roll back from the install page if the app misbehaves.`,
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
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
