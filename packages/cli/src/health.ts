import { z } from "zod";
import type { FetchLike } from "./release.ts";

/** The manager's `GET /api/health` body (apps/manager/src/server/health.server.ts). */
const healthSchema = z.looseObject({
  version: z.string(),
  db: z.string(),
  schemaVersion: z.number().optional(),
  // Newer managers also report the newest release their cron has seen.
  latestVersion: z.string().nullable().optional(),
  updateAvailable: z.boolean().optional(),
});

export type Health =
  | {
      ok: true;
      version: string;
      db: string;
      schemaVersion?: number;
      /** Newest release the manager knows of; null when it has not checked, undefined on older managers. */
      latestVersion?: string | null;
      updateAvailable?: boolean;
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
        latestVersion: body.latestVersion,
        updateAvailable: body.updateAvailable,
      };
    }
    const detail = body ? `version ${body.version}, db ${body.db}` : text.slice(0, 120).trim();
    return { ok: false, reason: `HTTP ${response.status}${detail ? ` (${detail})` : ""}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The update line of `status`: whether the running manager is behind the newest release. */
export function describeUpdate(health: Health | null): string {
  if (health === null || !health.ok) {
    return "unknown (the manager did not answer)";
  }
  if (health.latestVersion === undefined) {
    return `unknown (manager ${health.version} does not report updates)`;
  }
  if (health.latestVersion === null) {
    return `unknown (manager ${health.version} has not checked for releases yet)`;
  }
  if (typeof health.updateAvailable !== "boolean") {
    return `unknown (manager ${health.version} reports ${health.latestVersion} as the latest release but not whether it is newer)`;
  }
  return health.updateAvailable
    ? `Update available: ${health.latestVersion} (running ${health.version})`
    : `Up to date (running ${health.version}, latest ${health.latestVersion})`;
}

/** One line for a health result. */
export function describeHealth(health: Health | null): string {
  if (health === null) {
    return "not checked (no URL)";
  }
  return health.ok
    ? `ok (version ${health.version}, db ${health.db})`
    : `FAILING: ${health.reason}`;
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
    /** Also wait until this accepts a healthy answer (for example, the expected version). */
    accept?: (health: Extract<Health, { ok: true }>) => boolean;
  } = {},
): Promise<Health> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: Health = { ok: false, reason: "not checked" };
  for (;;) {
    last = await checkHealth(fetchFn, workerUrl);
    const done = last.ok && (options.accept?.(last) ?? true);
    if (done || Date.now() + intervalMs > deadline) {
      return last;
    }
    await sleep(intervalMs);
  }
}
