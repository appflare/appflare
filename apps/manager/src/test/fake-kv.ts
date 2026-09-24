/**
 * In-memory KV with metadata and a write counter (the free plan allows 1,000
 * writes a day, so tests count them).
 */
export function fakeKv() {
  const store = new Map<string, string>();
  const meta = new Map<string, unknown>();
  let writes = 0;
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async getWithMetadata(key: string) {
      return { value: store.get(key) ?? null, metadata: meta.get(key) ?? null };
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      writes += 1;
      store.set(key, value);
      meta.set(key, options?.metadata ?? null);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, meta, writes: () => writes };
}
