import { createHash, webcrypto } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { assetHash } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  appWorkers,
  artifactD1Files,
  artifactManifestSchema,
  catalogVarProblems,
  combinedWorkerFacts,
  type D1MigrationFile,
  hyperdriveDeclarationProblems,
  isVectorizeBinding,
  queueConsumerProblems,
  schemaFileProblems,
  serviceBindingProblem,
  signingKeys,
  workerManifest,
  workerUploadProblem,
} from "@appflare/schema";
import { UNSIGNED_KEY_ID } from "./signing.ts";

/** Options for {@link verify}. */
export interface VerifyOptions {
  /** Directory holding `manifest.json`, `manifest.sig`, and the artifact zip. */
  dir: string;
  /** Base64 raw Ed25519 public key to verify against, overriding the key list. */
  publicKey?: string;
  /** Fail when the artifact is unsigned or has no `manifest.sig` (catalog CI uses this). */
  requireSigned?: boolean;
  /**
   * Skip every signature check (a missing `manifest.sig` is fine for any keyId)
   * but still check every size, sha256, asset hash, and offset. For verifying an
   * unsigned intermediate before it is signed. Exclusive with `requireSigned`
   * and `publicKey`.
   */
  hashesOnly?: boolean;
  /**
   * Fail when a Worker does not fit Appflare's upload budget
   * (`workerUploadProblem` from `@appflare/schema`): too many module bytes
   * for one upload, or modules spread over more Range requests than one
   * invocation may make. Catalog CI sets it so it never publishes an
   * artifact Appflare could not install or update.
   */
  checkUpload?: boolean;
  logger?: (message: string) => void;
}

/** Result of a successful {@link verify}. */
export interface VerifyResult {
  ok: true;
  /** Whether a signature was checked (false when the artifact is unsigned). */
  signed: boolean;
  keyId: string;
  checkedFiles: number;
}

/** One addressable file recorded in the manifest. */
interface Addressable {
  path: string;
  size: number;
  sha256: string;
  offset: number;
  /** BLAKE3 asset id, present only for `assets.files[]`. */
  hash?: string;
}

async function verifySignature(
  dir: string,
  manifestBytes: Uint8Array,
  publicKeyBase64: string,
): Promise<void> {
  const sigPath = path.join(dir, "manifest.sig");
  if (!existsSync(sigPath)) {
    throw new Error(`manifest.sig not found in ${dir}`);
  }
  const signature = Buffer.from(readFileSync(sigPath, "utf8").trim(), "base64");
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(publicKeyBase64, "base64"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await webcrypto.subtle.verify({ name: "Ed25519" }, key, signature, manifestBytes);
  if (!ok) {
    throw new Error("manifest signature verification failed");
  }
}

/**
 * Throws unless every Vectorize binding records the same index shape the
 * embedded catalog manifest declares for it. The manager creates the index
 * from the binding, so the two must never disagree.
 */
function checkVectorizeBindings(manifest: ArtifactManifest): void {
  const declared = manifest.catalog.resources?.vectorize ?? {};
  for (const binding of appWorkers(manifest).flatMap((w) => w.worker.bindings)) {
    if (!isVectorizeBinding(binding)) {
      continue;
    }
    const index = Object.hasOwn(declared, binding.name) ? declared[binding.name] : undefined;
    if (index?.dimensions !== binding.dimensions || index.metric !== binding.metric) {
      const want = index === undefined ? "nothing" : `${index.dimensions} ${index.metric}`;
      throw new Error(
        `Vectorize binding ${binding.name} records ${binding.dimensions} ${binding.metric}, ` +
          `but the embedded catalog manifest declares ${want} for resources.vectorize.${binding.name}`,
      );
    }
  }
}

/**
 * Throws unless every Hyperdrive binding is declared in the embedded catalog
 * manifest's `resources.hyperdrive` and every declaration is bound: the
 * manager asks for one connection string per declaration and binds one
 * configuration per binding.
 */
function checkHyperdriveBindings(manifest: ArtifactManifest): void {
  const problems = hyperdriveDeclarationProblems(
    appWorkers(manifest).flatMap((w) => w.worker.bindings),
    manifest.catalog.resources?.hyperdrive ?? [],
  );
  if (problems.length > 0) throw new Error(problems.join(" "));
}

function resolveZipPath(dir: string, manifest: ArtifactManifest): string {
  const named = path.join(dir, `${manifest.app}-${manifest.version}.zip`);
  if (existsSync(named)) {
    return named;
  }
  const zips = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".zip"));
  if (zips.length === 1) {
    return path.join(dir, zips[0] as string);
  }
  throw new Error(
    `could not find the artifact zip in ${dir} (expected ${manifest.app}-${manifest.version}.zip)`,
  );
}

