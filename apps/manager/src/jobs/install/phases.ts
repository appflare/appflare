import { Buffer } from "node:buffer";
import { buildAssetsManifest, CloudflareApiError, type FetchLike } from "@appflare/cf-api";
import type {
  ArtifactManifest,
  AssetFile,
  D1MigrationFile,
  IndexArtifacts,
  SigningKey,
} from "@appflare/schema";
import { inArray } from "drizzle-orm";
import { MANIFEST_TTL_SECONDS, manifestCacheKey } from "../../catalog/app-manifest.server";
import type { Database } from "../../db/client";
import { type RESOURCE_KINDS, resources } from "../../db/schema";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import type { StepRunner } from "../run-job";
import { JobError, type JobSteps } from "../steps";
import { cronChanges } from "../update/plan";
import { fetchArtifactFile, fetchWhole, sha256Hex, verifyArtifactManifest } from "./artifact";
import type { ResourceBindingPlan, WorkflowPlan } from "./bindings";
import { ARTIFACT_FETCH_COST } from "./budget";
import {
  APPLIED_MIGRATION_SQL,
  buildMigrationQuery,
  CREATE_MIGRATIONS_TABLE_SQL,
  LIST_APPLIED_MIGRATIONS_SQL,
  unappliedMigrations,
} from "./d1-migrations";
import {
  classifyHealthProbe,
  decideLiveHealth,
  HEALTH_MAX_ATTEMPTS,
  HEALTH_RETRY_DELAY,
  type HealthProbe,
  type HealthSettlement,
  type HealthVerdict,
  probeHealth,
  versionMismatch,
} from "./health";
import type { CreatedResource } from "./metadata";
import { assetContentType } from "./mime";
import { explainR2Refusal } from "./r2-enablement";
import { createResource, findResource, RESOURCE_LABEL } from "./resources";

/**
 * Step sequences the install and update jobs share: verifying the artifact
 * manifest, creating a resource (check, create, record), uploading static
 * assets, applying D1 migrations, and probing a URL until it serves. Each
 * phase runs through the job's step runner, so step names, retries, logging,
 * and the subrequest budget behave the same in every job.
 */

