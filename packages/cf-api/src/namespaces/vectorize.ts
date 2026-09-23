import type { HttpApi } from "../http";
import type { VectorizeIndex } from "../types";

const enc = encodeURIComponent;

/** A Vectorize v2 index config: either a preset or explicit dimensions + metric. */
export type VectorizeConfig =
  | { preset: string }
  | { dimensions: number; metric: "cosine" | "euclidean" | "dot-product" };

export interface CreateVectorizeIndexArgs {
  name: string;
  config: VectorizeConfig;
  description?: string;
}

/** Vectorize v2 indexes. */
export function createVectorize(http: HttpApi) {
  return {
    /** `POST /vectorize/v2/indexes` with `{ name, config, description? }`. */
    createIndex(args: CreateVectorizeIndexArgs): Promise<VectorizeIndex> {
      const body: Record<string, unknown> = { name: args.name, config: args.config };
      if (args.description !== undefined) body.description = args.description;
      return http.result("POST", http.acct("/vectorize/v2/indexes"), { json: body });
    },

    /** `GET /vectorize/v2/indexes`: every index in the account (a single page). */
    listIndexes(): Promise<VectorizeIndex[]> {
      return http.result("GET", http.acct("/vectorize/v2/indexes"));
    },

    /** `DELETE /vectorize/v2/indexes/{name}`. */
    deleteIndex(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/vectorize/v2/indexes/${enc(name)}`));
    },
  };
}