/**
 * Verifies an artifact directory. Checks the
 * manifest signature (against `signingKeys` by keyId, or `--public-key`) unless
 * the artifact is unsigned or `hashesOnly` is set, then reads exactly `bytes[offset, offset+size)` from
 * the zip for every recorded worker module, asset, and D1 SQL file and checks
 * its size and sha256 — never by unzipping. D1 schema files, which run on
 * every install and update, must still pass the packer's check that they
 * create only what is missing (`schemaFileProblems` from `@appflare/schema`). Also checks that each Vectorize
 * binding records the index shape the embedded catalog manifest declares, and
 * that no service binding points anywhere but the app's own Worker. With
 * `checkUpload`, also fails an artifact whose Worker Appflare could not upload.
 * Throws on any mismatch.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const dir = path.resolve(options.dir);
  const logger = options.logger ?? (() => {});
  if (options.hashesOnly && options.requireSigned) {
    throw new Error("--hashes-only and --require-signed are mutually exclusive");
  }
  if (options.hashesOnly && options.publicKey) {
    throw new Error("--hashes-only and --public-key are mutually exclusive");
  }

  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${dir}`);
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = artifactManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));

  const unsigned = manifest.keyId === UNSIGNED_KEY_ID;
  const sigPath = path.join(dir, "manifest.sig");
  let signed = false;
  if (options.hashesOnly) {
    logger(`--hashes-only: skipping signature checks (keyId=${manifest.keyId})`);
  } else {
    if (options.requireSigned && unsigned) {
      throw new Error("artifact is unsigned (keyId=unsigned) but --require-signed was given");
    }
    // Any artifact that names a key, or is checked against an explicit key, must
    // carry a signature; report its absence before looking the key up.
    if ((options.publicKey || !unsigned) && !existsSync(sigPath)) {
      throw new Error(`manifest.sig not found in ${dir}`);
    }
    if (options.publicKey) {
      await verifySignature(dir, manifestBytes, options.publicKey);
      signed = true;
    } else if (!unsigned) {
      const key = signingKeys.find((k) => k.keyId === manifest.keyId);
      if (!key) {
        throw new Error(
          `no trusted signing key matches keyId "${manifest.keyId}"; pass --public-key to verify`,
        );
      }
      await verifySignature(dir, manifestBytes, key.publicKeyBase64);
      signed = true;
    } else {
      logger("artifact is unsigned (keyId=unsigned); checking hashes only");
    }
  }

  checkVectorizeBindings(manifest);
  checkHyperdriveBindings(manifest);
  const workers = appWorkers(manifest);
  // A queue a Worker consumes may be one another Worker of the app sends to.
  const allBindings = combinedWorkerFacts(manifest).bindings;
  const problems = workers.flatMap((w) => [
    ...queueConsumerProblems({ bindings: allBindings, queueConsumers: w.worker.queueConsumers }),
    ...catalogVarProblems(w.worker.bindings, workerManifest(manifest, w).catalog.vars),
    ...w.worker.bindings.flatMap((b) => serviceBindingProblem(b) ?? []),
  ]);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }

  if (options.checkUpload) {
    const tooBig = workers.flatMap(
      (w) =>
        workerUploadProblem(
          w.worker.modules,
          w.primary
            ? `${manifest.app}@${manifest.version}`
            : `The Worker "${w.name}" of ${manifest.app}@${manifest.version}`,
        ) ?? [],
    );
    if (tooBig.length > 0) {
      throw new Error(tooBig.join(" "));
    }
  }

  const schemaFiles = new Set(Object.values(manifest.d1Schema ?? {}).flat());
  const entries: Addressable[] = [
    ...workers.flatMap((w) => [...w.worker.modules, ...w.assets.files]),
    ...artifactD1Files(manifest),
  ];

  const zipPath = resolveZipPath(dir, manifest);
  const fd = openSync(zipPath, "r");
  let checked = 0;
  try {
    for (const entry of entries) {
      const buf = Buffer.alloc(entry.size);
      const read = entry.size === 0 ? 0 : readSync(fd, buf, 0, entry.size, entry.offset);
      if (read !== entry.size) {
        throw new Error(`short read for ${entry.path}: expected ${entry.size} bytes, got ${read}`);
      }
      const digest = createHash("sha256").update(buf).digest("hex");
      if (digest !== entry.sha256) {
        throw new Error(
          `sha256 mismatch for ${entry.path}: manifest=${entry.sha256} zip=${digest}`,
        );
      }
      if (schemaFiles.has(entry as D1MigrationFile)) {
        // Run on every install and update, so held to the packer's rule again.
        const problems = schemaFileProblems(buf.toString("utf8"));
        if (problems.length > 0) {
          throw new Error(
            `the D1 schema file ${entry.path} cannot run on every install and update: ${problems.join("; ")}`,
          );
        }
      }
      if (entry.hash !== undefined) {
        // The extension comes from the file's basename, exactly as the packer
        // fed it to cf-api's assetHash.
        const recomputed = assetHash(buf, entry.path);
        if (recomputed !== entry.hash) {
          throw new Error(
            `asset hash mismatch for ${entry.path}: manifest=${entry.hash} recomputed=${recomputed}`,
          );
        }
      }
      checked++;
    }
  } finally {
    closeSync(fd);
  }

  logger(
    `verified ${manifest.app}@${manifest.version}: ${checked} files, ` +
      `${signed ? `signed (keyId=${manifest.keyId})` : "unsigned"}`,
  );
  return { ok: true, signed, keyId: manifest.keyId, checkedFiles: checked };
}
