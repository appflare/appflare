import type { HttpApi } from "../http";

/** One column of an Analytics Engine SQL answer. */
export interface AnalyticsEngineSqlColumn {
  name: string;
  type: string;
}

/** The SQL API's JSON answer (not Cloudflare's usual envelope). */
export interface AnalyticsEngineSqlResult {
  meta: AnalyticsEngineSqlColumn[];
  data: Array<Record<string, unknown>>;
  rows: number;
}

/**
 * Workers Analytics Engine, read through its SQL API. The API answers with
 * the query's own JSON (`meta`, `data`, `rows`), not the `{ success, result }`
 * envelope; refusals from the SQL service itself come back as plain text
 * ("Authorization error"), which the HTTP layer reports as a
 * `CloudflareApiError` with the status and no Cloudflare error code.
 */
export function createAnalyticsEngine(http: HttpApi) {
  return {
    /**
     * `POST /accounts/{id}/analytics_engine/sql` with the query as a plain
     * text body. Read-only for `SELECT` and `SHOW` statements.
     */
    async sql(query: string): Promise<AnalyticsEngineSqlResult> {
      const answer = (await http.send("POST", http.acct("/analytics_engine/sql"), {
        raw: { body: query, contentType: "text/plain" },
      })) as unknown as Partial<AnalyticsEngineSqlResult>;
      return {
        meta: Array.isArray(answer.meta) ? answer.meta : [],
        data: Array.isArray(answer.data) ? answer.data : [],
        rows: typeof answer.rows === "number" ? answer.rows : 0,
      };
    },
  };
}
