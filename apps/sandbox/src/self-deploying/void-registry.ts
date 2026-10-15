import type { SelfManagedStep } from "@appflare/schema";
import { z } from "zod";
import { commandLine, STAGE_TIMEOUTS, WORK_ROOT } from "../protocol";
import { type CommandRunner, messageOf, StepError } from "../steps";

/**
 * The Void CLI's local registry (`VOID_PLATFORM_REGISTRY_DIR`), kept between
 * runs. Void records each installation it manages in that directory as
 * `<accountId>/<installationId>.json` (with its `status`), next to the
 * installation's secrets in `.secrets.enc` and `.recovery.enc` files, which
 * it encrypts with AES-256-GCM under the app's `VOID_PLATFORM_RECOVERY_KEY`
 * secret. Every run starts in a fresh container, so the directory is saved
 * to the sandbox bucket after each Void command, as one JSON object per
 * install (each file's path and bytes), and written back before the next.
 * Its lock files are left out: they belong to the process that held them,
 * and a run never shares the directory with another.
 */

/** Where the registry lives in the container (the work directory is wiped before each run). */
export const VOID_REGISTRY_DIR = `${WORK_ROOT}/void-registry`;
/** The snapshot file the registry script reads and writes. */
const SNAPSHOT_FILE = `${WORK_ROOT}/void-registry.json`;
/** The registry script, written into the container before its first use. */
const SCRIPT_FILE = `${WORK_ROOT}/void-registry.cjs`;

/** The bucket object that holds an install's registry. Outside `builds/`, so build cleanup and the object server never touch it. */
export function voidRegistryKey(installId: string): string {
  return `self-deploying/${installId}/void-registry.json`;
}

/** The largest registry kept: Void writes a few small JSON files per installation. */
export const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;

const FORMAT = "appflare-void-registry";

const relativePathSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "must be a relative path")
  .refine(
    (p) => !p.split("/").some((s) => s === "." || s === ".."),
    "must not leave the directory",
  );

/** The saved registry: each file's path, relative to the directory, and its bytes in base64. */
export const voidRegistrySnapshotSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  files: z.record(relativePathSchema, z.base64()),
});
export type VoidRegistrySnapshot = z.infer<typeof voidRegistrySnapshotSchema>;

export const EMPTY_REGISTRY: VoidRegistrySnapshot = { format: FORMAT, version: 1, files: {} };

/** A snapshot from its JSON text; throws a readable error when it is not one. */
export function parseRegistrySnapshot(text: string): VoidRegistrySnapshot {
  if (text.length > MAX_REGISTRY_BYTES) {
    throw new Error(`it is larger than ${MAX_REGISTRY_BYTES} bytes`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("it is not JSON");
  }
  const parsed = voidRegistrySnapshotSchema.safeParse(json);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error).replace(/\s+/g, " "));
  return parsed.data;
}

/** One installation as Void's registry records it: what deciding the next command needs. */
export interface VoidRecord {
  /** Void's installation id (`<stage>-<12 hex>`), which names the file. */
  id: string;
  status: string;
  /** Whether a runtime was deployed (the install finished once; Void's `runtime` is set). */
  hasRuntime: boolean;
  /** Void's `desiredState`: `enabled`, or `disabled` once it was turned off. */
  desiredState: string;
  /** Whether any of its resources is recorded as deleted (an uninstall got that far). */
  hasDeletedResources: boolean;
  updatedAt: string;
}

