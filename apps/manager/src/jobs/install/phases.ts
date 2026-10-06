import { Buffer } from "node:buffer";
import {
  buildAssetsManifest,
  CloudflareApiError,
  type CloudflareClient,
  type FetchLike,
} from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type AssetFile,
  type CatalogD1Seed,
  type D1MigrationFile,
  DEFAULT_HEALTH_MODE,
  parseConnectionString,
  type SigningKey,
} from "@appflare/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { MANIFEST_TTL_SECONDS, manifestCacheKey } from "../../catalog/app-manifest.server";
import type { ReleaseAssets } from "../../catalog/release-assets";
import { appPlace } from "../../components/app-links";
import type { Database } from "../../db/client";
import { type RESOURCE_KINDS, resources } from "../../db/schema";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import type { StepRunner } from "../run-job";
import { errorMessage, JobError, type JobSteps } from "../steps";
import { failureError, settleUnit } from "../units/result";
import type { ArtifactHost } from "../units/units";
import { ACCESS_PREVIEW_REASON, activeVersionId, cronChanges } from "../update/plan";
import { fetchWhole, sha256Hex, verifyArtifactManifest } from "./artifact";
import { planAssetParts } from "./asset-parts";
import type { ResourceBindingPlan, WorkflowPlan } from "./bindings";
import { CronLimitError, putSchedulesChecked } from "./cron-limit";
import {
  classifyHealthProbe,
  decideLiveHealth,
  HEALTH_MAX_ATTEMPTS,
  HEALTH_RETRY_DELAY,
  type HealthMode,
  type HealthProbe,
  type HealthSettlement,
  type HealthVerdict,
  isAccessChallenge,
  liveHealthScheduledMs,
  lookupOnce,
  probeThroughAccess,
  versionMismatch,
} from "./health";
import type { CreatedResource } from "./metadata";
import { explainR2Refusal } from "./r2-enablement";
import { configureResourcePhase } from "./resource-settings";
import { createResource, findResource, RESOURCE_LABEL } from "./resources";

/**
 * Step sequences the install and update jobs share: verifying the artifact
 * manifest, creating a resource (check, create, record), uploading static
 * assets, applying D1 migrations, and probing a URL until it serves. Each
 * phase runs through the job's step runner, so step names, retries, and
 * logging behave the same in every job.
 */

/** Where a job finds its artifact: the index entry's URLs and the manifest digest. */
export interface ArtifactRef {
  /** The catalog whose keys verify the release; names its KV cache. Official when omitted. */
  catalogId?: string;
  slug: string;
  version: string;
  artifacts: ReleaseAssets;
  digest: string;
}

/** Stable `resources.id`, so a retried record step never inserts twice. */
export function resourceId(installId: string, kind: string, key: string): string {
  return `${installId}:${kind}:${key}`;
}

export interface ResourceRecord {
  kind: (typeof RESOURCE_KINDS)[number];
  key: string;
  binding: string | null;
  name: string;
  cfId: string | null;
}

export async function recordResource(
  orm: Database,
  installId: string,
  row: ResourceRecord,
  at: Date,
): Promise<void> {
  await orm
    .insert(resources)
    .values({
      id: resourceId(installId, row.kind, row.key),
      install_id: installId,
      kind: row.kind,
      binding: row.binding,
      name: row.name,
      cf_id: row.cfId,
      created_at: at,
    })
    .onConflictDoNothing();
}

/**
 * Step "verify artifact manifest": fetches `manifest.json` and `manifest.sig`,
 * verifies the signature (by keyId), schema, slug, version, and the index
 * digest, and caches the exact bytes in KV by digest so later steps can re-read
 * them (Workflows caps step results at 1 MiB).
 */
export async function verifyManifestPhase(
  steps: JobSteps,
  kv: KVNamespace | undefined,
  ref: ArtifactRef,
  keys: readonly SigningKey[] | undefined,
): Promise<{ keyId: string }> {
  return steps.run("verify artifact manifest", async ({ log, fetch }) => {
    const manifestFile = await fetchWhole(fetch, ref.artifacts.manifest);
    const sigFile = await fetchWhole(fetch, ref.artifacts.sig);
    const manifest = await verifyArtifactManifest(
      manifestFile.bytes,
      new TextDecoder().decode(sigFile.bytes),
      { slug: ref.slug, version: ref.version, digest: ref.digest },
      keys,
    );
    const key = manifestCacheKey(ref.digest, ref.catalogId);
    if (kv !== undefined && (await kv.get(key)) === null) {
      await kv.put(key, new TextDecoder().decode(manifestFile.bytes), {
        expirationTtl: MANIFEST_TTL_SECONDS,
      });
    }
    log.info(
      `Verified manifest.json for ${manifest.app} ${manifest.version} (key "${manifest.keyId}", digest matches the catalog).`,
    );
    return { keyId: manifest.keyId };
  });
}

/**
 * The verified `manifest.json` text, by digest: from the KV cache when it holds
 * the exact bytes, else fetched again. Either way its sha256 must equal the
 * digest the signature was verified against, so it is the same document.
 */
export async function loadVerifiedManifest(
  kv: KVNamespace | undefined,
  fetchImpl: FetchLike,
  ref: Pick<ArtifactRef, "artifacts" | "digest" | "catalogId">,
): Promise<string> {
  const cached = await kv?.get(manifestCacheKey(ref.digest, ref.catalogId));
  if (cached != null && (await sha256Hex(new TextEncoder().encode(cached))) === ref.digest) {
    return cached;
  }
  const fetched = await fetchWhole(fetchImpl, ref.artifacts.manifest);
  if ((await sha256Hex(fetched.bytes)) !== ref.digest) {
    throw new JobError("manifest.json changed since it was verified");
  }
  return new TextDecoder().decode(fetched.bytes);
}

