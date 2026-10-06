import {
  buildAssetsManifest,
  DOMAIN_DNS_RECORD_CONFLICT,
  DOMAIN_ORIGIN_CONFLICT,
  isWorkflowNotFound,
  type WorkflowInfo,
} from "@appflare/cf-api";
import { checkHostname } from "../checks";
import { classifyCloudflareError, hasCode } from "../cloudflare";
import type { InstallationRow } from "../db/schema";
import { createdByAttempt, kvByAttempt } from "../ownership";
import { pendingMessage, probeHandoff, proofRetryAfterMs } from "../proof";
import { assetContentType, jwtClaims, planAssetParts, toBase64 } from "../release/assets";
import { HANDOFF_SECRET, releaseFiles } from "../release/manifest";
import { releaseReader, verifyReleaseFiles } from "../release/reader";
import { type StepContext, StepFailure, type StepResult } from "./context";
import { handoffSecretValue, managerMetadata, uploadModule } from "./upload";

/**
 * The deploy, as steps that each fit one request (at most 40 subrequests)
 * and can run again safely: a step finds what an earlier, interrupted run of
 * itself did, and never adopts or replaces anything this installation did
 * not create. A create is recorded as attempted before it is sent, so a
 * resource of the same name made while that request ran is recognised as
 * the one whose answer was lost; any other is refused (ownership.ts).
 */

export const STEP_IDS = [
  "release",
  "database",
  "storage",
  "assets",
  "worker",
  "workflow",
  "schedules",
  "secret",
  "workers-dev",
  "domain",
  "proof",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  release: "Check the Appflare release",
  database: "Create the database",
  storage: "Create the key-value storage",
  assets: "Upload Appflare's files",
  worker: "Upload Appflare",
  workflow: "Set up background jobs",
  schedules: "Schedule regular checks",
  secret: "Store the setup key",
  "workers-dev": "Turn on the workers.dev address",
  domain: "Connect your domain",
  proof: "Wait for Appflare to answer",
};

export function isStepId(value: string): value is StepId {
  return (STEP_IDS as readonly string[]).includes(value);
}

/** The steps an installation runs: the domain only with a hostname, workers.dev only with a subdomain. */
export function stepsFor(
  record: Pick<InstallationRow, "hostname" | "workers_dev_subdomain">,
): StepId[] {
  return STEP_IDS.filter((id) => {
    if (id === "domain") return record.hostname !== null;
    if (id === "workers-dev") return record.workers_dev_subdomain !== null;
    return true;
  });
}

function startAgain(what: string): string {
  return `${what} was created in this Cloudflare account by something else after this installation started. Remove it in the Cloudflare dashboard, or remove this installation and start again with another name.`;
}

type AttemptMark = "d1_attempt_at" | "kv_attempt_at" | "worker_attempt_at";

/**
 * Sends a create with its attempt recorded first (ownership.ts). When
 * Cloudflare definitely refused it (any answer but a server error, a rate
 * limit or no answer at all), nothing was made, so the mark is cleared: a
 * resource of the same name made later is never taken as this one.
 */
async function attempted<T>(
  ctx: StepContext,
  mark: AttemptMark,
  create: () => Promise<T>,
): Promise<T> {
  await ctx.save({ [mark]: ctx.now });
  try {
    return await create();
  } catch (error) {
    if (classifyCloudflareError(error) !== "transient") await ctx.save({ [mark]: null });
    throw error;
  }
}

async function release(ctx: StepContext): Promise<StepResult> {
  const files = releaseFiles(ctx.manifest);
  await verifyReleaseFiles(ctx.fetch, ctx.record.release_zip_url, files);
  return {
    kind: "done",
    message: `All ${files.length} files of Appflare ${ctx.record.release_version} match their signature.`,
  };
}

