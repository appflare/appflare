import { z } from "zod";
import type { FetchLike } from "./release.ts";

/** The manager's `GET /api/health` body (apps/manager/src/server/health.server.ts). */
const healthSchema = z.looseObject({
  version: z.string(),
  db: z.string(),
  schemaVersion: z.number().optional(),
});

export type Health =
  | {
      ok: true;
      version: string;
      db: string;
      schemaVersion?: number;
    }
  | { ok: false; reason: string };

/** GETs `<url>/api/health` once, with a timeout. Never throws. */
export async function checkHealth(
  fetchFn: FetchLike,
  workerUrl: string,
  timeoutMs = 10_000,
): Promise<Health> {
  const url = new URL("/api/health", workerUrl).toString();
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: z.infer<typeof healthSchema> | undefined;
    try {
      body = healthSchema.parse(JSON.parse(text));
    } catch {
      body = undefined;
    }
    if (response.ok && body?.db === "ok") {
      return {
        ok: true,
        version: body.version,
        db: body.db,
        schemaVersion: body.schemaVersion,
      };
    }
    const detail = body ? `version ${body.version}, db ${body.db}` : text.slice(0, 120).trim();
    return { ok: false, reason: `HTTP ${response.status}${detail ? ` (${detail})` : ""}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Polls the health endpoint until it answers `db: "ok"` or `timeoutMs` passes.
 * A fresh workers.dev route can take a few seconds to answer, and the
 * manager's first request also runs its D1 migrations.
 */
export async function waitForHealth(
  fetchFn: FetchLike,
  workerUrl: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Health> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: Health = { ok: false, reason: "not checked" };
  for (;;) {
    last = await checkHealth(fetchFn, workerUrl);
    if (last.ok || Date.now() + intervalMs > deadline) {
      return last;
    }
    await sleep(intervalMs);
  }
}
