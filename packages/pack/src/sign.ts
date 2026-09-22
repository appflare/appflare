import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { artifactManifestSchema } from "@appflare/schema";
import { publicKeyFromPrivate, signBytes, UNSIGNED_KEY_ID } from "./signing.ts";
import { verify } from "./verify.ts";

/** Options for {@link sign}. */
export interface SignOptions {
  /** Artifact directory holding `manifest.json` and the zip (an unsigned intermediate). */
  dir: string;
  /** Name of the env var holding the base64 PKCS#8 Ed25519 private key. */
  signKeyEnv: string;
  /** When given, must equal `manifest.keyId`. */
  keyId?: string;
  /** Overwrite an existing `manifest.sig`. */
  force?: boolean;
  /** Environment source for the key. Default process.env. */
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
}

/** Result of a successful {@link sign}. */
export interface SignResult {
  signaturePath: string;
  keyId: string;
  /** Raw base64 Ed25519 public key derived from the signing key (not secret). */
  publicKey: string;
  /** Files checked by the post-sign self-verification. */
  checkedFiles: number;
}

/**
 * Signs an unsigned intermediate artifact in place, as a separate step from
 * packing so the signing job never runs third-party app code (catalog CI).
 *
 * Signs the exact bytes of `<dir>/manifest.json` and writes `manifest.sig`;
 * never modifies `manifest.json` or the zip. Requires `manifest.keyId` to name a
 * key (not "unsigned") and to match `keyId` when one is given, and refuses to
 * replace an existing `manifest.sig` unless `force`. Afterwards it derives the
 * public key from the private key and re-runs {@link verify} with
 * `requireSigned` as a self-check; if that fails the new signature is removed.
 */
export async function sign(options: SignOptions): Promise<SignResult> {
  const dir = path.resolve(options.dir);
  const env = options.env ?? process.env;
  const logger = options.logger ?? (() => {});

  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${dir}`);
  }
  // The exact bytes on disk are what gets signed; parse only to validate/read keyId.
  const manifestBytes = readFileSync(manifestPath);
  const manifest = artifactManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));

  if (manifest.keyId === UNSIGNED_KEY_ID) {
    throw new Error(
      'manifest.keyId is "unsigned"; re-pack with --key-id to produce a signable intermediate',
    );
  }
  if (options.keyId !== undefined && options.keyId !== manifest.keyId) {
    throw new Error(
      `--key-id "${options.keyId}" does not match manifest.keyId "${manifest.keyId}"`,
    );
  }

  const sigPath = path.join(dir, "manifest.sig");
  if (existsSync(sigPath) && !options.force) {
    throw new Error(`manifest.sig already exists in ${dir}; pass --force to overwrite it`);
  }

  const keyBase64 = env[options.signKeyEnv];
  if (!keyBase64) {
    throw new Error(`sign key env var ${options.signKeyEnv} is not set`);
  }

  const signature = await signBytes(manifestBytes, keyBase64);
  const publicKey = await publicKeyFromPrivate(keyBase64);
  // "wx" fails if a manifest.sig appeared since the check above (no silent overwrite).
  writeFileSync(sigPath, `${signature}\n`, { flag: options.force ? "w" : "wx" });

  try {
    const checked = await verify({ dir, publicKey, requireSigned: true, logger });
    logger(`signed ${manifest.app}@${manifest.version} (keyId=${manifest.keyId})`);
    return {
      signaturePath: sigPath,
      keyId: manifest.keyId,
      publicKey,
      checkedFiles: checked.checkedFiles,
    };
  } catch (error) {
    // Never leave a signature behind that does not verify.
    rmSync(sigPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`self-check after signing failed: ${message}`);
  }
}
