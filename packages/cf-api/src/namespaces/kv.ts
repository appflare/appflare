import type { HttpApi } from "../http";
import type { CursorPage, KvKey, KvNamespace } from "../types";

const enc = encodeURIComponent;

/** Workers KV namespaces. */
export function createKv(http: HttpApi) {
  return {
    /** `POST /storage/kv/namespaces` with `{ title }`. */
    createNamespace(title: string): Promise<KvNamespace> {
      return http.result("POST", http.acct("/storage/kv/namespaces"), { json: { title } });
    },

    /** `GET /storage/kv/namespaces` (paginated). */
    listNamespaces(): Promise<KvNamespace[]> {
      return http.list("GET", http.acct("/storage/kv/namespaces"));
    },

    /**
     * `GET /storage/kv/namespaces/{id}/keys?limit=&cursor=`: ONE page of key
     * names (Cloudflare allows `limit` 10 to 1000), with the cursor for the next
     * page (null on the last).
     */
    async listKeys(
      namespaceId: string,
      opts: { limit?: number; cursor?: string } = {},
    ): Promise<CursorPage<KvKey>> {
      const envelope = await http.send(
        "GET",
        http.acct(`/storage/kv/namespaces/${enc(namespaceId)}/keys`),
        { query: { limit: opts.limit, cursor: opts.cursor } },
      );
      const items = Array.isArray(envelope.result) ? (envelope.result as KvKey[]) : [];
      return { items, cursor: envelope.result_info?.cursor || null };
    },

    /** `DELETE /storage/kv/namespaces/{id}`. */
    deleteNamespace(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/storage/kv/namespaces/${enc(id)}`));
    },
  };
}