/**
 * Creates one backing resource as four steps, so a retried create never
 * double-creates and a failed record never re-creates: check the name is free
 * (Appflare never adopts an existing resource), record the name with no
 * Cloudflare id yet, create it, record its id.
 *
 * The name is recorded before the create so that a resource this install
 * made is always known to it, even when recording its id fails for good:
 * the next attempt (an update retried, or the uninstall before an install is
 * made again) finds the row by name and finishes or deletes that resource,
 * where it would otherwise be refused as one Appflare has no record of. A
 * resource of that name with no row of this install is still never adopted.
 *
 * Each name recorded is added to `reserved`; a job that fails passes it to
 * {@link resolveReservedNamesPhase} so no row is left with a name only.
 */
export async function provisionResourcePhase(
  steps: JobSteps,
  installId: string,
  res: ResourceBindingPlan,
  /**
   * Connection strings by Hyperdrive binding, from the job's input. Read
   * inside the create step only; never logged, returned, or recorded.
   */
  connections: Readonly<Record<string, string>>,
  reserved: NameReservation[],
): Promise<CreatedResource> {
  const label = RESOURCE_LABEL[res.kind];
  const rowId = resourceId(installId, res.kind, res.binding);
  // An account without R2 refuses every R2 call; say so instead of the raw error.
  // A token without the optional Hyperdrive group: name the permission.
  const explain = <T>(call: () => Promise<T>): Promise<T> =>
    res.kind === "r2"
      ? explainR2Refusal(res.name, call)
      : res.kind === "hyperdrive"
        ? explainHyperdriveRefusal(call)
        : call();
  const checked = await steps.run(`check ${label} ${res.name}`, async ({ log, cf, orm }) => {
    const existing = await explain(() => findResource(cf(), res));
    if (existing === null) {
      log.info(`No ${label} named "${res.name}" exists yet.`);
      return { recorded: null };
    }
    const [row] = await orm
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.id, rowId),
          eq(resources.name, res.name),
          isNull(resources.cf_id),
          isNull(resources.deleted_at),
          isNull(resources.retained_at),
        ),
      )
      .limit(1);
    if (row === undefined) {
      throw new JobError(
        `a ${label} named ${res.name} already exists in this account; Appflare does not adopt existing resources`,
      );
    }
    log.info(
      `Found the ${label} "${res.name}" an earlier attempt created and recorded by name; finishing it.`,
      { id: existing },
    );
    return { recorded: existing };
  });

  await steps.run(`record ${label} name ${res.name}`, async ({ orm }) => {
    const at = new Date(steps.now());
    await orm
      .insert(resources)
      .values({
        id: rowId,
        install_id: installId,
        kind: res.kind,
        binding: res.unbound === true ? null : res.binding,
        name: res.name,
        cf_id: null,
        created_at: at,
      })
      // A row an earlier attempt released (nothing was created) is taken
      // up again; a live one is left as it is.
      .onConflictDoUpdate({
        target: resources.id,
        set: { name: res.name, cf_id: null, deleted_at: null, created_at: at },
        where: isNotNull(resources.deleted_at),
      });
    return {};
  });
  const reservation: NameReservation = { rowId, res, createdId: null, recorded: false };
  reserved.push(reservation);

  const made = await steps.run(`create ${label} ${res.name}`, async ({ log, cf, orm, attempt }) => {
    // A step output recorded before the check looked at the records has none.
    if (checked.recorded != null) return { cfId: checked.recorded };
    const api = cf();
    // The check step saw no such name, so on a retry a resource with this name
    // is the one this step's own earlier attempt created before it failed.
    if (attempt > 1) {
      const existing = await explain(() => findResource(api, res));
      if (existing !== null) {
        log.info(`Found the ${label} "${res.name}" an earlier attempt created.`, {
          id: existing,
        });
        return { cfId: existing };
      }
    }
    let cfId: string;
    try {
      cfId =
        res.type === "hyperdrive"
          ? await createHyperdriveConfig(api, res, connections[res.binding])
          : await explain(() => createResource(api, res));
    } catch (error) {
      // Refused (or never sent): nothing was created. Release the name so
      // an uninstall never deletes a same-named resource made elsewhere later.
      if (
        error instanceof JobError ||
        (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429)
      ) {
        await orm
          .update(resources)
          .set({ deleted_at: new Date(steps.now()) })
          .where(and(eq(resources.id, rowId), isNull(resources.cf_id)));
      }
      throw error;
    }
    log.info(
      res.unbound === true
        ? `Created ${label} "${res.name}".`
        : `Created ${label} "${res.name}" for binding ${res.binding}.`,
      { id: cfId },
    );
    return { cfId };
  });
  reservation.createdId = made.cfId;

  await steps.run(`record ${label} ${res.name}`, async ({ orm }) => {
    await orm
      .insert(resources)
      .values({
        id: rowId,
        install_id: installId,
        kind: res.kind,
        binding: res.unbound === true ? null : res.binding,
        name: res.name,
        cf_id: made.cfId,
        created_at: new Date(steps.now()),
      })
      .onConflictDoUpdate({
        target: resources.id,
        set: { cf_id: made.cfId },
        where: isNull(resources.cf_id),
      });
    return {};
  });
  reservation.recorded = true;
  // Recorded first, so a failure below leaves a resource the job's cleanup knows.
  await configureResourcePhase(steps, res);
  return { binding: res.binding, type: res.type, name: res.name, cfId: made.cfId };
}

/**
 * A resource name a job recorded before creating the resource (see
 * {@link provisionResourcePhase}). Rebuilt the same way when the job runs
 * again from the top, as every step it follows returns its recorded output.
 */
export interface NameReservation {
  rowId: string;
  res: ResourceBindingPlan;
  /** The id the job's create step returned, once that step finished. */
  createdId: string | null;
  /** Whether the step that records the id finished. */
  recorded: boolean;
}

