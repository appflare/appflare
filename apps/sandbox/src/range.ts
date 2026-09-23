import { isBuildObjectKey } from "@appflare/schema";

/**
 * Serves build objects to the manager with HTTP Range support, so the
 * manager's artifact reader (which reads each file of the STORE zip as one
 * byte range and expects `206 Partial Content`) works on a sandbox build
 * exactly as on a release asset. The sandbox Worker has no public URL; this runs
 * only for requests that arrive over the manager's service binding.
 *
 * Only keys under `builds/` with safe segments are served; everything else is
 * a 404, whatever the bucket holds.
 */

/** A satisfiable single byte range, as R2 takes it. */
export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * Parses a `Range` header against an object of `size` bytes: a range to
 * serve, `"unsatisfiable"` (416), or `"ignore"` for a header the server may
 * ignore and answer with the whole object (malformed, another unit, or
 * several ranges, which RFC 9110 lets a server ignore).
 */
export function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | "ignore" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "ignore";
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return "ignore";
  if (first === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return "ignore";
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(first);
  const end = last === "" ? Number.MAX_SAFE_INTEGER : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return "ignore";
  if (start >= size) return "unsatisfiable";
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

function contentTypeFor(key: string, object: R2Object): string {
  if (object.httpMetadata?.contentType) return object.httpMetadata.contentType;
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

export async function serveBuildObject(request: Request, bucket: R2Bucket): Promise<Response> {
  // Requests over a service binding carry no `cf` object; one from the
  // internet always does. The Worker has no public route, so this is defence
  // in depth: were one ever added, it still serves nothing.
  if (request.cf !== undefined) {
    return text(404, "Not found\n");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "Method not allowed\n", { allow: "GET, HEAD" });
  }
  const key = new URL(request.url).pathname.slice(1);
  if (!isBuildObjectKey(key)) {
    return text(404, "Not found\n");
  }
  const head = await bucket.head(key);
  if (head === null) {
    return text(404, "Not found\n");
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    etag: head.httpEtag,
    "content-type": contentTypeFor(key, head),
    "cache-control": "no-store",
  });
  const header = request.headers.get("range");
  const range = header === null ? "ignore" : parseRange(header, head.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  const partial = range !== "ignore";
  const length = partial ? range.length : head.size;
  headers.set("content-length", String(length));
  if (partial) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
  }
  const status = partial ? 206 : 200;
  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }

  // Read exactly the object described above: if it was replaced in between,
  // the reader retries rather than getting bytes of another build.
  const object = await bucket.get(key, {
    onlyIf: { etagMatches: head.etag },
    ...(partial ? { range } : {}),
  });
  if (object === null || !("body" in object)) {
    return text(503, "The object changed while it was read; try again.\n", { "retry-after": "1" });
  }
  return new Response(object.body, { status, headers });
}
