import { createHash, webcrypto } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { assetHash } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  signingKeys,
  tooManyModulesMessage,
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
   * Fail when the artifact has more Worker modules than this. Catalog CI passes
   * `MAX_WORKER_MODULES` from `@appflare/schema` so it never publishes an
   * artifact Appflare could not install or update.
   */
  maxModules?: number;
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
 * the zip for every recorded worker module, asset, and D1 migration and checks
 * its size and sha256 — never by unzipping. With `maxModules`, also fails an
 * artifact with more Worker modules than that. Throws on any mismatch.
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
  if (
    options.maxModules !== undefined &&
    (!Number.isInteger(options.maxModules) || options.maxModules < 1)
  ) {
    throw new Error(`--max-modules must be a positive integer, got ${options.maxModules}`);
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

  if (options.maxModules !== undefined) {
    const tooMany = tooManyModulesMessage(
      manifest.worker.modules.length,
      `${manifest.app}@${manifest.version}`,
      options.maxModules,
    );
    if (tooMany !== null) {
      throw new Error(tooMany);
    }
  }

  const entries: Addressable[] = [
    ...manifest.worker.modules,
    ...manifest.assets.files,
    ...Object.values(manifest.d1Migrations).flat(),
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