/**
 * Run when an install or update fails: leaves none of the rows the job
 * recorded by name only, so a name-only row never outlives the job that
 * reserved it. Each one whose id was not recorded is looked up by name. When
 * the resource there is the one the job's create step made (the step
 * returned its id), its id is recorded, so the next attempt and the
 * uninstall address it by id. Otherwise the row is released (marked
 * deleted): the create never made anything, or made something the job has
 * no id for, and a resource Appflare has no id for is never taken on. When
 * the lookup itself fails, the id the create step returned is recorded all
 * the same (it is this job's own); with none, the row is released. Best
 * effort: a row this cannot resolve stays as it was, and its resource
 * (`<label> <name>`) is returned for the job's failure log; the job still
 * fails with its own reason, and the step it failed at stays `steps.current`.
 */
export async function resolveReservedNamesPhase(
  steps: JobSteps,
  reserved: readonly NameReservation[],
): Promise<string[]> {
  const failedAt = steps.current;
  const unresolved: string[] = [];
  for (const r of reserved) {
    if (r.recorded) continue;
    const label = RESOURCE_LABEL[r.res.kind];
    try {
      await steps.run(`resolve ${label} name ${r.res.name}`, async ({ log, cf, orm }) => {
        const [row] = await orm
          .select({ cfId: resources.cf_id, deletedAt: resources.deleted_at })
          .from(resources)
          .where(eq(resources.id, r.rowId))
          .limit(1);
        if (row === undefined || row.deletedAt !== null || row.cfId !== null) return {};
        let found: string | null;
        let lookupFailed = false;
        try {
          found = await findResource(cf(), r.res);
        } catch (error) {
          // Unknown: what the create step returned is still this job's own.
          log.warn(`Could not look up the ${label} "${r.res.name}": ${errorMessage(error)}`);
          found = r.createdId;
          lookupFailed = true;
        }
        const at = new Date(steps.now());
        if (r.createdId !== null && found === r.createdId) {
          await orm
            .update(resources)
            .set({ cf_id: r.createdId })
            .where(and(eq(resources.id, r.rowId), isNull(resources.cf_id)));
          log.info(
            `Recorded the id of the ${label} "${r.res.name}" this job created, so the next attempt and the uninstall find it.`,
            { id: r.createdId },
          );
          return {};
        }
        await orm
          .update(resources)
          .set({ deleted_at: at })
          .where(and(eq(resources.id, r.rowId), isNull(resources.cf_id)));
        if (lookupFailed) {
          log.warn(
            `Appflare could not check whether a ${label} named "${r.res.name}" exists, and this job has no id of one it created, so it releases the name. A ${label} of that name is not Appflare's to keep: delete it in the Cloudflare dashboard if nothing uses it, then try again.`,
          );
        } else if (found === null) {
          log.info(`No ${label} named "${r.res.name}" was created; its name is released.`);
        } else {
          log.warn(
            `A ${label} named "${r.res.name}" exists, but this job has no id of one it created, so Appflare leaves it alone and releases the name. Delete it in the Cloudflare dashboard if nothing uses it, then try again.`,
            { id: found },
          );
        }
        return {};
      });
    } catch {
      unresolved.push(`${label} ${r.res.name}`);
    }
  }
  steps.current = failedAt;
  return unresolved;
}

/** The failure log's line for what {@link resolveReservedNamesPhase} could not resolve. */
export function nameOnlyNote(unresolved: readonly string[]): string {
  return `Appflare could not finish the record of ${unresolved.join(", ")}: recorded by name only, ${unresolved.length === 1 ? "it is" : "they are"} looked up by that name by the next attempt and by the uninstall.`;
}

/**
 * Creates the Hyperdrive configuration of a binding from the connection
 * string the admin entered and returns its id. A missing or unreadable
 * string, or a database Cloudflare cannot reach (it connects before it
 * answers), ends the job with a sentence that names the binding and never
 * any part of the string.
 */
export async function createHyperdriveConfig(
  api: CloudflareClient,
  res: Extract<ResourceBindingPlan, { type: "hyperdrive" }>,
  connection: string | undefined,
): Promise<string> {
  if (connection === undefined) {
    throw new JobError(`no connection string was given for the database of ${res.binding}`);
  }
  const parsed = parseConnectionString(connection, res.protocol);
  if (!parsed.ok) {
    throw new JobError(`the connection string for ${res.binding} is not usable: ${parsed.problem}`);
  }
  try {
    return await explainHyperdriveRefusal(() => createResource(api, res, parsed.origin));
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429) {
      const said = error.errors.map((e) => e.message).join("; ") || `HTTP ${error.status}`;
      throw new JobError(
        `Cloudflare could not set up Hyperdrive for ${res.binding} (${said}). Check that the database accepts connections from the internet with the user, password and database name given, then try again`,
      );
    }
    throw error;
  }
}

/** The token permission Hyperdrive calls need, in the dashboard's words. */
export const HYPERDRIVE_PERMISSION = "Hyperdrive: Edit";

/**
 * Runs a Hyperdrive API call; a refusal of the token (401 or 403) ends the
 * job with a sentence naming the permission the token lacks, since the
 * token's Hyperdrive group is optional and many tokens do not have it.
 */
export async function explainHyperdriveRefusal<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      const said = error.errors.map((e) => e.message).join("; ") || `HTTP ${error.status}`;
      throw new JobError(
        `Cloudflare refused the Hyperdrive call (${said}). The API token needs ${HYPERDRIVE_PERMISSION}, an optional permission for apps with a database elsewhere: add it to the token in the Cloudflare dashboard, then try again`,
      );
    }
    throw error;
  }
}