async function database(ctx: StepContext): Promise<StepResult> {
  const { record, api } = ctx;
  if (record.d1_id !== null) return { kind: "done" };
  const existing = (await api.d1.listDatabases()).find((d) => d.name === record.d1_name);
  if (existing !== undefined) {
    if (!createdByAttempt(existing.created_at, record.d1_attempt_at)) {
      throw new StepFailure(startAgain(`A D1 database named "${record.d1_name}"`));
    }
    await ctx.save({ d1_id: existing.uuid, d1_attempt_at: null });
    return { kind: "done" };
  }
  const created = await attempted(ctx, "d1_attempt_at", () =>
    api.d1.createDatabase(record.d1_name),
  );
  await ctx.save({ d1_id: created.uuid, d1_attempt_at: null });
  return { kind: "done", message: `Created the D1 database "${record.d1_name}".` };
}

async function storage(ctx: StepContext): Promise<StepResult> {
  const { record, api } = ctx;
  if (record.kv_id !== null) return { kind: "done" };
  const sameTitle = (await api.kv.listNamespaces()).filter((n) => n.title === record.kv_title);
  const [existing] = sameTitle;
  if (existing !== undefined) {
    if (!kvByAttempt(sameTitle.length, record.kv_attempt_at, ctx.now)) {
      throw new StepFailure(
        record.kv_attempt_at === null
          ? startAgain(`A KV namespace named "${record.kv_title}"`)
          : `A KV namespace named "${record.kv_title}" exists, and this installation cannot tell whether it made it. Remove it in the Cloudflare dashboard if it is not in use, or remove this installation and start again with another name.`,
      );
    }
    await ctx.save({ kv_id: existing.id, kv_attempt_at: null });
    return { kind: "done" };
  }
  const created = await attempted(ctx, "kv_attempt_at", () =>
    api.kv.createNamespace(record.kv_title),
  );
  await ctx.save({ kv_id: created.id, kv_attempt_at: null });
  return { kind: "done", message: `Created the KV namespace "${record.kv_title}".` };
}

/**
 * Static files, in parts sized to the request's budget: each request opens
 * an upload session (Cloudflare answers only the files it does not store
 * yet), uploads as many parts of what it asks for as the request's budget
 * allows, and continues in the next request until the session asks for
 * nothing.
 */
async function assets(ctx: StepContext): Promise<StepResult> {
  const { record, api, manifest } = ctx;
  const files = manifest.assets.files;
  if (files.length === 0) return { kind: "done" };
  const session = await api.assets.createUploadSession(
    record.worker_name,
    buildAssetsManifest(files.map((f) => ({ route: f.route, hash: f.hash, size: f.size }))),
  );
  const needed = session.buckets.flat();
  if (needed.length === 0) {
    return { kind: "done", message: `All ${files.length} files are uploaded.` };
  }
  const byHash = new Map(files.map((f) => [f.hash, f]));
  const single = jwtClaims(session.jwt).wrangler_single_asset_uploads === true;
  const parts = session.buckets.flatMap((bucket) =>
    planAssetParts(
      bucket.map((hash) => {
        const file = byHash.get(hash);
        if (file === undefined) {
          throw new StepFailure("Cloudflare asked for a file this Appflare release does not have.");
        }
        return file;
      }),
      single,
    ),
  );
  let uploaded = 0;
  for (const part of parts) {
    // A part never starts unless its worst case fits what is left of the budget.
    if (uploaded > 0 && part.subrequests + ASSET_RESERVE > ctx.budget.remaining) break;
    const contents = await releaseReader(ctx.fetch, record.release_zip_url).read(part.files);
    let completion: string | null = null;
    if (single) {
      for (const [i, file] of part.files.entries()) {
        const res = await api.assets.uploadFile(session.jwt, {
          hash: file.hash,
          body: contents[i] ?? new Uint8Array(0),
          contentType: assetContentType(file.route),
        });
        completion = res.jwt ?? completion;
      }
    } else {
      const res = await api.assets.uploadBucket(
        session.jwt,
        part.files.map((file, i) => ({
          hash: file.hash,
          base64: toBase64(contents[i] ?? new Uint8Array(0)),
          contentType: assetContentType(file.route),
        })),
      );
      completion = res.jwt ?? null;
    }
    uploaded += part.files.length;
    if (completion !== null) {
      return { kind: "done", message: `All ${files.length} files are uploaded.` };
    }
  }
  const left = needed.length - uploaded;
  return {
    kind: "again",
    message: `Uploaded ${files.length - left} of ${files.length} files.`,
  };
}

