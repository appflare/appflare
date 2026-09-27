import type { WorkerBinding as UploadBinding } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  SANDBOX_ENTRYPOINT,
  SANDBOX_WORKER_NAME,
  type SigningKey,
  signingKeys,
  verifyManifestSignature,
} from "@appflare/schema";
import { z } from "zod";
import { SANDBOX_BINDING } from "../../sandbox/binding";
import { ArtifactError } from "../install/artifact";
import { PASSTHROUGH_BINDING_TYPES } from "../install/bindings";
import {
  classifyHealthProbe,
  HEALTH_MAX_ATTEMPTS,
  type HealthProbe,
  type HealthVerdict,
  isEdge1042,
} from "../install/health";
import { JOB_UNITS_ENTRYPOINT, SELF_BINDING } from "../units/units";

/**
 * The pure decisions of the manager's self-update: which signed manifests
 * describe an Appflare release, which bindings the new version gets, whether
 * the new version's preview is healthy, and how the version history grows.
 */

/** The artifact manifest's `app` of every manager release. */
export const MANAGER_APP = "appflare";

/** The binding that tells a manager build its own version. */
export const VERSION_BINDING = "APPFLARE_VERSION";

/**
 * Manager releases are signed with `appflare-*` key ids (today
 * `appflare-2026-09`); catalog artifacts use `catalog-*` ids. A catalog key
 * must never be able to replace the manager, even while both ids share one
 * keypair.
 */
export function isManagerKeyId(keyId: string): boolean {
  return keyId.startsWith("appflare-");
}

/**
 * Verifies a manager release's `manifest.json` against `manifest.sig`: the
 * signature (key selected by the manifest's `keyId`; unknown ids and
 * `unsigned` are rejected), a manager key id, the schema, `app`, and the
 * requested version. Throws `ArtifactError`.
 */