/** Step "check Workflow <name>": Workflow names are account-wide and never adopted. */
export async function checkWorkflowNamePhase(steps: JobSteps, wf: WorkflowPlan): Promise<void> {
  await steps.run(`check Workflow ${wf.name}`, async ({ log, cf }) => {
    let owner: string | null = null;
    try {
      owner = (await cf().workflows.getWorkflow(wf.name)).script_name ?? "another script";
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    if (owner !== null) {
      throw new JobError(
        `a Workflow named ${wf.name} already exists in this account (script "${owner}"); Appflare does not adopt existing Workflows`,
      );
    }
    log.info(`No Workflow named "${wf.name}" exists yet.`);
    return {};
  });
}

/** The JWT's payload claims, or `{}` when it is not a decodable JWT. */
function jwtClaims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split(".")[1];
    if (part === undefined) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Static assets: open an upload session with the manifest's `{route: {hash,
 * size}}` map, then upload every bucket Cloudflare asks for, one step per
 * part. Returns the completion JWT, or null when the artifact has no assets.
 * Cloudflare deduplicates assets account-wide, so a session may ask for no
 * buckets; its own JWT is then the completion JWT.
 *
 * Each part is one job unit (`uploadAssetPart`): it reads its files with as
 * few Range requests as the zip layout allows, following the release-asset
 * redirect once, and uploads them. A bucket too big for one unit is uploaded
 * in parts (`planAssetParts`), so the number of files in a bucket never
 * decides whether a unit fits its invocation's subrequest limit.
 */
export async function uploadAssetsPhase(
  steps: JobSteps,
  workerName: string,
  zipUrl: string,
  files: readonly AssetFile[],
  /** Where the zip lives (the self-update reads the manager's own release feed). */
  host: ArtifactHost = { kind: "catalog" },
  /** Appended to every step name, to tell apart the Workers of an app of several. */
  label = "",
): Promise<string | null> {
  if (files.length === 0) return null;
  const session = await steps.run(`open assets upload session${label}`, async ({ log, cf }) => {
    const result = await cf().assets.createUploadSession(
      workerName,
      buildAssetsManifest(files.map((f) => ({ route: f.route, hash: f.hash, size: f.size }))),
    );
    const needed = result.buckets.reduce((n, b) => n + b.length, 0);
    log.info(
      needed === 0
        ? `All ${files.length} asset files are already stored in this account; nothing to upload.`
        : `${needed} of ${files.length} asset files need uploading in ${result.buckets.length} bucket(s).`,
    );
    return { jwt: result.jwt, buckets: result.buckets };
  });
  const single = jwtClaims(session.jwt).wrangler_single_asset_uploads === true;
  const byHash = new Map(files.map((f) => [f.hash, f]));
  const buckets = session.buckets.map((bucket) =>
    bucket.map((hash) => {
      const file = byHash.get(hash);
      if (file === undefined) {
        steps.current = "upload assets";
        throw new JobError(`Cloudflare asked for an asset (${hash}) the artifact does not have`);
      }
      return file;
    }),
  );
  let completion: string | null = null;
  for (const [b, bucket] of buckets.entries()) {
    const parts = planAssetParts(bucket, single);
    for (const [p, part] of parts.entries()) {
      const name =
        `upload assets bucket ${b + 1}/${buckets.length}` +
        (parts.length > 1 ? ` part ${p + 1}/${parts.length}` : "") +
        label;
      const uploaded = await steps.run(name, async ({ log }) =>
        settleUnit(
          await steps.units.api.uploadAssetPart({
            accountId: steps.accountId(),
            artifact: { zipUrl, host },
            sessionJwt: session.jwt,
            single,
            files: part.files,
          }),
          log,
        ),
      );
      completion = uploaded.jwt ?? completion;
    }
  }
  if (session.buckets.length === 0) completion = session.jwt;
  if (completion === null) {
    steps.current = "upload assets";
    throw new JobError("Cloudflare did not return an assets completion token");
  }
  return completion;
}

/** A D1 database of the install and the SQL the artifact ships for its binding. */
export interface D1Target {
  binding: string;
  name: string;
  cfId: string;
  /** Migrations, recorded in `d1_migrations`; applied before the new code serves. */
  files: readonly D1MigrationFile[];
  /** Schema files, run after the migrations on every install and update, never recorded. */
  schema: readonly D1MigrationFile[];
  /** Migrations applied once the new code serves all traffic, recorded like the others. */
  postDeploy: readonly D1MigrationFile[];
  /**
   * Statements run once, at install only, with values from the install form
   * (the catalog manifest's `resources.d1[binding].seed`); undefined when
   * the binding has none. Updates ignore it.
   */
  seed?: CatalogD1Seed | undefined;
  /**
   * The database's whole current schema (the catalog manifest's
   * `resources.d1[binding].baseline`), run only on a database the job has
   * just created, before the migrations; null when the binding has none.
   */
  baseline: D1MigrationFile | null;
}

/**
 * Step "D1 <binding>: apply baseline", before the migrations of a binding
 * with a baseline: on an empty database (no table of the app's, nothing in
 * `d1_migrations`) it runs the baseline and records every migration and
 * post-deploy migration the version ships as applied without running them,
 * since the baseline already holds what they do; the migrations phase that
 * follows then finds nothing to apply. On any other database it does
 * nothing, and the migrations bring it up to date. One `applyD1Baseline`
 * unit call: the baseline and the records go in one D1 query, applied whole
 * or not at all, so a retried step (or job) whose earlier attempt succeeded
 * finds the tables there and does nothing, and one whose earlier attempt
 * failed before the query finds the database still empty.
 */
export async function applyD1BaselinePhase(
  steps: JobSteps,
  zipUrl: string,
  target: D1Target,
  host: ArtifactHost = { kind: "catalog" },
): Promise<void> {
  const file = target.baseline;
  if (file === null) return;
  const migrations = [...target.files, ...target.postDeploy].map((f) => f.name);
  await steps.run(`D1 ${target.binding}: apply baseline`, async ({ log }) => {
    const got = settleUnit(
      await steps.units.api.applyD1Baseline({
        accountId: steps.accountId(),
        artifact: { zipUrl, host },
        databaseId: target.cfId,
        databaseName: target.name,
        file,
        migrations,
      }),
      log,
    );
    return { ran: got.ran, recorded: got.recorded };
  });
}

/**
 * D1 migrations the way `wrangler d1 migrations apply --remote` does them:
 * ensure `d1_migrations`, list what is applied, then apply each file not yet
 * recorded, in filename order. On a database that already has migrations only
 * the new files run. Returns how many files this job applied.
 *
 * The work runs in `applyD1Migrations` job units, one step per call: a call
 * applies as many files as fit its own invocation's subrequest limit (30
 * small files in one call) and says how many remain, and the next step
 * continues from there. Each call lists what is applied first, so a retried
 * step resumes after the last file an earlier attempt recorded.
 *
 * `onMigrated` runs once this job is known to have applied a file, before
 * the phase returns or throws, so a caller can say the database is ahead of
 * the code that serves even when a later file fails.
 */
export function applyD1MigrationsPhase(
  steps: JobSteps,
  zipUrl: string,
  target: D1Target,
  onMigrated?: () => void,
  /** Where the zip lives (a sandbox build is read through the sandbox Worker). */
  host: ArtifactHost = { kind: "catalog" },
): Promise<number> {
  return applyTrackedPhase(steps, zipUrl, target, target.files, "migrations", onMigrated, host);
}

/**
 * The post-deploy migrations (the catalog manifest's
 * `resources.d1[binding].postDeployMigrationsDir`), once the new version
 * serves all traffic: changes the previous version's code would break on,
 * such as dropping what only it used. Tracked in `d1_migrations` beside the
 * migrations and applied the same way, so each runs once per database.
 *
 * Nothing reverts them. A rollback redeploys the previous Worker version and
 * leaves the database as it is, as it does after every migration; the
 * snapshot's Time Travel bookmark, taken before the update, is the way back.
 */
export function applyD1PostDeployPhase(
  steps: JobSteps,
  zipUrl: string,
  target: D1Target,
  host: ArtifactHost = { kind: "catalog" },
): Promise<number> {
  return applyTrackedPhase(
    steps,
    zipUrl,
    target,
    target.postDeploy,
    "post-deploy migrations",
    undefined,
    host,
  );
}

/** Tracked files (`files`) through `applyD1Migrations` units; `label` names the steps. */
async function applyTrackedPhase(
  steps: JobSteps,
  zipUrl: string,
  target: D1Target,
  files: readonly D1MigrationFile[],
  label: string,
  onMigrated: (() => void) | undefined,
  host: ArtifactHost,
): Promise<number> {
  if (files.length === 0) return 0;
  // Files not yet recorded when this job first listed the database. It rides
  // on each step's result, so it survives a retried step whose earlier
  // attempt applied files and lost the answer (the retry finds fewer pending)
  // and a replay of the steps.
  let before: number | null = null;
  // Files still unrecorded as last seen.
  let left: number | null = null;
  try {
    let next: string | null = null;
    // Every call applies at least one file, so this many calls always suffice.
    for (let call = 1; call <= files.length; call++) {
      const name: string =
        next === null
          ? `D1 ${target.binding}: apply ${label}`
          : `D1 ${target.binding}: apply ${label} from ${next}`;
      const result = await steps.run(name, async ({ log }) => {
        const got = settleUnit(
          await steps.units.api.applyD1Migrations({
            accountId: steps.accountId(),
            artifact: { zipUrl, host },
            databaseId: target.cfId,
            databaseName: target.name,
            files: [...files],
            shipped: [...target.files, ...target.postDeploy].map((f) => f.name),
          }),
          log,
        );
        before ??= got.pending;
        left = got.remaining;
        if (got.failed !== null) throw failureError(got.failed);
        return { remaining: got.remaining, next: got.next, before };
      });
      before = result.before;
      left = result.remaining;
      if (result.remaining === 0) return before;
      next = result.next;
    }
    steps.current = `D1 ${target.binding}: apply ${label}`;
    throw new JobError(`${target.name} still has ${label} to apply after ${files.length} calls`);
  } finally {
    if (before !== null && left !== null && before > left) onMigrated?.();
  }
}

/**
 * The schema files (the catalog manifest's `resources.d1[binding].schema`),
 * after the migrations, on every install and update, in the order the
 * catalog lists them. They are not recorded: the packer accepts only files
 * whose every CREATE says IF NOT EXISTS and that drop and alter nothing, so
 * running one again creates what is missing and leaves the rest alone.
 *
 * The work runs in `applyD1Schema` job units, one step per call; a call runs
 * as many files as fit its invocation and the next step continues with the
 * rest. A retried step runs its files again, which is harmless.
 */
export async function applyD1SchemaPhase(
  steps: JobSteps,
  zipUrl: string,
  target: D1Target,
  host: ArtifactHost = { kind: "catalog" },
): Promise<void> {
  let rest = [...target.schema];
  // Every call runs at least one file, so this many calls always suffice.
  for (let call = 1; call <= target.schema.length && rest.length > 0; call++) {
    const name =
      call === 1
        ? `D1 ${target.binding}: apply schema`
        : `D1 ${target.binding}: apply schema from ${rest[0]?.name}`;
    const files = rest;
    const result = await steps.run(name, async ({ log }) => {
      const got = settleUnit(
        await steps.units.api.applyD1Schema({
          accountId: steps.accountId(),
          artifact: { zipUrl, host },
          databaseId: target.cfId,
          databaseName: target.name,
          files,
        }),
        log,
      );
      if (got.failed !== null) throw failureError(got.failed);
      return { applied: got.applied };
    });
    rest = rest.slice(result.applied);
  }
  if (rest.length > 0) {
    steps.current = `D1 ${target.binding}: apply schema`;
    throw new JobError(
      `${target.name} still has schema files to run after ${target.schema.length} calls`,
    );
  }
}

/**
 * The D1 targets of a manifest: every database resource whose binding ships
 * migrations, schema files, post-deploy migrations, seed statements or a
 * baseline.
 */
export function d1Targets(
  manifest: ArtifactManifest,
  databases: readonly CreatedResource[],
): D1Target[] {
  const layouts = manifest.catalog.resources?.d1 ?? {};
  return databases
    .filter((r) => r.type === "d1")
    .map((r) => {
      const sql = Object.hasOwn(manifest.d1, r.binding) ? manifest.d1[r.binding] : undefined;
      return {
        binding: r.binding,
        name: r.name,
        cfId: r.cfId,
        files: sql?.migrations ?? [],
        schema: sql?.schema ?? [],
        postDeploy: sql?.postDeploy ?? [],
        seed: Object.hasOwn(layouts, r.binding) ? layouts[r.binding]?.seed : undefined,
        baseline: sql?.baseline ?? null,
      };
    })
    .filter(
      (t) =>
        t.files.length + t.schema.length + t.postDeploy.length > 0 ||
        t.seed !== undefined ||
        t.baseline !== null,
    );
}

/** Step "look up workers.dev subdomain": cached in settings after the first lookup. */
export async function lookupSubdomainPhase(steps: JobSteps): Promise<string> {
  const { subdomain } = await steps.run(
    "look up workers.dev subdomain",
    async ({ log, cf, orm }) => {
      const cached = await readSettings(orm, [SETTING.accountSubdomain]);
      if (cached.account_subdomain) return { subdomain: cached.account_subdomain };
      const found = (await cf().workers.getAccountSubdomain()).subdomain;
      await writeSettings(orm, { [SETTING.accountSubdomain]: found }, new Date(steps.now()));
      log.info(`This account's workers.dev subdomain is "${found}".`);
      return { subdomain: found };
    },
  );
  return subdomain;
}

