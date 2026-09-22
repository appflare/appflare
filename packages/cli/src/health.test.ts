import { describe, expect, it } from "vitest";
import { checkHealth, waitForHealth } from "./health.ts";
import { activeVersionId, type Deployment, previousVersionId } from "./worker-info.ts";

describe("checkHealth", () => {
  it("reads the manager's health body", async () => {
    const health = await checkHealth(
      async () => Response.json({ version: "0.1.0", db: "ok" }),
      "https://a.b.workers.dev",
    );
    expect(health).toEqual({ ok: true, version: "0.1.0", db: "ok", schemaVersion: undefined });
  });
  it("reports a failing database and a 1042 page", async () => {
    expect(
      await checkHealth(
        async () => Response.json({ version: "0.1.0", db: "error" }, { status: 503 }),
        "https://a.b.workers.dev",
      ),
    ).toEqual({ ok: false, reason: "HTTP 503 (version 0.1.0, db error)" });
    expect(
      await checkHealth(
        async () => new Response("error code: 1042", { status: 404 }),
        "https://a.b.workers.dev",
      ),
    ).toEqual({
      ok: false,
      reason: "HTTP 404 (error code: 1042)",
    });
  });
  it("never throws on network errors", async () => {
    const health = await checkHealth(async () => {
      throw new Error("ECONNRESET");
    }, "https://a.b.workers.dev");
    expect(health).toEqual({ ok: false, reason: "ECONNRESET" });
  });
});

describe("waitForHealth", () => {
  it("retries until the manager answers", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const health = await waitForHealth(
      async () =>
        ++n < 3 ? new Response("nope", { status: 404 }) : Response.json({ version: "1", db: "ok" }),
      "https://a.b.workers.dev",
      { intervalMs: 5, timeoutMs: 10_000, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(health.ok).toBe(true);
    expect(sleeps).toEqual([5, 5]);
  });
});

describe("deployment helpers", () => {
  const d = (created_on: string, versions: [string, number][]): Deployment => ({
    id: created_on,
    created_on,
    versions: versions.map(([version_id, percentage]) => ({ version_id, percentage })),
  });
  it("finds the active and previous stable versions, skipping split deployments", () => {
    const list = [
      d("1", [["v-1", 100]]),
      d("2", [
        ["v-1", 50],
        ["v-2", 50],
      ]),
      d("3", [["v-3", 100]]),
    ];
    expect(activeVersionId(list)).toBe("v-3");
    expect(previousVersionId(list)).toBe("v-1");
    expect(previousVersionId([d("1", [["v-1", 100]])])).toBeNull();
  });
});
