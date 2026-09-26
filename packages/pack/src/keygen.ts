import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { formatPublicKey, KEY_ID_PATTERN, publicKeyFingerprint } from "@appflare/schema";
import { UNSIGNED_KEY_ID } from "./signing.ts";

/**
 * `appflare-pack keygen`: a new Ed25519 signing key pair for a catalog. The
 * private key goes to a file only (base64 PKCS#8, the format `--sign-key-env`
 * and `sign` read); what is returned and printed is public: the key id, the
 * one-line public key a catalog publishes and a manager's admin pastes, and
 * the key's fingerprint.
 */
export interface KeygenOptions {
  /** Where to write the private key; relative paths resolve against `cwd`. */
  out: string;
  /** Key id recorded in `manifest.keyId` of everything signed with this key. */
  keyId: string;
  /** Directory a relative `out` resolves against (default: `process.cwd()`). */
  cwd?: string;
}

export interface KeygenResult {
  /** Absolute path of the private key file (mode 0600). */
  privateKeyPath: string;
  keyId: string;
  /** `{"keyId":"…","publicKeyBase64":"…"}` on one line: what users paste. */
  publicKeyLine: string;
  /** `SHA256:…`, the fingerprint Appflare shows back for the pasted key. */
  fingerprint: string;
}

/** Why a key id is refused, or null when it is fine. */
export function keyIdProblem(keyId: string): string | null {
  if (!KEY_ID_PATTERN.test(keyId) || keyId === UNSIGNED_KEY_ID) {
    return `--key-id must be 1 to 63 lowercase letters, digits and dashes, starting with a letter or digit, and not "${UNSIGNED_KEY_ID}"`;
  }
  return null;
}

/**
 * Refuses a private key path git would track: throws if `file` lies inside a
 * git working tree and is not ignored there. Outside every repository (the
 * recommended place) this does nothing.
 */
export function assertNotTrackable(file: string): void {
  const dir = path.dirname(file);
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    return; // not inside a git working tree (or no git at all)
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
 * Writes the private key to `file` with mode 0600. Never overwrites (open flag
 * "wx"), so an existing key is never clobbered. The directory must exist.
 */
function writePrivateKeyFile(file: string, privateKeyPkcs8Base64: string): void {
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

/**
 * Generates an Ed25519 key pair with WebCrypto and writes the private key to
 * `out`. Every check (key id, path, existing file) runs before a key exists,
 * and the private key never leaves this function except into the file.
 */
export async function keygen(options: KeygenOptions): Promise<KeygenResult> {
  const problem = keyIdProblem(options.keyId);
  if (problem) {
    throw new Error(problem);
  }
  const file = path.resolve(options.cwd ?? process.cwd(), options.out);
  if (existsSync(file)) {
    throw new Error(`${file} already exists; refusing to overwrite a signing key`);
  }
  assertNotTrackable(file);

  // Ed25519 generateKey always yields a pair; the overloads type it as a union.
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  const raw = await webcrypto.subtle.exportKey("raw", pair.publicKey);
  writePrivateKeyFile(file, Buffer.from(pkcs8).toString("base64"));

  const key = { keyId: options.keyId, publicKeyBase64: Buffer.from(raw).toString("base64") };
  return {
    privateKeyPath: file,
    keyId: key.keyId,
    publicKeyLine: formatPublicKey(key),
    fingerprint: await publicKeyFingerprint(key.publicKeyBase64),
  };
}

/** What `appflare-pack keygen` prints: public values and the key file's path only. */
export function formatKeygenOutput(result: KeygenResult): string {
  return [
    `private key: ${result.privateKeyPath} (mode 0600, base64 PKCS#8; not printed)`,
    `key id:      ${result.keyId}`,
    `public key:  ${result.publicKeyLine}`,
    `fingerprint: ${result.fingerprint}`,
    "",
  ].join("\n");
}
