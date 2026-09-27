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

    /**
     * `POST /vectorize/v2/indexes/{name}/metadata_index/create` with
     * `{ propertyName, indexType }`, as `wrangler vectorize
     * create-metadata-index` (wrangler 4.136.2) sends it. Cloudflare queues
     * the change and answers with its mutation id.
     */
    createMetadataIndex(
      indexName: string,
      args: { propertyName: string; indexType: "string" | "number" | "boolean" },
    ): Promise<{ mutationId?: string }> {
      return http.result(
        "POST",
        http.acct(`/vectorize/v2/indexes/${enc(indexName)}/metadata_index/create`),
        { json: { propertyName: args.propertyName, indexType: args.indexType } },
      );
    },

    /** `GET /vectorize/v2/indexes/{name}/metadata_index/list`: the index's metadata indexes. */
    async listMetadataIndexes(
      indexName: string,
    ): Promise<Array<{ propertyName: string; indexType: string }>> {
      const result = await http.result<{
        metadataIndexes?: Array<{ propertyName: string; indexType: string }>;
      } | null>("GET", http.acct(`/vectorize/v2/indexes/${enc(indexName)}/metadata_index/list`));
      return result?.metadataIndexes ?? [];
    },

    /** `DELETE /vectorize/v2/indexes/{name}`. */
    deleteIndex(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/vectorize/v2/indexes/${enc(name)}`));
    },
  };
}