/**
 * Install: the version a Worker serves once its secrets are set, which is
 * the one to record. Setting a secret on the script (`PUT
 * /workers/scripts/{name}/secrets`) deploys a new version at once, made from
 * the one serving, so after the first secret the version the upload reported
 * serves nothing; recorded anyway, the next update or settings change finds
 * another version serving than Appflare recorded. One read of the Worker's
 * deployments after its last secret, and only for a Worker that got one: the
 * read changes nothing, so a step that runs again reads again.
 *
 * Never fails the install, which has set everything up by then: when
 * Cloudflare refuses the read, or no single version serves all traffic (only
 * a deployment made outside Appflare splits it), the uploaded version stays
 * recorded, with a warning. `record` writes a version read in a step of its
 * own, so a failed write fails the job rather than leaving the old version.
 */
export async function servingVersionPhase(
  steps: JobSteps,
  input: {
    workerName: string;
    /** The version the upload reported, kept when the read cannot tell. */
    uploadedVersionId: string | null;
    /** Names the Worker in the step and the log, for the Workers of an app of several. */
    label?: string;
    record?: (orm: Database, versionId: string) => Promise<void>;
  },
): Promise<string | null> {
  const label = input.label ?? "";
  const of = label === "" ? "" : ` of Worker "${input.workerName}"`;
  const kept = input.uploadedVersionId;
  const read = await steps
    .run(`read serving version${label}`, async ({ log, cf }) => {
      let versionId: string | null;
      try {
        versionId = activeVersionId(await cf().versions.listDeployments(input.workerName));
      } catch (error) {
        // A 5xx or a 429 is retried by the step; a refusal will not change.
        if (!(error instanceof CloudflareApiError) || error.status >= 500 || error.status === 429) {
          throw error;
        }
        log.warn(
          `Could not read which version${of} serves now that its secrets are set (${error.message}); Appflare records the uploaded version ${kept ?? "(unknown)"}.`,
        );
        return { versionId: kept };
      }
      if (versionId === null) {
        log.warn(
          `No single version${of} serves all traffic now that its secrets are set; Appflare records the uploaded version ${kept ?? "(unknown)"}.`,
        );
        return { versionId: kept };
      }
      log.info(`Version ${versionId}${of} serves all traffic, with its secrets.`, { versionId });
      return { versionId };
    })
    // Retries ran out: the step logged why, and the uploaded version stays recorded.
    .catch(() => ({ versionId: kept }));
  const { record } = input;
  if (record !== undefined && read.versionId !== null && read.versionId !== kept) {
    const versionId = read.versionId;
    await steps.run(`record serving version${label}`, async ({ orm }) => {
      await record(orm, versionId);
      return {};
    });
  }
  return read.versionId;
}

