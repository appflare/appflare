import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Computes the 32-hex asset identifier exactly as wrangler does, so hashes match
 * what `assets-upload-session` expects and Cloudflare's asset store dedupes on.
 *
 * Verified against wrangler 4.136.2's bundled `deploy-helpers/.../hash.ts`
 * (`blake3-wasm.hash(base64Contents + extension).toString("hex").slice(0, 32)`)
 * and cross-checked byte-for-byte against `blake3-wasm`. This is BLAKE3, not
 * SHA-256: WebCrypto has no BLAKE3, hence the `@noble/hashes` dependency (a pure,
 * audited, runtime-agnostic implementation that runs identically in Workers and
 * Node).
 *
 * `filename` supplies the extension (without the dot); its bytes are folded into
 * the hash, so two files with identical contents but different extensions get
 * different asset hashes — matching Cloudflare.
 */
export function assetHash(
  contents: string | ArrayBuffer | ArrayBufferView | Uint8Array,
  filename: string,
): string {
  const input = base64Encode(toBytes(contents)) + extname(filename);
  return bytesToHex(blake3(input)).slice(0, 32);
}

/** One file's coordinates for {@link buildAssetsManifest}. */
export interface AssetManifestFile {
  /** Serving route, e.g. `/index.html`; normalized to a leading slash. */
  route: string;
  /** The 32-hex asset hash from {@link assetHash}. */
  hash: string;
  size: number;
}

/** The `{ "/route": { hash, size } }` map for `createUploadSession`. */
export type AssetUploadManifest = Record<string, { hash: string; size: number }>;

/**
 * Builds the assets manifest posted to `assets-upload-session` from a list of
 * `{ route, hash, size }`. (The field is not `sha256`: the
 * value Cloudflare keys on is the BLAKE3 `hash` above, so it is named `hash`.)
 */
export function buildAssetsManifest(files: AssetManifestFile[]): AssetUploadManifest {
  const manifest: AssetUploadManifest = {};
  for (const file of files) {
    manifest[normalizeRoute(file.route)] = { hash: file.hash, size: file.size };
  }
  return manifest;
}

function normalizeRoute(route: string): string {
  const withSlashes = route.replace(/\\/g, "/");
  return withSlashes.startsWith("/") ? withSlashes : `/${withSlashes}`;
}

/** Node `path.extname(p).substring(1)` semantics, without importing `node:path`. */
function extname(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}

function toBytes(contents: string | ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array {
  if (typeof contents === "string") {
    return new TextEncoder().encode(contents);
  }
  if (contents instanceof Uint8Array) {
    return contents;
  }
  if (ArrayBuffer.isView(contents)) {
    return new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
  }
  return new Uint8Array(contents);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A base64 digit; `index` is always 0-63 here, so `charCodeAt` never yields NaN. */
function digit(index: number): string {
  return String.fromCharCode(BASE64_ALPHABET.charCodeAt(index));
}

/** Standard (padded) base64, matching `Buffer.from(bytes).toString("base64")`. */
function base64Encode(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += digit((n >> 18) & 63) + digit((n >> 12) & 63) + digit((n >> 6) & 63) + digit(n & 63);
  }
  const remaining = len - i;
  if (remaining === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += `${digit((n >> 18) & 63)}${digit((n >> 12) & 63)}==`;
  } else if (remaining === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += `${digit((n >> 18) & 63)}${digit((n >> 12) & 63)}${digit((n >> 6) & 63)}=`;
  }
  return out;
}
