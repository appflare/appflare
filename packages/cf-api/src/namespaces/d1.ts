import type { HttpApi } from "../http";
import type {
  D1Database,
  D1QueryResult,
  D1TimeTravelBookmark,
  D1TimeTravelRestore,
} from "../types";

const enc = encodeURIComponent;

/** Cloudflare's own default page size for the database list (it takes 10 to 10,000). */
const LIST_PAGE_SIZE = 1000;

/** Restore either to an explicit bookmark or to a point in time. */
export type RestoreArgs = { bookmark: string } | { timestamp: string };

/** D1 databases, queries, and Time Travel. */
export function createD1(http: HttpApi) {
  const timeTravelBase = (databaseId: string) =>
    http.acct(`/d1/database/${enc(databaseId)}/time_travel`);

  const api = {
    /** `POST /d1/database` with `{ name }`. */
    createDatabase(name: string): Promise<D1Database> {
      return http.result("POST", http.acct("/d1/database"), { json: { name } });
    },

    /**
     * `GET /d1/database?page=&per_page=`: every database in the account. The
     * list reports `total_count` rather than `total_pages`, so it is read page
     * by page until a short page or the total is reached.
     */
    async listDatabases(): Promise<D1Database[]> {
      const all: D1Database[] = [];
      for (let page = 1; page <= 1000; page++) {
        const envelope = await http.send("GET", http.acct("/d1/database"), {
          query: { page, per_page: LIST_PAGE_SIZE },
        });
        const rows = Array.isArray(envelope.result) ? (envelope.result as D1Database[]) : [];
        all.push(...rows);
        const total = envelope.result_info?.total_count;
        if (rows.length < LIST_PAGE_SIZE || (total !== undefined && all.length >= total)) break;
      }
      return all;
    },

    /** `GET /d1/database/{uuid}`. */
    getDatabase(databaseId: string): Promise<D1Database> {
      return http.result("GET", http.acct(`/d1/database/${enc(databaseId)}`));
    },

    /** `DELETE /d1/database/{uuid}`. */
    deleteDatabase(databaseId: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/d1/database/${enc(databaseId)}`));
    },

    /** `POST /d1/database/{uuid}/query` — returns the array of statement results. */
    query(databaseId: string, sql: string, params?: unknown[]): Promise<D1QueryResult[]> {
      return http.result("POST", http.acct(`/d1/database/${enc(databaseId)}/query`), {
        json: params === undefined ? { sql } : { sql, params },
      });
    },

    /**
     * `GET /d1/database/{uuid}/time_travel/bookmark[?timestamp=<ISO>]` — the current
     * bookmark, or the bookmark at `timestamp`. Path and query taken from wrangler
     * (`getBookmarkIdFromTimestamp`). Timestamp is passed through verbatim; wrangler
     * additionally coerces non-ISO input to ISO before sending.
     */
    bookmark(databaseId: string, opts: { timestamp?: string } = {}): Promise<D1TimeTravelBookmark> {
      return http.result("GET", `${timeTravelBase(databaseId)}/bookmark`, {
        query: opts.timestamp === undefined ? undefined : { timestamp: opts.timestamp },
      });
    },

    /**
     * `POST /d1/database/{uuid}/time_travel/restore?bookmark=<id>`. Matching
     * wrangler's `handleRestore`, restore is always by bookmark: when a timestamp is
     * given, its bookmark is resolved via {@link bookmark} first, then restored.
     */
    async restore(databaseId: string, args: RestoreArgs): Promise<D1TimeTravelRestore> {
      const bookmarkId =
        "bookmark" in args ? args.bookmark : (await api.bookmark(databaseId, args)).bookmark;
      return http.result("POST", `${timeTravelBase(databaseId)}/restore`, {
        query: { bookmark: bookmarkId },
      });
    },
  };

  return api;
}
