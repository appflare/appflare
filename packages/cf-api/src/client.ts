import { type ClientOptions, createHttpApi } from "./http";
import { createAccess } from "./namespaces/access";
import { createAssets } from "./namespaces/assets";
import { createD1 } from "./namespaces/d1";
import { createKv } from "./namespaces/kv";
import { createQueues } from "./namespaces/queues";
import { createR2 } from "./namespaces/r2";
import { createTokens } from "./namespaces/tokens";
import { createVectorize } from "./namespaces/vectorize";
import { createVersions } from "./namespaces/versions";
import { createWorkers } from "./namespaces/workers";

export interface CloudflareClient {
  readonly accountId: string;
  readonly tokens: ReturnType<typeof createTokens>;
  readonly workers: ReturnType<typeof createWorkers>;
  readonly versions: ReturnType<typeof createVersions>;
  readonly assets: ReturnType<typeof createAssets>;
  readonly kv: ReturnType<typeof createKv>;
  readonly d1: ReturnType<typeof createD1>;
  readonly r2: ReturnType<typeof createR2>;
  readonly queues: ReturnType<typeof createQueues>;
  readonly vectorize: ReturnType<typeof createVectorize>;
  readonly access: ReturnType<typeof createAccess>;
}

/**
 * Creates a typed Cloudflare REST API client bound to one `{ accountId, token }`
 * context. Runtime-agnostic: it uses only
 * the injected/global `fetch` and Web-standard `FormData`/`Blob`/`crypto`, so the
 * same client runs inside a Worker and in Node 22. No global state.
 */
export function createClient(options: ClientOptions): CloudflareClient {
  const http = createHttpApi(options);
  return {
    accountId: http.accountId,
    tokens: createTokens(http),
    workers: createWorkers(http),
    versions: createVersions(http),
    assets: createAssets(http),
    kv: createKv(http),
    d1: createD1(http),
    r2: createR2(http),
    queues: createQueues(http),
    vectorize: createVectorize(http),
    access: createAccess(http),
  };
}