export interface ProbePhaseOptions {
  /** Step names are `<label> check N` and sleeps `<label> wait N` ("canary"). */
  label: string;
  url: string;
  /** What a healthy answer means, for the log ("the Worker is serving"). */
  healthyMessage: string;
  maxAttempts?: number;
  /** When set, a JSON answer reporting another `version` fails (see `versionMismatch`). */
  expectVersion?: string;
  /**
   * The install whose Worker this is: while it is protected with Cloudflare
   * Access, the probe carries its own service token. Left out for Workers
   * that are not the install's own address (another Worker of the app).
   */
  installId?: string;
  /** How the default verdict reads an answer (the app's `install.health.mode`). */
  mode?: HealthMode;
  /** Replaces the default verdict (`classifyHealthProbe`, any non-5xx is healthy). */
  classify?: (
    probe: HealthProbe,
    attempt: number,
    elapsedMs: number,
    maxAttempts: number,
  ) => HealthVerdict;
}

/**
 * The canary: GETs `url` until it serves, through route propagation and
 * error 1042 (the manager carries `global_fetch_strictly_public`, so it can
 * reach its own account's workers.dev hosts): one step per probe, a
 * `step.sleep` between probes. Any non-5xx answer is healthy. Returns the
 * status; throws `JobError` when the URL never serves, which fails the job
 * before anything serves the version. Returns null when Cloudflare Access
 * answered in the version's place (`blocked`): the version was not checked,
 * which is logged, and the job goes on as it does for a Worker without a
 * preview URL.
 */
