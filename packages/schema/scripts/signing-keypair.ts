import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * Ed25519 artifact signing keypair generation. The private key is
 * exported as base64 PKCS#8, the format `appflare-pack --sign-key-env` and
 * `appflare-pack sign` read; the public key as base64 of the raw 32 bytes, the
 * format `packages/schema/src/keys.ts` embeds.
 */
export interface SigningKeypair {
  /** Base64 PKCS#8 private key. Secret: never print or log it. */
  privateKeyPkcs8Base64: string;
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKeyBase64: string;
}

/** Generates a fresh Ed25519 keypair with WebCrypto. */
export async function generateSigningKeypair(): Promise<SigningKeypair> {
  // Ed25519 generateKey always yields a pair; the overloads type it as a union.
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  const raw = await webcrypto.subtle.exportKey("raw", pair.publicKey);
  return {
    privateKeyPkcs8Base64: Buffer.from(pkcs8).toString("base64"),
    publicKeyBase64: Buffer.from(raw).toString("base64"),
  };
}

/**
 * Refuses a private-key path that git would track: if `file` lies inside a git
 * working tree and is not ignored there, throws. Outside any repository (the
 * recommended place) this is a no-op.
 */
export function assertNotTrackable(file: string): void {
  const dir = path.dirname(file);
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    return; // not inside a git working tree
  }
  const ignored = spawnSync("git", ["-C", dir, "check-ignore", "-q", "--", file]);
  if (ignored.status !== 0) {
    throw new Error(
      `${file} is inside the git working tree ${top.stdout.trim()} and is not gitignored; ` +
        "write the private key outside every repository",
    );
  }
}

/**
 * Writes the private key to `file` with mode 0600. Never overwrites: fails if the
 * file already exists (open flag "wx"), so an existing key is never clobbered.
 * The parent directory must already exist.
 */
export function writePrivateKeyFile(file: string, privateKeyPkcs8Base64: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`directory ${dir} does not exist`);
  }
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${file} already exists; refusing to overwrite a signing key`);
    }
    throw error;
  }
  try {
    writeSync(fd, `${privateKeyPkcs8Base64}\n`);
  } finally {
    closeSync(fd);
  }
}