function decodeText(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The record of the installation named `stage` in `accountId`, or null when
 * the registry has none (an uninstalled one counts as none, as Void itself
 * treats it). Of several, the most recently updated.
 */
export function findVoidRecord(
  snapshot: VoidRegistrySnapshot,
  accountId: string,
  stage: string,
): VoidRecord | null {
  let found: VoidRecord | null = null;
  for (const [path, data] of Object.entries(snapshot.files)) {
    const parts = path.split("/");
    if (parts.length !== 2 || parts[0] !== accountId || !parts[1]?.endsWith(".json")) continue;
    let manifest: Record<string, unknown> | null;
    try {
      manifest = asRecord(JSON.parse(decodeText(data)));
    } catch {
      continue;
    }
    const deployment = asRecord(manifest?.deployment);
    if (manifest === null || deployment?.installationSlug !== stage) continue;
    const { id, status, updatedAt, runtime, desiredState, resources } = manifest;
    if (typeof id !== "string" || typeof status !== "string" || status === "uninstalled") continue;
    const record: VoidRecord = {
      id,
      status,
      hasRuntime: asRecord(runtime) !== null,
      desiredState: typeof desiredState === "string" ? desiredState : "",
      hasDeletedResources:
        Array.isArray(resources) && resources.some((r) => asRecord(r)?.state === "deleted"),
      updatedAt: typeof updatedAt === "string" ? updatedAt : "",
    };
    if (found === null || record.updatedAt > found.updatedAt) found = record;
  }
  return found;
}

/**
 * Saves (`save <dir> <file>`) the registry directory into a snapshot file,
 * or restores (`restore <dir> <file>`) it from one. Run with the container's
 * default Node; it needs nothing but Node's own modules.
 */
export const REGISTRY_SCRIPT = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [mode, dir, file] = process.argv.slice(2);
const root = path.resolve(dir);
const skipped = (rel) => rel === "locks" || rel.startsWith("locks/") || rel.endsWith(".lock");
if (mode === "save") {
  const files = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : rel + "/" + entry.name;
      if (skipped(child)) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files[child] = fs.readFileSync(path.join(root, child)).toString("base64");
    }
  };
  if (fs.existsSync(root)) walk("");
  fs.writeFileSync(file, JSON.stringify({ format: "${FORMAT}", version: 1, files }));
} else if (mode === "restore") {
  const { files } = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [rel, data] of Object.entries(files)) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error("refusing to write outside the registry: " + rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(data, "base64"), { mode: 0o600 });
  }
} else {
  throw new Error("usage: void-registry.cjs save|restore <dir> <file>");
}
`;

type Runner = CommandRunner<SelfManagedStep>;

/**
 * Writes the snapshot back as the registry directory (an empty one when
 * there is nothing saved), and makes `home` a fresh, empty directory.
 */
export async function restoreVoidRegistry(
  container: Runner,
  step: SelfManagedStep,
  snapshot: VoidRegistrySnapshot,
  home: string,
): Promise<void> {
  await container.writeFile(step, SCRIPT_FILE, REGISTRY_SCRIPT);
  await container.writeFile(step, SNAPSHOT_FILE, JSON.stringify(snapshot));
  await container.run(
    step,
    `${commandLine(["rm", "-rf", home])} && ${commandLine(["mkdir", "-p", home])} && ${commandLine(["node", SCRIPT_FILE, "restore", VOID_REGISTRY_DIR, SNAPSHOT_FILE])}`,
    { timeoutMs: STAGE_TIMEOUTS.quick, quiet: true, failure: "restoring the Void registry failed" },
  );
}

/** Reads the registry directory as it is now. */
export async function captureVoidRegistry(
  container: Runner,
  step: SelfManagedStep,
): Promise<VoidRegistrySnapshot> {
  await container.run(
    step,
    commandLine(["node", SCRIPT_FILE, "save", VOID_REGISTRY_DIR, SNAPSHOT_FILE]),
    { timeoutMs: STAGE_TIMEOUTS.quick, quiet: true, failure: "reading the Void registry failed" },
  );
  const text = await container.readFile(step, SNAPSHOT_FILE);
  try {
    return parseRegistrySnapshot(text);
  } catch (error) {
    throw new StepError(
      step,
      `the Void registry could not be saved: ${messageOf(error)}`,
      null,
      false,
    );
  }
}

/** Whether an R2 call failed (the bucket did not answer), as a retryable step error. */
function bucketFailure(
  step: SelfManagedStep,
  what: string,
  error: unknown,
): StepError<SelfManagedStep> {
  return new StepError(step, `${what}: ${messageOf(error)}`, null, true);
}

/**
 * The install's saved registry: the snapshot, null when none was saved, or
 * a problem when the saved object cannot be read as one (the run then
 * starts from an empty registry and the discover command).
 */
export async function loadVoidRegistry(
  bucket: R2Bucket,
  installId: string,
  step: SelfManagedStep,
): Promise<{ snapshot: VoidRegistrySnapshot | null; problem: string | null }> {
  let text: string | null;
  try {
    const object = await bucket.get(voidRegistryKey(installId));
    text = object === null ? null : await object.text();
  } catch (error) {
    throw bucketFailure(step, "the saved Void registry could not be read from the bucket", error);
  }
  if (text === null) return { snapshot: null, problem: null };
  try {
    return { snapshot: parseRegistrySnapshot(text), problem: null };
  } catch (error) {
    return { snapshot: null, problem: messageOf(error) };
  }
}

export async function storeVoidRegistry(
  bucket: R2Bucket,
  installId: string,
  step: SelfManagedStep,
  snapshot: VoidRegistrySnapshot,
): Promise<void> {
  try {
    await bucket.put(voidRegistryKey(installId), JSON.stringify(snapshot), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (error) {
    throw bucketFailure(step, "the Void registry could not be saved to the bucket", error);
  }
}

export async function forgetVoidRegistry(
  bucket: R2Bucket,
  installId: string,
  step: SelfManagedStep,
): Promise<void> {
  try {
    await bucket.delete(voidRegistryKey(installId));
  } catch (error) {
    throw bucketFailure(step, "the saved Void registry could not be deleted", error);
  }
}
