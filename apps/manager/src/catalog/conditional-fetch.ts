import type { FetchLike } from "@appflare/cf-api";
import { readLimited } from "./read-limited";

/**
 * A GET of a catalog JSON file that sends the ETag of the copy already
 * cached, so an unchanged file costs a `304` without a body. The catalog
 * site is refetched every 30 minutes by every manager, and GitHub Pages
 * meters bandwidth, so most refreshes should be `304`s.
 *
 * The ETag is stored as KV metadata of the cached value itself, with the
 * sha256 of the cached text: it is written in the same KV write as the body,
 * never on its own.
 *
 * GitHub Pages derives ETags from the deploy, not the content, so every
 * deploy of the catalog site (the hourly popularity rebuild included) changes
 * every file's ETag and costs each manager one full fetch. The body's sha256
 * tells a new ETag on the same content apart from new content.
 */

/** What is stored as the KV metadata of a cached catalog file. */
export interface CacheValidator {
  /** Cache format; a manager that caches differently ignores a validator from another format. */
  v: number;
  /** The URL the cached copy came from; a validator for another URL is never sent. */
  url: string;
  etag: string;
  /** sha256 of the cached text. */
  sha256?: string;
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What {@link storeIfChanged} did. */
export type StoreResult = "unchanged" | "new-etag" | "stored";

/**
 * Caches `text` (fetched from `url` with `etag`) under `key` unless it is
 * what is cached already. Content that did not change is never rewritten;
 * when only the ETag changed (a redeploy of the same file), the copy is
 * written once more with the new ETag, so the next refreshes are `304`s
 * again rather than full fetches until the content changes.
 */
export async function storeIfChanged(
  kv: KVNamespace,
  key: string,
  text: string,
  cached: { value: string | null; metadata: unknown },
  meta: { url: string; format: number; etag: string | null },
): Promise<StoreResult> {
  const sha256 = await sha256Text(text);
  const previous = cached.metadata as Partial<CacheValidator> | null;
  const sameFile = previous?.v === meta.format && previous.url === meta.url;
  const cachedSha =
    cached.value === null
      ? null
      : sameFile && typeof previous?.sha256 === "string"
        ? previous.sha256
        : await sha256Text(cached.value);
  const etag = meta.etag ?? "";
  const unchangedBody = cachedSha === sha256;
  if (unchangedBody && sameFile && (previous?.etag ?? "") === etag) return "unchanged";
  await kv.put(key, text, { metadata: { v: meta.format, url: meta.url, etag, sha256 } });
  return unchangedBody ? "new-etag" : "stored";
}

/**
 * The largest catalog JSON file (an index or a stats file) a manager reads.
 * The official index is a few hundred kilobytes; an added catalog's site is
 * not trusted to stay small, and a Worker holds the whole body in memory.
 */
export const MAX_CATALOG_JSON_BYTES = 4 * 1024 * 1024;

export type ConditionalResult =
  | { status: "not-modified" }
  | { status: "ok"; json: unknown; etag: string | null };

/** Why a catalog file could not be fetched; the message is safe to show. */
export class CatalogError extends Error {
  override name = "CatalogError";
}

/** A validator for `url` in cache format `format`, from whatever metadata KV returned. */
export function validatorFor(metadata: unknown, url: string, format: number): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const { v, url: cachedUrl, etag } = metadata as Partial<CacheValidator>;
  return v === format && cachedUrl === url && typeof etag === "string" && etag !== "" ? etag : null;
}

/**
 * Fetches `url` as JSON, sending `If-None-Match` when `etag` is given.
 * `label` names the file in error messages ("catalog", "catalog stats").
 * A body above `maxBytes` is refused, by its declared length before
 * anything is read, else as soon as the read passes the limit.
 */
export async function fetchCatalogJson(
  fetchImpl: FetchLike,
  url: string,
  etag: string | null,
  label: string,
  maxBytes: number = MAX_CATALOG_JSON_BYTES,
): Promise<ConditionalResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (etag !== null) headers["if-none-match"] = etag;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new CatalogError(
      `Could not reach the ${label} at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 304 && etag !== null) {
    await response.body?.cancel();
    return { status: "not-modified" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CatalogError(`The ${label} at ${url} answered HTTP ${response.status}.`);
  }
  const tooLarge = () =>
    new CatalogError(
      `The ${label} at ${url} is larger than ${maxBytes / 1024 / 1024} MiB, the most Appflare reads.`,
    );
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(response.body, maxBytes);
  } catch (error) {
    throw new CatalogError(
      `Could not read the ${label} at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes === null) throw tooLarge();
  try {
    return {
      status: "ok",
      json: JSON.parse(new TextDecoder().decode(bytes)),
      etag: response.headers.get("etag"),
    };
  } catch {
    throw new CatalogError(`The ${label} at ${url} did not return JSON.`);
  }
}
