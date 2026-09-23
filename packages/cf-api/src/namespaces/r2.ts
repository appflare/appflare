import type { HttpApi } from "../http";
import type { R2Bucket } from "../types";

const enc = encodeURIComponent;

export interface CreateBucketArgs {
  name: string;
  /** e.g. `weur`, `enam`. */
  locationHint?: string;
  /** `Standard` or `InfrequentAccess`. */
  storageClass?: string;
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

    /** `DELETE /r2/buckets/{name}`. */
    deleteBucket(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/r2/buckets/${enc(name)}`));
    },
  };
}