/** Subrequests kept free after the asset parts of one request. */
const ASSET_RESERVE = 2;

/** Times the Worker upload may send the asset upload back for files Cloudflare asks for again. */
const MAX_ASSET_ROUNDS = 3;

async function worker(ctx: StepContext): Promise<StepResult> {
  const { record, api, manifest } = ctx;
  if (record.d1_id === null || record.kv_id === null) {
    throw new StepFailure("The database or storage of this installation is missing.");
  }
  if (!record.worker_created) {
    const existing = (await api.workers.listScripts()).find((s) => s.id === record.worker_name);
    if (existing !== undefined) {
      if (!createdByAttempt(existing.created_on, record.worker_attempt_at)) {
        throw new StepFailure(startAgain(`A Worker named "${record.worker_name}"`));
      }
      await ctx.save({ worker_created: true, worker_attempt_at: null });
    }
  }
  let assetsJwt: string | null = null;
  if (manifest.assets.files.length > 0) {
    const session = await api.assets.createUploadSession(
      record.worker_name,
      buildAssetsManifest(
        manifest.assets.files.map((f) => ({ route: f.route, hash: f.hash, size: f.size })),
      ),
    );
    if (session.buckets.flat().length > 0) {
      if (record.asset_rounds >= MAX_ASSET_ROUNDS) {
        throw new StepFailure(
          "Cloudflare keeps asking for Appflare's files again after they were uploaded. Try again later.",
        );
      }
      await ctx.save({ step: "assets", asset_rounds: record.asset_rounds + 1 });
      return { kind: "again", message: "Some of Appflare's files need uploading again." };
    }
    assetsJwt = session.jwt;
  }
  const modules = manifest.worker.modules;
  const contents = await releaseReader(ctx.fetch, record.release_zip_url).read(modules);
  const metadata = managerMetadata(manifest, {
    workerName: record.worker_name,
    d1Id: record.d1_id,
    kvId: record.kv_id,
    workflowName: record.workflow_name,
    installerOrigin: ctx.config.origin,
    handoffHash: record.handoff_hash,
    assetsJwt,
  });
  const upload = () =>
    api.workers.uploadScript(record.worker_name, {
      metadata,
      modules: modules.map((m, i) => uploadModule(m, contents[i] ?? new Uint8Array(0))),
      excludeScript: true,
    });
  // Uploading again over the installation's own Worker creates nothing new.
  if (record.worker_created) await upload();
  else await attempted(ctx, "worker_attempt_at", upload);
  await ctx.save({ worker_created: true, worker_attempt_at: null });
  return { kind: "done", message: `Uploaded Appflare ${record.release_version}.` };
}

async function workflow(ctx: StepContext): Promise<StepResult> {
  const { record, api, manifest } = ctx;
  const binding = manifest.worker.bindings.find((b) => b.type === "workflow");
  if (binding === undefined) return { kind: "done" };
  let existing: WorkflowInfo | null = null;
  try {
    existing = await api.workflows.getWorkflow(record.workflow_name);
  } catch (error) {
    if (!isWorkflowNotFound(error)) throw error;
  }
  if (existing !== null && existing.script_name !== record.worker_name) {
    throw new StepFailure(
      `The Workflow "${record.workflow_name}" belongs to another Worker in this account. Remove this installation and start again with another name.`,
    );
  }
  await api.workflows.putWorkflow(record.workflow_name, {
    script_name: record.worker_name,
    class_name: String(binding.class_name),
  });
  await ctx.save({ workflow_created: true });
  return { kind: "done" };
}

/** `PUT .../schedules` refused because the account has used every cron trigger its plan allows. */
const CRON_LIMIT_CODE = 10072;