export async function verifyManagerManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  expectedVersion: string,
  keys: readonly SigningKey[] = signingKeys,
): Promise<ArtifactManifest> {
  let keyId: string;
  try {
    ({ keyId } = await verifyManifestSignature(manifestBytes, signatureBase64.trim(), keys));
  } catch (error) {
    throw new ArtifactError(error instanceof Error ? error.message : String(error));
  }
  if (!isManagerKeyId(keyId)) {
    throw new ArtifactError(
      `manifest.json is signed with "${keyId}", which does not sign Appflare releases`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new ArtifactError("manifest.json is not valid JSON");
  }
  const parsed = artifactManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArtifactError(
      `manifest.json is not a valid artifact manifest: ${parsed.error.message}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.app !== MANAGER_APP) {
    throw new ArtifactError(`the artifact is "${manifest.app}", not an Appflare release`);
  }
  if (manifest.version !== expectedVersion) {
    throw new ArtifactError(
      `the artifact is version ${manifest.version}, the release is ${expectedVersion}`,
    );
  }
  if (manifest.worker.migrations.length > 0) {
    throw new ArtifactError(
      "the release declares Durable Object migrations, which a self-update cannot apply",
    );
  }
  // Appflare is code; an artifact of static assets only cannot be a release of it.
  if (manifest.worker.mainModule === undefined) {
    throw new ArtifactError("the release has no Worker code (it serves static assets only)");
  }
  return manifest;
}

const currentBindingSchema = z.looseObject({ type: z.string().min(1), name: z.string().min(1) });

export interface SelfUpdateBindings {
  /** Every binding the new version is uploaded with, except secrets and the assets binding. */
  bindings: UploadBinding[];
  /** The D1 database behind `DB`, for the snapshot's bookmark; null when unknown. */
  databaseId: string | null;
  /** Why the upload cannot proceed; empty when it can. */
  problems: string[];
  /** Bindings copied as the API reported them, without Appflare knowing their type. */
  warnings: string[];
}

/** Bindings the manager cannot run without. */
const REQUIRED: ReadonlyArray<{ name: string; type: string }> = [
  { name: "DB", type: "d1" },
  { name: "KV", type: "kv_namespace" },
  { name: "JOBS", type: "workflow" },
];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The new version's bindings, copied from the running script
 * (`GET /workers/scripts/<name>/bindings`) rather than from the artifact:
 * the manager's D1, KV, and Workflow were created for this account, and a
 * manager installed under another name has its Workflow named after it
 * (`<name>-jobs`), which must stay bound or every job is lost.
 *
 * - `secret_text` bindings are left out; `keep_bindings` carries them.
 * - The `assets` binding is left out; the upload sends it with the new assets.
 * - `APPFLARE_VERSION` becomes the new version; another var reported without
 *   its value is refused rather than emptied.
 * - A binding of a type Appflare does not know is copied as reported, with a
 *   warning for the job log.
 * - A binding the new version declares that the Worker lacks is added when it
 *   needs no resource (a var, Workers AI, ...); one that needs a resource is
 *   refused, since the manager does not create resources for itself.
 * - `SELF` is always the service binding to this Worker itself (`service:
 *   <workerName>`, entrypoint `JobUnits`), whether or not the running Worker
 *   has it yet: a manager deployed before job units existed gains it with
 *   its next self-update. The release does not declare it, since only the
 *   running manager knows its own Worker name. A `SELF` the running Worker
 *   has that points at another Worker, or a binding of another type named
 *   `SELF`, is refused rather than replaced.
 * - `SANDBOX` is the service binding to the sandbox Worker (`service:
 *   appflare-sandbox`, entrypoint `SandboxBuilds`). It is added when the
 *   account has a Worker by that name (`sandboxWorker`), kept while it does,
 *   and left out, with a warning, once it is gone: a binding to a Worker that
 *   does not exist serves nothing. The release does not declare it, since
 *   the sandbox Worker is optional. When `sandboxWorker` is not known, a
 *   `SANDBOX` the running Worker has is kept as is. A `SANDBOX` that points
 *   at another Worker, or a binding of another type by that name, is refused.
 * - Other `service` bindings are copied as reported.
 */
export function selfUpdateBindings(input: {
  current: readonly unknown[];
  manifest: Pick<ArtifactManifest, "worker" | "assets">;
  workerName: string;
  newVersion: string;
  /** Whether the account has the sandbox Worker; undefined when it was not checked. */
  sandboxWorker?: boolean;
}): SelfUpdateBindings {
  const { manifest, workerName, newVersion } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const out: UploadBinding[] = [];
  let databaseId: string | null = null;
  const assetsBinding = manifest.assets.binding;
  /** A foreign binding holds the name SELF (already reported as a problem). */
  let selfTaken = false;
  /** The running Worker's SANDBOX: absent, Appflare's own, or someone else's (a problem). */
  let sandbox: "none" | "ours" | "foreign" = "none";

  for (const raw of input.current) {
    const parsed = currentBindingSchema.safeParse(raw);
    if (!parsed.success) continue;
    const b = parsed.data;
    switch (b.type) {
      case "secret_text":
        continue;
      case "assets":
        continue;
      case "d1": {
        // The API reports `database_id` (older answers: `id`); uploads take `id`.
        const id = text(b.database_id) ?? text(b.id);
        if (id === undefined) {
          problems.push(`The running Worker reports D1 binding ${b.name} without a database id.`);
          continue;
        }
        if (b.name === "DB") databaseId = id;
        out.push({ type: "d1", name: b.name, id });
        continue;
      }
      case "kv_namespace": {
        const id = text(b.namespace_id);
        if (id === undefined) {
          problems.push(`The running Worker reports KV binding ${b.name} without a namespace id.`);
          continue;
        }
        out.push({ type: "kv_namespace", name: b.name, namespace_id: id });
        continue;
      }
      case "workflow": {
        const workflowName = text(b.workflow_name);
        if (workflowName === undefined) {
          problems.push(`The running Worker reports Workflow binding ${b.name} without a name.`);
          continue;
        }
        const binding: UploadBinding = {
          type: "workflow",
          name: b.name,
          workflow_name: workflowName,
        };
        // The class that implements the Workflow; the new version's own
        // declaration fills it in if the API left it out.
        const declared = manifest.worker.bindings.find(
          (w) => w.type === "workflow" && w.name === b.name,
        );
        const className = text(b.class_name) ?? text(declared?.class_name);
        if (className !== undefined) binding.class_name = className;
        const scriptName = text(b.script_name);
        if (scriptName !== undefined && scriptName !== workerName) binding.script_name = scriptName;
        out.push(binding);
        continue;
      }
      case "service": {
        if (b.name === SELF_BINDING) {
          // Re-added below. A SELF that points at another Worker is not one
          // Appflare made; replacing it could break whatever relies on it.
          if (text(b.service) !== workerName) {
            problems.push(
              `The running Worker's service binding ${SELF_BINDING} points at "${text(b.service) ?? "(no service)"}", not at this Worker ("${workerName}"); Appflare needs ${SELF_BINDING} for its binding to itself. Remove or rename that binding first.`,
            );
            selfTaken = true;
          }
          continue;
        }
        if (b.name === SANDBOX_BINDING) {
          // Re-added below when the sandbox Worker still exists.
          if (text(b.service) === SANDBOX_WORKER_NAME) {
            sandbox = "ours";
          } else {
            problems.push(
              `The running Worker's service binding ${SANDBOX_BINDING} points at "${text(b.service) ?? "(no service)"}", not at the sandbox Worker ("${SANDBOX_WORKER_NAME}"); Appflare needs ${SANDBOX_BINDING} for sandbox builds. Remove or rename that binding first.`,
            );
            sandbox = "foreign";
          }
          continue;
        }
        const service = text(b.service);
        if (service === undefined) {
          problems.push(`The running Worker reports service binding ${b.name} without a service.`);
          continue;
        }
        const binding: UploadBinding = { type: "service", name: b.name, service };
        const environment = text(b.environment);
        if (environment !== undefined) binding.environment = environment;
        const entrypoint = text(b.entrypoint);
        if (entrypoint !== undefined) binding.entrypoint = entrypoint;
        out.push(binding);
        continue;
      }
      case "plain_text": {
        if (b.name === VERSION_BINDING) {
          out.push({ type: "plain_text", name: b.name, text: newVersion });
        } else if (typeof b.text === "string") {
          out.push({ type: "plain_text", name: b.name, text: b.text });
        } else {
          problems.push(
            `The running Worker reports variable ${b.name} without its value, so the new version cannot keep it.`,
          );
        }
        continue;
      }
      default:
        // Sent back as the API reported it. Types an install also sends as
        // recorded carry no account ids; for any other, say so in the log.
        if (!PASSTHROUGH_BINDING_TYPES.has(b.type)) {
          warnings.push(
            `Binding ${b.name} has type "${b.type}", which Appflare does not know; it is copied to the new version as Cloudflare reports it.`,
          );
        }
        out.push({ ...b });
    }
  }

  const byName = new Map(out.map((b) => [b.name, b]));
  for (const wanted of manifest.worker.bindings) {
    if (wanted.name === assetsBinding || wanted.type === "secret_text") continue;
    if (wanted.name === SELF_BINDING && wanted.type === "service") continue;
    if (wanted.name === SANDBOX_BINDING && wanted.type === "service") continue;
    const have = byName.get(wanted.name);
    if (have !== undefined) {
      if (have.type !== wanted.type) {
        problems.push(
          `Binding ${wanted.name} is a ${have.type} binding on the running Worker and a ${wanted.type} binding in the new version.`,
        );
      }
      continue;
    }
    if (PASSTHROUGH_BINDING_TYPES.has(wanted.type)) {
      const added: UploadBinding = { ...wanted };
      out.push(added);
      byName.set(added.name, added);
    } else {
      problems.push(
        `The new version needs a ${wanted.type} binding ${wanted.name}, which the running Worker does not have; Appflare does not create resources for itself.`,
      );
    }
  }

  // A SELF service binding to another Worker was refused above.
  const taken = byName.get(SELF_BINDING);
  if (selfTaken) {
    // Nothing is added in its place.
  } else if (taken !== undefined) {
    problems.push(
      `The running Worker has a ${taken.type} binding named ${SELF_BINDING}, which Appflare needs for the service binding to itself.`,
    );
  } else {
    const self: UploadBinding = {
      type: "service",
      name: SELF_BINDING,
      service: workerName,
      entrypoint: JOB_UNITS_ENTRYPOINT,
    };
    out.push(self);
    byName.set(SELF_BINDING, self);
  }

  const sandboxTaken = byName.get(SANDBOX_BINDING);
  const wantSandbox = input.sandboxWorker ?? sandbox === "ours";
  if (sandbox === "foreign") {
    // Refused above; nothing is added in its place.
  } else if (sandboxTaken !== undefined) {
    if (wantSandbox) {
      problems.push(
        `The running Worker has a ${sandboxTaken.type} binding named ${SANDBOX_BINDING}, which Appflare needs for the service binding to the sandbox Worker.`,
      );
    }
  } else if (wantSandbox) {
    const binding: UploadBinding = {
      type: "service",
      name: SANDBOX_BINDING,
      service: SANDBOX_WORKER_NAME,
      entrypoint: SANDBOX_ENTRYPOINT,
    };
    out.push(binding);
    byName.set(SANDBOX_BINDING, binding);
  } else if (sandbox === "ours") {
    warnings.push(
      `The sandbox Worker "${SANDBOX_WORKER_NAME}" no longer exists, so the new version has no ${SANDBOX_BINDING} binding; sandbox tier apps cannot be installed or updated until it is enabled again.`,
    );
  }

  const version = byName.get(VERSION_BINDING);
  if (version === undefined) {
    out.push({ type: "plain_text", name: VERSION_BINDING, text: newVersion });
  } else if (version.type === "plain_text") {
    version.text = newVersion;
  }

  for (const req of REQUIRED) {
    const b = byName.get(req.name);
    if (b === undefined || b.type !== req.type) {
      problems.push(`The running Worker has no ${req.type} binding ${req.name}.`);
    }
  }
  return { bindings: out, databaseId, problems, warnings };
}

