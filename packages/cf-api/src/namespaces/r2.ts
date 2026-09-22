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

    /** `DELETE /r2/buckets/{name}`. */
    deleteBucket(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/r2/buckets/${enc(name)}`));
    },
  };
}
