import type { HttpApi, SendOptions } from "../http";

const enc = encodeURIComponent;

/**
 * Cloudflare Pipelines, the API of September 2025 on
 * (`/accounts/{id}/pipelines/v1`): streams take events, sinks write them to
 * R2, and a pipeline's SQL moves them from one to the other. Shapes are the
 * `cloudflare-pipelines_*` schemas of Cloudflare's API schema and match
 * wrangler 4.136.2's `src/pipelines/client.ts`. None of the three can be
 * changed after it is created; each is replaced by deleting and creating it.
 *
 * A sink's request body carries an API token (`config.token`), and like
 * every body it never appears in an error message or a request log.
 */

/** A field of a stream's schema (flat types only; `struct` and `list` are not used). */
export interface StreamSchemaField {
  name: string;
  type: string;
  required?: boolean;
  /** `timestamp` fields: `second`, `millisecond`, `microsecond` or `nanosecond`. */
  unit?: string;
}

/** `POST /pipelines/v1/streams`. Only `name` is required. */
export interface CreateStreamArgs {
  name: string;
  /** Omitted: an unstructured stream, one `value` column. */
  schema?: { fields: StreamSchemaField[] };
  /** Events arrive as JSON. */
  format?: { type: "json"; timestamp_format?: "rfc3339" | "unix_millis" };
  /** The stream's HTTP ingest endpoint; Cloudflare's default is on without authentication. */
  http?: { enabled: boolean; authentication: boolean; cors?: { origins?: string[] } };
  /** Whether a Worker can bind the stream; Cloudflare's default is on. */
  worker_binding?: { enabled: boolean };
}

/** A stream as the API returns it (fields Appflare reads). */
export interface PipelineStream {
  id: string;
  name: string;
  /** `https://<id>.ingest.cloudflare.com` while HTTP ingest is on. */
  endpoint?: string;
  created_at?: string;
  modified_at?: string;
}

/** Where an R2 Data Catalog sink writes: an Iceberg table of the bucket's catalog. */
export interface R2DataCatalogSinkConfig {
  account_id: string;
  bucket: string;
  namespace?: string;
  table_name: string;
  /** An API token with R2 Data Catalog and R2 Storage write access; Cloudflare keeps it. */
  token: string;
  rolling_policy?: { interval_seconds?: number; file_size_bytes?: number };
}

/** `POST /pipelines/v1/sinks` for an R2 Data Catalog sink, whose format must be Parquet. */
export interface CreateCatalogSinkArgs {
  name: string;
  type: "r2_data_catalog";
  format: { type: "parquet"; compression?: string; row_group_bytes?: number };
  config: R2DataCatalogSinkConfig;
}

/** A sink as the API returns it (fields Appflare reads; never its credentials). */
export interface PipelineSink {
  id: string;
  name: string;
  type?: string;
  created_at?: string;
  modified_at?: string;
}

/** `POST /pipelines/v1/pipelines`. */
export interface CreatePipelineArgs {
  name: string;
  /** For example `INSERT INTO <sink> SELECT * FROM <stream>`. */
  sql: string;
}

/** A pipeline as the API returns it. */
export interface Pipeline {
  id: string;
  name: string;
  sql?: string;
  /** For example `initializing`, `running` or `failed`. */
  status?: string;
  created_at?: string;
  modified_at?: string;
}

/** Page size of the list calls. */
const LIST_PAGE_SIZE = 100;

/**
 * Every row of a v1 list. The lists report `result_info.total_count` rather
 * than `total_pages` (checked against a live account on 2026-09-27), so they
 * are read page by page until a short page or the total is reached.
 */
async function listAll<T>(
  http: HttpApi,
  path: string,
  query: SendOptions["query"] = {},
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 1000; page++) {
    const envelope = await http.send("GET", http.acct(path), {
      query: { ...query, page, per_page: LIST_PAGE_SIZE },
    });
    const rows = Array.isArray(envelope.result) ? (envelope.result as T[]) : [];
    all.push(...rows);
    const total = envelope.result_info?.total_count;
    if (rows.length < LIST_PAGE_SIZE || (total !== undefined && all.length >= total)) break;
  }
  return all;
}

export function createPipelines(http: HttpApi) {
  return {
    /** `GET /pipelines/v1/streams`, every page. */
    listStreams(): Promise<PipelineStream[]> {
      return listAll(http, "/pipelines/v1/streams");
    },

    /**
     * `GET /pipelines/v1/streams?per_page=1`: one page of one stream. The
     * cheapest call that tells whether the token and the account can use
     * Pipelines at all (a refusal is a 403 with code 100).
     */
    async probeStreams(): Promise<void> {
      await http.send("GET", http.acct("/pipelines/v1/streams"), {
        query: { page: 1, per_page: 1 },
      });
    },

    /** `POST /pipelines/v1/streams`. */
    createStream(args: CreateStreamArgs): Promise<PipelineStream> {
      return http.result("POST", http.acct("/pipelines/v1/streams"), { json: args });
    },

    /** `GET /pipelines/v1/streams/{id}`. */
    getStream(id: string): Promise<PipelineStream> {
      return http.result("GET", http.acct(`/pipelines/v1/streams/${enc(id)}`));
    },

    /** `DELETE /pipelines/v1/streams/{id}`. */
    deleteStream(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/pipelines/v1/streams/${enc(id)}`));
    },

    /** `GET /pipelines/v1/sinks`, every page. */
    listSinks(): Promise<PipelineSink[]> {
      return listAll(http, "/pipelines/v1/sinks");
    },

    /** `POST /pipelines/v1/sinks`. The body carries the sink's token. */
    createSink(args: CreateCatalogSinkArgs): Promise<PipelineSink> {
      return http.result("POST", http.acct("/pipelines/v1/sinks"), { json: args });
    },

    /** `GET /pipelines/v1/sinks/{id}`. */
    getSink(id: string): Promise<PipelineSink> {
      return http.result("GET", http.acct(`/pipelines/v1/sinks/${enc(id)}`));
    },

    /** `DELETE /pipelines/v1/sinks/{id}`. */
    deleteSink(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/pipelines/v1/sinks/${enc(id)}`));
    },

    /** `GET /pipelines/v1/pipelines`, every page. */
    listPipelines(): Promise<Pipeline[]> {
      return listAll(http, "/pipelines/v1/pipelines");
    },

    /** `POST /pipelines/v1/pipelines`. */
    createPipeline(args: CreatePipelineArgs): Promise<Pipeline> {
      return http.result("POST", http.acct("/pipelines/v1/pipelines"), { json: args });
    },

    /** `GET /pipelines/v1/pipelines/{id}`. */
    getPipeline(id: string): Promise<Pipeline> {
      return http.result("GET", http.acct(`/pipelines/v1/pipelines/${enc(id)}`));
    },

    /** `DELETE /pipelines/v1/pipelines/{id}`. */
    deletePipeline(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/pipelines/v1/pipelines/${enc(id)}`));
    },
  };
}