export async function probeUntilHealthy(
  steps: JobSteps,
  step: StepRunner,
  opts: ProbePhaseOptions,
): Promise<number | null> {
  const maxAttempts = opts.maxAttempts ?? HEALTH_MAX_ATTEMPTS;
  // In one invocation: a wait for a fresh one between probes would count
  // against the check's grace for server errors. Each probe is at most two
  // requests (once more with the app's Access token), plus a zone lookup.
  return steps.reserve(opts.label, 2 * maxAttempts + 1, () =>
    probeLoop(steps, step, opts, maxAttempts),
  );
}

async function probeLoop(
  steps: JobSteps,
  step: StepRunner,
  opts: ProbePhaseOptions,
  maxAttempts: number,
): Promise<number | null> {
  let firstProbeAt: number | null = null;
  // The install's token for this URL, looked up once for the whole phase.
  let credentials: (() => Promise<Record<string, string> | undefined>) | undefined;
  // Once Access let the token through for this URL, later attempts send it at once.
  let direct = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const checked = await steps.run(
      `${opts.label} check ${attempt}`,
      async ({ log, fetch, probeHeaders }) => {
        const at = steps.now();
        const { installId } = opts;
        if (installId !== undefined) {
          credentials ??= lookupOnce(() => probeHeaders(installId, opts.url));
        }
        const { probe, tokenAccepted } = await probeThroughAccess(
          fetch,
          opts.url,
          credentials,
          {},
          direct,
        );
        const elapsed = at - (firstProbeAt ?? at);
        const verdict =
          opts.classify !== undefined
            ? opts.classify(probe, attempt, elapsed, maxAttempts)
            : classifyHealthProbe(probe, attempt, elapsed, maxAttempts, opts.mode);
        if (verdict.verdict === "unhealthy") throw new JobError(verdict.reason);
        const wrong =
          verdict.verdict === "healthy" && opts.expectVersion !== undefined
            ? versionMismatch(probe, opts.expectVersion)
            : null;
        if (wrong !== null) throw new JobError(`GET ${opts.url}: ${wrong}`);
        if (verdict.verdict === "healthy") {
          log.info(`GET ${opts.url} -> ${verdict.status}; ${opts.healthyMessage}.`);
        } else if (verdict.verdict === "blocked") {
          log.warn(`GET ${opts.url}: ${ACCESS_PREVIEW_REASON}.`);
        } else {
          log.warn(`GET ${opts.url}: ${verdict.reason}; retrying in 2 seconds.`);
        }
        return {
          at,
          status: verdict.verdict === "healthy" ? verdict.status : null,
          blocked: verdict.verdict === "blocked",
          tokenAccepted,
        };
      },
    );
    firstProbeAt ??= checked.at;
    // A step output recorded before this was reported has none.
    direct = checked.tokenAccepted === true;
    if (checked.status !== null) return checked.status;
    if (checked.blocked) return null;
    await step.sleep(`${opts.label} wait ${attempt}`, HEALTH_RETRY_DELAY);
  }
  steps.current = `${opts.label} check`;
  throw new JobError(`${opts.url} never answered`);
}

export interface LiveHealthResult extends HealthSettlement {
  /** When the last probe ran (epoch ms). */
  checkedAt: number;
}

/**
 * The live health check of a Worker that already serves (created, or
 * promoted): GETs `url` with backoff (2, 3, 5, 8, then every 10 s) for up to
 * 90 seconds after the first probe, through route
 * propagation, error 1042, and 5xx answers. One step per probe (one
 * subrequest plus its log write), and a `step.sleep` between probes. Never throws for what the Worker answers: by now
 * everything is created or promoted, so the result is recorded on the install
 * instead (`verified`, `unverified`, `unhealthy`) and a warning is logged when
 * the Worker could not be verified. Cloudflare Access's sign-in redirect ends
 * the check at once as `unverified`: Access answers before the Worker does.
 * Right after the job removed the app's protection (`access: "off"`), Access
 * goes on answering for a few seconds, so its sign-in is retried through the
 * same window until the removal takes effect.
 */
export async function checkLiveHealthPhase(
  steps: JobSteps,
  step: StepRunner,
  url: string,
  /** How to read the answer (the app's `install.health.mode`). */
  mode: HealthMode = DEFAULT_HEALTH_MODE,
  /**
   * `routeWasLive`: the URL was serving before the job, so a plain 404 is
   * the app's own answer and settles the check at once.
   */
  opts: {
    routeWasLive?: boolean;
    /**
     * The install checked, so a warning links to its health check, and a
     * protected install's probe carries its own service token.
     */
    installId?: string;
    /**
     * The job just turned the app's Cloudflare Access protection on or off,
     * which the warnings say instead of "Everything was created". Off also
     * waits out Access's sign-in while the removal takes effect.
     */
    access?: "on" | "off";
  } = {},
): Promise<LiveHealthResult> {
  // In one invocation: a wait for a fresh one between probes would use up
  // the check's 90 seconds. Each probe is at most two requests, plus a zone
  // lookup.
  return steps.reserve("health check", 2 * LIVE_HEALTH_PROBES + 1, () =>
    liveHealthLoop(steps, step, url, mode, opts),
  );
}

/**
 * The most probes a live health check makes: one at once, then one after
 * each wait of 2, 3, 5, 8 and then 10 seconds within its 90 (12).
 */
export const LIVE_HEALTH_PROBES = 12;