async function schedules(ctx: StepContext): Promise<StepResult> {
  const crons = ctx.manifest.worker.crons;
  try {
    await ctx.api.workers.putSchedules(
      ctx.record.worker_name,
      crons.map((cron) => ({ cron })),
    );
  } catch (error) {
    if (!hasCode(error, CRON_LIMIT_CODE)) throw error;
    return {
      kind: "done",
      message:
        "This account already uses every scheduled trigger its Workers plan allows, so Appflare's regular checks (such as looking for updates) do not run on their own. Appflare works; free a trigger in another Worker to turn them on.",
    };
  }
  return { kind: "done" };
}

async function secret(ctx: StepContext): Promise<StepResult> {
  const { record, api } = ctx;
  const secrets = await api.workers.listSecrets(record.worker_name);
  if (!secrets.some((s) => s.name === HANDOFF_SECRET)) {
    await api.workers.putSecret(record.worker_name, {
      name: HANDOFF_SECRET,
      text: handoffSecretValue(record.handoff_hash),
    });
  }
  return { kind: "done" };
}

async function workersDev(ctx: StepContext): Promise<StepResult> {
  if (ctx.record.workers_dev_subdomain === null) return { kind: "done" };
  // Version previews too: the manager checks a new version at its preview
  // address before it updates itself.
  await ctx.api.workers.enableSubdomain(ctx.record.worker_name, {
    enabled: true,
    previews_enabled: true,
  });
  return { kind: "done" };
}

async function domain(ctx: StepContext): Promise<StepResult> {
  const { record, api } = ctx;
  const hostname = record.hostname;
  if (hostname === null || record.domain_id !== null) return { kind: "done" };
  if (record.zone_id === null) throw new StepFailure("The domain of this installation is missing.");
  const zone = await api.zones.getZone(record.zone_id);
  if (
    zone.status !== "active" ||
    (zone.account !== undefined && zone.account.id !== api.accountId)
  ) {
    throw new StepFailure(`${zone.name} is no longer an active domain of this Cloudflare account.`);
  }
  if (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`)) {
    throw new StepFailure(`${hostname} is not part of ${zone.name}.`);
  }
  const check = await checkHostname(api, hostname, record.worker_name, zone);
  switch (check.kind) {
    case "no-zone":
      throw new StepFailure(`${hostname} is not part of ${zone.name}.`);
    case "conflict":
      throw new StepFailure(
        `${check.conflict.detail} Free it, or remove this installation and choose another address.`,
      );
    case "ours":
      await ctx.save({ domain_id: check.domainId });
      return { kind: "done" };
    case "free":
      break;
  }
  try {
    const attached = await api.workerDomains.attachDomain({
      zoneId: zone.id,
      hostname,
      service: record.worker_name,
    });
    await ctx.save({ domain_id: attached.id });
  } catch (error) {
    if (hasCode(error, DOMAIN_DNS_RECORD_CONFLICT)) {
      throw new StepFailure(
        `${hostname} has DNS records of its own, so it was not taken over. Remove them in the Cloudflare dashboard, then continue.`,
      );
    }
    if (hasCode(error, DOMAIN_ORIGIN_CONFLICT)) {
      throw new StepFailure(`${hostname} already serves another Worker, so it was not taken over.`);
    }
    throw error;
  }
  return { kind: "done", message: `Connected ${hostname}; Cloudflare now issues its certificate.` };
}

async function proof(ctx: StepContext): Promise<StepResult> {
  const attempts = ctx.record.proof_attempts + 1;
  await ctx.save({ proof_attempts: attempts });
  const result = await probeHandoff(ctx.fetch, ctx.record.address, ctx.record.handoff_hash);
  if (result.kind === "verified") {
    return { kind: "done", message: `Appflare answers at ${ctx.record.address}.` };
  }
  return {
    kind: "wait",
    retryAfterMs: proofRetryAfterMs(attempts),
    message: pendingMessage(result.reason),
  };
}

export const STEPS: Record<StepId, (ctx: StepContext) => Promise<StepResult>> = {
  release,
  database,
  storage,
  assets,
  worker,
  workflow,
  schedules,
  secret,
  "workers-dev": workersDev,
  domain,
  proof,
};