/** Where a job finds its artifact: the index entry's URLs and the manifest digest. */
export interface ArtifactRef {
  slug: string;
  version: string;
  artifacts: IndexArtifacts;
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
  return steps.run("verify artifact manifest", 6, async ({ log, fetch }) => {
    const manifestFile = await fetchWhole(fetch, ref.artifacts.manifest);
    const sigFile = await fetchWhole(fetch, ref.artifacts.sig);
    const manifest = await verifyArtifactManifest(
      manifestFile.bytes,
      new TextDecoder().decode(sigFile.bytes),
      { slug: ref.slug, version: ref.version, digest: ref.digest },
      keys,
    );
    const key = manifestCacheKey(ref.digest);
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
  ref: Pick<ArtifactRef, "artifacts" | "digest">,
): Promise<string> {
  const cached = await kv?.get(manifestCacheKey(ref.digest));
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
 * Creates one backing resource as three steps, so a retried create never
 * double-creates and a failed record never re-creates: check the name is free
 * (Appflare never adopts an existing resource), create it, record it.
 */
export async function provisionResourcePhase(
  steps: JobSteps,
  installId: string,
  res: ResourceBindingPlan,
): Promise<CreatedResource> {
  const label = RESOURCE_LABEL[res.kind];
  // An account without R2 refuses every R2 call; say so instead of the raw error.
  const explain = <T>(call: () => Promise<T>): Promise<T> =>
    res.kind === "r2" ? explainR2Refusal(res.name, call) : call();
  await steps.run(`check ${label} ${res.name}`, 3, async ({ log, cf }) => {
    if ((await explain(() => findResource(cf(), res))) !== null) {
      throw new JobError(
        `a ${label} named ${res.name} already exists in this account; Appflare does not adopt existing resources`,
      );
    }
    log.info(`No ${label} named "${res.name}" exists yet.`);
    return {};
  });

  const made = await steps.run(`create ${label} ${res.name}`, 4, async ({ log, cf, attempt }) => {
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
    const cfId = await explain(() => createResource(api, res));
    log.info(`Created ${label} "${res.name}" for binding ${res.binding}.`, { id: cfId });
    return { cfId };
  });

  await steps.run(`record ${label} ${res.name}`, 0, async ({ orm }) => {
    await recordResource(
      orm,
      installId,
      { kind: res.kind, key: res.binding, binding: res.binding, name: res.name, cfId: made.cfId },
      new Date(steps.now()),
    );
    return {};
  });
  return { binding: res.binding, type: res.type, name: res.name, cfId: made.cfId };
}

/** Step "check Workflow <name>": Workflow names are account-wide and never adopted. */
export async function checkWorkflowNamePhase(steps: JobSteps, wf: WorkflowPlan): Promise<void> {
  await steps.run(`check Workflow ${wf.name}`, 1, async ({ log, cf }) => {
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

/** Files per assets step: 2 subrequests per Range fetch (GitHub redirects) + the upload. */
const BULK_FILES_PER_STEP = 19;
/** Single-file upload mode: 2 per fetch + 1 upload per file. */
const SINGLE_FILES_PER_STEP = 13;

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
 * size}}` map, then upload every bucket Cloudflare asks for, in budgeted
 * steps. Returns the completion JWT, or null when the artifact has no assets.
 * Cloudflare deduplicates assets account-wide, so a session may ask for no
 * buckets; its own JWT is then the completion JWT.
 */
export async function uploadAssetsPhase(
  steps: JobSteps,
  workerName: string,
  zipUrl: string,
  files: readonly AssetFile[],
  /** Wraps the step's fetch for the artifact host (the self-update's release feed needs it). */
  wrapFetch: (fetch: FetchLike) => FetchLike = (fetch) => fetch,
): Promise<string | null> {
  if (files.length === 0) return null;
  const session = await steps.run("open assets upload session", 1, async ({ log, cf }) => {
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
  const perStep = single ? SINGLE_FILES_PER_STEP : BULK_FILES_PER_STEP;
  const byHash = new Map(files.map((f) => [f.hash, f]));
  let completion: string | null = null;
  for (const [b, bucket] of session.buckets.entries()) {
    const parts = Math.max(1, Math.ceil(bucket.length / perStep));
    for (let p = 0; p < parts; p++) {
      const hashes = bucket.slice(p * perStep, (p + 1) * perStep);
      const name =
        `upload assets bucket ${b + 1}/${session.buckets.length}` +
        (parts > 1 ? ` part ${p + 1}/${parts}` : "");
      const cost = hashes.length * (ARTIFACT_FETCH_COST + (single ? 1 : 0)) + (single ? 0 : 1);
      const uploaded = await steps.run(name, cost, async ({ log, fetch, cf }) => {
        const api = cf();
        const payload: Array<{ hash: string; bytes: Uint8Array; contentType: string }> = [];
        let bytes = 0;
        for (const hash of hashes) {
          const file = byHash.get(hash);
          if (file === undefined) {
            throw new JobError(
              `Cloudflare asked for an asset (${hash}) the artifact does not have`,
            );
          }
          const got = await fetchArtifactFile(wrapFetch(fetch), zipUrl, file);
          bytes += got.bytes.byteLength;
          payload.push({ hash, bytes: got.bytes, contentType: assetContentType(file.route) });
        }
        let jwt: string | null = null;
        if (single) {
          for (const f of payload) {
            const res = await api.assets.uploadFile(session.jwt, {
              hash: f.hash,
              body: f.bytes,
              contentType: f.contentType,
            });
            jwt = res.jwt ?? jwt;
          }
        } else {
          const res = await api.assets.uploadBucket(
            session.jwt,
            payload.map((f) => ({
              hash: f.hash,
              base64: Buffer.from(f.bytes).toString("base64"),
              contentType: f.contentType,
            })),
          );
          jwt = res.jwt ?? null;
        }
        log.info(`Uploaded ${payload.length} asset file(s), ${bytes} bytes.`);
        return { jwt };
      });
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

/** A D1 database of the install and the migration files the artifact ships for its binding. */
export interface D1Target {
  binding: string;
  name: string;
  cfId: string;
  files: readonly D1MigrationFile[];
}

/**
 * D1 migrations the way `wrangler d1 migrations apply --remote` does them:
 * ensure `d1_migrations`, list what is applied, then apply each file not yet
 * recorded, in filename order, one file per step. On a database that already
 * has migrations only the new files run. Returns how many files it applied.
 */
export async function applyD1MigrationsPhase(
  steps: JobSteps,
  zipUrl: string,
  target: D1Target,
): Promise<number> {
  if (target.files.length === 0) return 0;
  await steps.run(`D1 ${target.binding}: create d1_migrations table`, 1, async ({ log, cf }) => {
    await cf().d1.query(target.cfId, CREATE_MIGRATIONS_TABLE_SQL);
    log.info(`Ensured "d1_migrations" exists in ${target.name}.`);
    return {};
  });
  const listed = await steps.run(
    `D1 ${target.binding}: list applied migrations`,
    1,
    async ({ log, cf }) => {
      const results = await cf().d1.query(target.cfId, LIST_APPLIED_MIGRATIONS_SQL);
      const rows = results[0]?.results ?? [];
      log.info(`${rows.length} migration(s) already applied to ${target.name}.`);
      return { applied: rows.map((r) => String(r.name)) };
    },
  );
  const pending = unappliedMigrations(
    target.files,
    listed.applied.map((name) => ({ name })),
  );
  if (pending.length === 0) {
    await steps.run(`D1 ${target.binding}: no new migrations`, 0, async ({ log }) => {
      log.info(`${target.name} already has every migration this version ships.`);
      return {};
    });
    return 0;
  }
  for (const file of pending) {
    await steps.run(
      `D1 ${target.binding}: apply ${file.name}`,
      ARTIFACT_FETCH_COST + 2,
      async ({ log, fetch, cf, attempt }) => {
        const api = cf();
        // A retry must not re-run a file an earlier attempt already applied.
        if (attempt > 1) {
          const recorded = await api.d1.query(target.cfId, APPLIED_MIGRATION_SQL, [file.name]);
          if ((recorded[0]?.results.length ?? 0) > 0) {
            log.info(`${file.name} was applied by an earlier attempt.`);
            return {};
          }
        }
        const got = await fetchArtifactFile(fetch, zipUrl, file);
        const sql = new TextDecoder().decode(got.bytes);
        await api.d1.query(target.cfId, buildMigrationQuery(sql, file.name));
        log.info(`Applied ${file.name} to ${target.name}.`);
        return {};
      },
    );
  }
  return pending.length;
}

/** The D1 targets of a manifest: every database resource whose binding ships migrations. */
export function d1Targets(
  manifest: ArtifactManifest,
  databases: readonly CreatedResource[],
): D1Target[] {
  return databases
    .filter((r) => r.type === "d1")
    .map((r) => ({
      binding: r.binding,
      name: r.name,
      cfId: r.cfId,
      files: manifest.d1Migrations[r.binding] ?? [],
    }))
    .filter((t) => t.files.length > 0);
}

/** Step "look up workers.dev subdomain": cached in settings after the first lookup. */
export async function lookupSubdomainPhase(steps: JobSteps): Promise<string> {
  const { subdomain } = await steps.run(
    "look up workers.dev subdomain",
    1,
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

export interface ProbePhaseOptions {
  /** Step names are `<label> check N` and sleeps `<label> wait N` ("canary"). */
  label: string;
  url: string;
  /** What a healthy answer means, for the log ("the Worker is serving"). */
  healthyMessage: string;
  maxAttempts?: number;
  /** When set, a JSON answer reporting another `version` fails (see `versionMismatch`). */
  expectVersion?: string;
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
 * before anything serves the version.
 */
export async function probeUntilHealthy(
  steps: JobSteps,
  step: StepRunner,
  opts: ProbePhaseOptions,
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? HEALTH_MAX_ATTEMPTS;
  let firstProbeAt: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const checked = await steps.run(`${opts.label} check ${attempt}`, 1, async ({ log, fetch }) => {
      const at = steps.now();
      const probe: HealthProbe = await probeHealth(fetch, opts.url);
      const verdict = (opts.classify ?? classifyHealthProbe)(
        probe,
        attempt,
        at - (firstProbeAt ?? at),
        maxAttempts,
      );
      if (verdict.verdict === "unhealthy") throw new JobError(verdict.reason);
      const wrong =
        verdict.verdict === "healthy" && opts.expectVersion !== undefined
          ? versionMismatch(probe, opts.expectVersion)
          : null;
      if (wrong !== null) throw new JobError(`GET ${opts.url}: ${wrong}`);
      if (verdict.verdict === "healthy") {
        log.info(`GET ${opts.url} -> ${verdict.status}; ${opts.healthyMessage}.`);
      } else {
        log.warn(`GET ${opts.url}: ${verdict.reason}; retrying in 2 seconds.`);
      }
      return { at, status: verdict.verdict === "healthy" ? verdict.status : null };
    });
    firstProbeAt ??= checked.at;
    if (checked.status !== null) return checked.status;
    await step.sleep(`${opts.label} wait ${attempt}`, HEALTH_RETRY_DELAY);
    steps.resetBudget();
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
 * propagation, error 1042, and 5xx answers. One step per probe, so each
 * invocation makes one subrequest plus its log write, and a `step.sleep`
 * between probes. Never throws for what the Worker answers: by now
 * everything is created or promoted, so the result is recorded on the install
 * instead (`verified`, `unverified`, `unhealthy`) and a warning is logged when
 * the Worker could not be verified.
 */
export async function checkLiveHealthPhase(
  steps: JobSteps,
  step: StepRunner,
  url: string,
): Promise<LiveHealthResult> {
  let firstProbeAt: number | null = null;
  for (let attempt = 1; ; attempt++) {
    const checked = await steps.run(`health check ${attempt}`, 1, async ({ log, fetch }) => {
      const at = steps.now();
      const probe = await probeHealth(fetch, url);
      const decision = decideLiveHealth(probe, attempt, at - (firstProbeAt ?? at));
      if (!decision.done) {
        log.warn(`GET ${url}: ${decision.reason}; retrying in ${decision.delaySeconds} seconds.`);
      } else if (decision.status === "verified") {
        log.info(`GET ${url} -> ${decision.detail}; the Worker is serving.`);
      } else if (decision.status === "unhealthy") {
        log.warn(
          `GET ${url} -> ${decision.detail}: the Worker answers with a server error. Everything was created; open the app to check, or check again from its page.`,
        );
      } else {
        log.warn(
          `Could not verify ${url} after ${attempt} attempts (${decision.detail}). Everything was created; the route may still be going live. Open the app to check, or check again from its page.`,
        );
      }
      return { at, decision };
    });
    firstProbeAt ??= checked.at;
    const { decision } = checked;
    if (decision.done) {
      return { status: decision.status, detail: decision.detail, checkedAt: checked.at };
    }
    await step.sleep(`health wait ${attempt}`, `${decision.delaySeconds} seconds`);
    steps.resetBudget();
  }
}

/**
 * Step "set cron triggers" when the wanted schedule differs from the recorded
 * one. Cron triggers belong to the script, not to a version, so this runs
 * after the version that expects them serves traffic. Replaced triggers are
 * marked deleted; they hold no data.
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
  await steps.run("set cron triggers", 1, async ({ log, cf, orm }) => {
    await cf().workers.putSchedules(
      workerName,
      [...want].map((cron) => ({ cron })),
    );
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
