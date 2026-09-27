import type { HttpApi } from "../http";
import type { CursorPage, R2Bucket, R2Object } from "../types";

const enc = encodeURIComponent;

export interface CreateBucketArgs {
  name: string;
  /** e.g. `weur`, `enam`. */
  locationHint?: string;
  /** `Standard` or `InfrequentAccess`. */
  storageClass?: string;
}

/**
 * Whether a key can be addressed in a REST API path. URL parsing resolves `.`
 * and `..` segments, and treats `%2E` as a dot too, so no encoding keeps them;
 * a key with such a segment would address a different object. (A literal `%`
 * in a key is encoded as `%25`, so only bare dot segments are affected.)
 */
export function isAddressableObjectKey(key: string): boolean {
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

/** An object key as URL path segments: split on `/`, each segment percent-encoded, `/` kept. */
export function objectKeyPath(key: string): string {
  if (!isAddressableObjectKey(key)) {
    throw new RangeError("R2 object keys with a '.' or '..' path segment cannot be addressed");
  }
  return key.split("/").map(encodeURIComponent).join("/");
}

/** R2 buckets. */
export function createR2(http: HttpApi) {
  return {
    /** `POST /r2/buckets` with `{ name, locationHint?, storageClass? }`. */
    createBucket(args: CreateBucketArgs): Promise<R2Bucket> {
      const body: Record<string, unknown> = { name: args.name };
      if (args.locationHint !== undefined) body.locationHint = args.locationHint;
      if (args.storageClass !== undefined) body.storageClass = args.storageClass;
      return http.result("POST", http.acct("/r2/buckets"), { json: body });
    },

    /**
     * `GET /r2/buckets[?name_contains=]`, following the cursor pagination R2 uses
     * instead of page numbers. Returns every bucket whose name contains
     * `nameContains` (all buckets when omitted).
     */
    async listBuckets(opts: { nameContains?: string } = {}): Promise<R2Bucket[]> {
      const acc: R2Bucket[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 1_000; page++) {
        const envelope = await http.send("GET", http.acct("/r2/buckets"), {
          query: { name_contains: opts.nameContains, per_page: 1000, cursor },
        });
        const result = envelope.result as { buckets?: R2Bucket[] } | null;
        acc.push(...(result?.buckets ?? []));
        cursor = envelope.result_info?.cursor || undefined;
        if (cursor === undefined) break;
      }
      return acc;
    },

    /**
     * `GET /r2/buckets?per_page=&cursor=`: ONE page of buckets, with the cursor
     * for the next page (null on the last). A one-bucket page is the cheapest
     * way to learn whether R2 is enabled on the account at all.
     */
    async listBucketsPage(
      opts: { perPage?: number; cursor?: string; nameContains?: string } = {},
    ): Promise<CursorPage<R2Bucket>> {
      const envelope = await http.send("GET", http.acct("/r2/buckets"), {
        query: { name_contains: opts.nameContains, per_page: opts.perPage, cursor: opts.cursor },
      });
      const result = envelope.result as { buckets?: R2Bucket[] } | null;
      return { items: result?.buckets ?? [], cursor: envelope.result_info?.cursor || null };
    },

    /**
     * `GET /r2/buckets/{name}/lifecycle`: the bucket's lifecycle rules, as
     * the API returns them (a new bucket has Cloudflare's default rule that
     * aborts multipart uploads after seven days).
     */
    async getLifecycleRules(bucket: string): Promise<unknown[]> {
      const result = await http.result<{ rules?: unknown[] } | null>(
        "GET",
        http.acct(`/r2/buckets/${enc(bucket)}/lifecycle`),
      );
      return Array.isArray(result?.rules) ? result.rules : [];
    },

    /**
     * `PUT /r2/buckets/{name}/lifecycle` with `{ rules }`, which replaces
     * every rule of the bucket; `wrangler r2 bucket lifecycle add` (wrangler
     * 4.136.2) reads the rules first and puts them back with its own added.
     */
    putLifecycleRules(bucket: string, rules: readonly unknown[]): Promise<unknown> {
      return http.result("PUT", http.acct(`/r2/buckets/${enc(bucket)}/lifecycle`), {
        json: { rules },
      });
    },

    /** `DELETE /r2/buckets/{name}`. Cloudflare refuses a bucket that still holds objects. */
    deleteBucket(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/r2/buckets/${enc(name)}`));
    },

    /**
     * `GET /r2/buckets/{name}/objects?per_page=&cursor=`: ONE page of objects,
     * with the cursor for the next page (null on the last). Path and cursor
     * pagination as in Cloudflare's API schema (cloudflare-typescript
     * `r2.buckets.objects.list`).
     */
    async listObjects(
      bucket: string,
      opts: { perPage?: number; cursor?: string } = {},
    ): Promise<CursorPage<R2Object>> {
      const envelope = await http.send("GET", http.acct(`/r2/buckets/${enc(bucket)}/objects`), {
        query: { per_page: opts.perPage, cursor: opts.cursor },
      });
      const items = Array.isArray(envelope.result) ? (envelope.result as R2Object[]) : [];
      return { items, cursor: envelope.result_info?.cursor || null };
    },

    /**
     * `DELETE /r2/buckets/{name}/objects/{key}`. The key goes into the path the
     * way wrangler 4.136.2 sends it (`objects/${objectName}`, slashes kept as
     * separators), with each segment percent-encoded; see {@link objectKeyPath}.
     */
    deleteObject(bucket: string, key: string): Promise<unknown> {
      return http.result(
        "DELETE",
        http.acct(`/r2/buckets/${enc(bucket)}/objects/${objectKeyPath(key)}`),
      );
    },
  };
}
