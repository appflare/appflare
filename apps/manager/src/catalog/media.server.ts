import type { FetchLike } from "@appflare/cf-api";
import { type CatalogEnv, catalogIndexUrl, readCachedCatalogIndex } from "./index.server";
import { findCatalogMedia, MAX_MEDIA_BYTES, mediaContentType } from "./media";

/**
 * `GET /api/catalog/media/<sha256>`: one image the cached index lists (see
 * `media.ts`), fetched from the catalog site and served only when its bytes
 * match the digest. The response is addressed by its content, so browsers
 * may keep it for good. An SVG is served with a policy that keeps it inert
 * when opened on its own.
 */

const DIGEST = /^[0-9a-f]{64}$/;

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

function badGateway(message: string): Response {
  return new Response(message, { status: 502, headers: { "cache-control": "no-store" } });
}

/**
 * The whole body, or null as soon as it passes `max` bytes (the rest is not
 * read). An empty body reads as zero bytes.
 */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function serveCatalogMedia(
  env: CatalogEnv,
  digest: string,
  opts: { fetch?: FetchLike } = {},
): Promise<Response> {
  if (!DIGEST.test(digest)) return notFound();
  const index = await readCachedCatalogIndex(env.KV);
  if (index === null) return notFound();
  const file = findCatalogMedia(index, digest, catalogIndexUrl(env));
  const contentType = file === null ? null : mediaContentType(file.url);
  if (file === null || contentType === null) return notFound();
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(file.url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return badGateway("The catalog site could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return badGateway(`The catalog site answered HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_MEDIA_BYTES) {
    await response.body?.cancel();
    return badGateway("The image is larger than Appflare serves.");
  }
  // Read with a running count, so a response without (or lying about) its
  // length is cut off at the limit instead of being buffered whole.
  const bytes = await readLimited(response.body, MAX_MEDIA_BYTES);
  if (bytes === null) {
    return badGateway("The image is larger than Appflare serves.");
  }
  if ((await sha256Hex(bytes)) !== digest) {
    return badGateway("The image does not match the digest the catalog lists.");
  }
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      // Addressed by content: the same path always serves the same bytes.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

/**
 * The media route: signed-in users only, like the catalog pages that show
 * the images. `signedIn` resolves the request's session.
 */
export async function catalogMediaRoute(
  env: CatalogEnv,
  digest: string,
  signedIn: () => Promise<boolean>,
  opts: { fetch?: FetchLike } = {},
): Promise<Response> {
  if (!(await signedIn())) {
    return new Response("Sign in first.", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  return serveCatalogMedia(env, digest, opts);
}
