import type { HttpApi } from "../http";
import type { KvNamespace } from "../types";

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

    /** `DELETE /storage/kv/namespaces/{id}`. */
    deleteNamespace(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/storage/kv/namespaces/${enc(id)}`));
    },
  };
}
