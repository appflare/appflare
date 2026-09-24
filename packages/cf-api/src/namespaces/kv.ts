import { CloudflareApiError } from "../errors";
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

    /**
     * `PUT /storage/kv/namespaces/{id}/values/{key}` with the value as the raw
     * body. Every write counts toward the account's KV write limit (1,000 a
     * day on Workers Free).
     */
    /**
     * `GET /storage/kv/namespaces/{id}/values/{key}`: the value as text, or
     * null when the key does not exist (404). The API answers the raw value,
     * not an envelope, so this reads only values that are not themselves
     * JSON (such as a name).
     */
    async getValue(namespaceId: string, key: string): Promise<string | null> {
      try {
        const envelope = await http.send(
          "GET",
          http.acct(`/storage/kv/namespaces/${enc(namespaceId)}/values/${enc(key)}`),
        );
        return typeof envelope.result === "string" ? envelope.result : null;
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) return null;
        throw error;
      }
    },

    async putValue(namespaceId: string, key: string, value: string): Promise<void> {
      await http.send(
        "PUT",
        http.acct(`/storage/kv/namespaces/${enc(namespaceId)}/values/${enc(key)}`),
        { raw: { body: value, contentType: "text/plain" } },
      );
    },

    /** `DELETE /storage/kv/namespaces/{id}/values/{key}`; a missing key is not an error. */
    async deleteValue(namespaceId: string, key: string): Promise<void> {
      await http.send(
        "DELETE",
        http.acct(`/storage/kv/namespaces/${enc(namespaceId)}/values/${enc(key)}`),
      );
    },

    /** `DELETE /storage/kv/namespaces/{id}`. */
    deleteNamespace(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/storage/kv/namespaces/${enc(id)}`));
    },
  };
}