/**
 * The canary verdict for the new version's preview `/api/health`. Retries
 * while the preview is not reachable yet (error 1042, a connection error, a
 * 404 while the route propagates) and on a 5xx for a short grace period (the
 * first request of the new version migrates the database). Healthy only when
 * the body is Appflare's health report naming the new version with `db: "ok"`.
 */
export function classifyManagerCanary(
  probe: HealthProbe,
  expectedVersion: string,
  attempt: number,
  elapsedMs: number,
  maxAttempts: number = HEALTH_MAX_ATTEMPTS,
): HealthVerdict {
  const last = attempt >= maxAttempts;
  if (probe.kind === "error" || isEdge1042(probe) || probe.status >= 500) {
    const verdict = classifyHealthProbe(probe, attempt, elapsedMs, maxAttempts);
    return verdict.verdict === "healthy"
      ? { verdict: "unhealthy", reason: `the preview answered HTTP ${verdict.status}` }
      : verdict;
  }
  if (probe.status === 404) {
    return last
      ? { verdict: "unhealthy", reason: `HTTP 404 after ${attempt} attempts` }
      : { verdict: "retry", reason: "HTTP 404 (the preview is not live yet)" };
  }
  let report: { version?: unknown; db?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(probe.body ?? probe.bodyStart);
    if (typeof parsed === "object" && parsed !== null) report = parsed;
  } catch {
    // Not JSON: handled below.
  }
  if (report === null || typeof report.version !== "string") {
    return {
      verdict: "unhealthy",
      reason: `the preview answered HTTP ${probe.status} without Appflare's health report`,
    };
  }
  if (report.version !== expectedVersion) {
    return {
      verdict: "unhealthy",
      reason: `the preview reports version ${report.version}, not ${expectedVersion}`,
    };
  }
  if (report.db !== "ok") {
    return {
      verdict: "unhealthy",
      reason: `the preview reports its database as ${JSON.stringify(report.db ?? null)}`,
    };
  }
  if (probe.status < 200 || probe.status >= 300) {
    return { verdict: "unhealthy", reason: `the preview answered HTTP ${probe.status}` };
  }
  return { verdict: "healthy", status: probe.status };
}

export interface VersionHistoryEntry {
  version: string;
  /** The version it replaced. */
  from: string;
  jobId: string;
  /** The Workers version that serves it; null when the job did not record one. */
  workerVersionId: string | null;
  /** ISO 8601 */
  at: string;
}

const historySchema = z.array(
  z.object({
    version: z.string(),
    from: z.string(),
    jobId: z.string(),
    workerVersionId: z.string().nullable(),
    at: z.string(),
  }),
);

/** Entries kept in `settings.manager_version_history`. */
export const VERSION_HISTORY_LIMIT = 50;

export function parseVersionHistory(json: string | undefined | null): VersionHistoryEntry[] {
  if (json == null) return [];
  try {
    const parsed = historySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Appends one self-update to the history (once per job), keeping the newest entries. */
export function appendVersionHistory(
  json: string | undefined | null,
  entry: VersionHistoryEntry,
  limit: number = VERSION_HISTORY_LIMIT,
): string {
  const history = parseVersionHistory(json);
  if (!history.some((e) => e.jobId === entry.jobId)) history.push(entry);
  return JSON.stringify(history.slice(-limit));
}