async function liveHealthLoop(
  steps: JobSteps,
  step: StepRunner,
  url: string,
  mode: HealthMode,
  opts: { routeWasLive?: boolean; installId?: string; access?: "on" | "off" },
): Promise<LiveHealthResult> {
  const checkAgain =
    opts.installId === undefined
      ? "check again from its page"
      : `check again from ${appPlace(opts.installId, "health", "its page")}`;
  // What the job did, for the warnings. A settings change (`routeWasLive`)
  // created nothing, and its URL served before the job, so its warnings say
  // neither that everything was created nor that the route may be going live.
  const done =
    opts.access === "on"
      ? "The app is protected now"
      : opts.access === "off"
        ? "The protection is removed"
        : opts.routeWasLive === true
          ? "The new settings are in place"
          : "Everything was created";
  const notVerified =
    opts.routeWasLive === true ? `${done}.` : `${done}; the route may still be going live.`;
  let firstProbeAt: number | null = null;
  // The install's token for this URL, looked up once for the whole phase.
  let credentials: (() => Promise<Record<string, string> | undefined>) | undefined;
  // Once Access let the token through for this URL, later attempts send it at once.
  let direct = false;
  for (let attempt = 1; ; attempt++) {
    const checked = await steps.run(
      `health check ${attempt}`,
      async ({ log, fetch, probeHeaders }) => {
        const at = steps.now();
        const { installId } = opts;
        if (installId !== undefined) {
          credentials ??= lookupOnce(() => probeHeaders(installId, url));
        }
        const { probe, tokenAccepted } = await probeThroughAccess(
          fetch,
          url,
          credentials,
          {},
          direct,
        );
        const elapsed = at - (firstProbeAt ?? at);
        const accessRemoved = opts.access === "off";
        const decision = decideLiveHealth(
          probe,
          attempt,
          elapsed,
          undefined,
          mode,
          opts.routeWasLive === true,
          accessRemoved,
        );
        if (!decision.done) {
          log.warn(
            accessRemoved && isAccessChallenge(probe)
              ? `GET ${url}: Cloudflare Access still asks for a sign-in while the removal of the protection takes effect; retrying in ${decision.delaySeconds} seconds.`
              : `GET ${url}: ${decision.reason}; retrying in ${decision.delaySeconds} seconds.`,
          );
        } else if (decision.access === true && accessRemoved) {
          const seconds = Math.round(Math.max(elapsed, liveHealthScheduledMs(attempt)) / 1000);
          log.warn(
            `GET ${url}: Cloudflare Access still asked for a sign-in ${seconds} seconds after the protection was removed, so Appflare could not reach the app to check it. The removal can take a little longer to reach every Cloudflare location; open the app to check, or ${checkAgain}.`,
          );
        } else if (decision.access === true) {
          log.warn(
            `GET ${url}: ${decision.detail}, so Appflare could not reach the app to check it. ${done}; open the app and sign in to check it.`,
          );
        } else if (decision.status === "verified") {
          log.info(`GET ${url} -> ${decision.detail}; the Worker is serving.`);
        } else if (decision.status === "unhealthy") {
          log.warn(
            `GET ${url} -> ${decision.detail}: the Worker answers with a server error. ${done}; open the app to check, or ${checkAgain}.`,
          );
        } else {
          log.warn(
            `Could not verify ${url} after ${attempt} attempts (${decision.detail}). ${notVerified} Open the app to check, or ${checkAgain}.`,
          );
        }
        return { at, decision, tokenAccepted };
      },
    );
    firstProbeAt ??= checked.at;
    // A step output recorded before this was reported has none.
    direct = checked.tokenAccepted === true;
    const { decision } = checked;
    if (decision.done) {
      return {
        status: decision.status,
        detail: decision.detail,
        ...(decision.access === true ? { access: true as const } : {}),
        checkedAt: checked.at,
      };
    }
    await step.sleep(`health wait ${attempt}`, `${decision.delaySeconds} seconds`);
  }
}

/**
 * Step "set cron triggers" when the wanted schedule differs from the recorded
 * one. Cron triggers belong to the script, not to a version, so this runs
 * after the version that expects them serves traffic. Replaced triggers are
 * marked deleted; they hold no data. Cloudflare's refusal at the account's
 * cron trigger limit is a warning here, not a failure: the version already
 * serves, the Worker keeps the triggers it had (as recorded), and the job
 * goes on to its health check.
 */
export async function syncCronsPhase(
  steps: JobSteps,
  installId: string,
  workerName: string,
  recorded: readonly string[],
  wanted: readonly string[],
): Promise<void> {
  const { changed, added, removed } = cronChanges(recorded, wanted);
  if (!changed) return;
  const want = new Set(wanted);
  await steps.run("set cron triggers", async ({ log, cf, orm }) => {
    try {
      await putSchedulesChecked(
        cf(),
        workerName,
        [...want],
        `The version serves traffic; the Worker keeps the cron triggers it had (${recorded.length > 0 ? recorded.join(", ") : "none"})${added.length > 0 ? ` and does not get ${added.join(", ")}` : ""}.`,
        "then the next update or rollback sets them",
      );
    } catch (error) {
      // The version already serves: a refused schedule changes nothing, so
      // the job goes on to the health check and records the triggers as
      // they were.
      if (!(error instanceof CronLimitError)) throw error;
      log.warn(error.message);
      return {};
    }
    const at = new Date(steps.now());
    for (const cron of added) {
      await orm
        .insert(resources)
        .values({
          id: resourceId(installId, "cron", cron),
          install_id: installId,
          kind: "cron",
          binding: null,
          name: cron,
          cf_id: null,
          created_at: at,
        })
        .onConflictDoUpdate({ target: resources.id, set: { deleted_at: null } });
    }
    if (removed.length > 0) {
      await orm
        .update(resources)
        .set({ deleted_at: at })
        .where(
          inArray(
            resources.id,
            removed.map((cron) => resourceId(installId, "cron", cron)),
          ),
        );
    }
    log.info(
      want.size === 0
        ? "Removed every cron trigger."
        : `Set ${want.size} cron trigger(s): ${[...want].join(", ")}.`,
    );
    return {};
  });
}
