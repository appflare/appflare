import type { CloudflareClient } from "@appflare/cf-api";
import type { SandboxInfo } from "@appflare/schema";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { sandboxBinding } from "./binding";
import { readSandboxStatus, sandboxBindingDangles } from "./connect.server";
import { recordSandboxCheck } from "./worker-deleted";

/**
 * Whether the serving version of Appflare's Worker binds `SANDBOX` to a
 * Worker that was deleted (two API calls); false while Appflare does not
 * know its own Worker yet.
 */
export function bindingDanglesWith(
  db: D1Database,
  client: () => Promise<CloudflareClient>,
): () => Promise<boolean> {
  return async () => {
    const { worker_name } = await readSettings(createDb(db), [SETTING.workerName]);
    return worker_name ? sandboxBindingDangles(await client(), worker_name) : false;
  };
}

/**
 * Whether Appflare is connected to the sandbox Worker, for starting work
 * that needs it, and what the sandbox Worker says about itself: one call
 * through the `SANDBOX` binding, and only when that fails, the bindings
 * Cloudflare reports. A binding to a deleted Worker (a disable that stopped
 * before its last step leaves one) is not a connection, so the start turns
 * sandbox builds on first as it does with no binding. A binding that fails
 * otherwise, or when the API cannot tell, counts as connected, and what
 * uses it reports the failure. What it finds is recorded for the pages that
 * show whether sandbox builds are on (./worker-deleted.ts).
 */
export async function readSandboxConnection(
  env: CfClientEnv & { SANDBOX?: unknown },
  client: () => Promise<CloudflareClient> = () => getCfClient(env),
): Promise<{ connected: boolean; info: SandboxInfo | null }> {
  const status = await readSandboxStatus({
    binding: sandboxBinding(env),
    bindingDangles: bindingDanglesWith(env.DB, client),
  });
  await recordSandboxCheck(createDb(env.DB), status);
  return { connected: status.connected, info: status.info };
}
