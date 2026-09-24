import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthGuardError, requireRole } from "../auth/guards";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  deleteRetainedDataAs,
  forgetRemovedAppAs,
  forgetRemovedAppCore,
  isDeleteRetainedJob,
  listRemovedAppsCore,
} from "./removed-apps.server";

/** Removed apps: which uninstalled installs are listed, and what Forget changes. */

const AT = 1_790_000_000_000;

async function install(id: string, status: string, uninstalledAt: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, display_name, catalog_version, artifact_url,
       status, installed_at, updated_at, uninstalled_at)
     VALUES (?1, 'cut', ?1, ?2, '1.0.0', 'u', ?3, 1, 1, ?4)`,
  )
    .bind(id, id === "a" ? "Links" : null, status, uninstalledAt)
    .run();
}

async function resource(
  installId: string,
  id: string,
  kind: string,
  state: "live" | "retained" | "deleted" | "retained-then-deleted",
) {
  await env.DB.prepare(
    `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at, retained_at, deleted_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1, ?6, ?7)`,
  )
    .bind(
      `${installId}:${id}`,
      installId,
      kind,
      `${installId}-${id}`,
      `cf-${id}`,
      state === "retained" || state === "retained-then-deleted" ? 5 : null,
      state === "deleted" || state === "retained-then-deleted" ? 6 : null,
    )
    .run();
}

async function job(id: string, installId: string, status: string, input: object = {}) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, input_json, error)
     VALUES (?1, ?2, 'uninstall', ?3, ?4, ?5)`,
  )
    .bind(id, installId, status, JSON.stringify(input), status === "failed" ? "boom" : null)
    .run();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("listRemovedAppsCore", () => {
  it("lists only uninstalled installs that still keep something, newest uninstall first", async () => {
    // Kept a KV namespace and a bucket; its Worker is gone.
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    await resource("a", "r2", "r2", "retained");
    await resource("a", "worker", "worker", "deleted");
    // Kept a database, uninstalled later.
    await install("b", "uninstalled", AT + 1000);
    await resource("b", "d1", "d1", "retained");
    // Kept something once, since deleted: nothing left, so not listed.
    await install("c", "uninstalled", AT);
    await resource("c", "d1", "d1", "retained-then-deleted");
    // Kept nothing at all: not listed.
    await install("d", "uninstalled", AT);
    await resource("d", "kv", "kv", "deleted");
    // Still installed, and an unfinished uninstall: not removed apps.
    await install("e", "installed");
    await resource("e", "kv", "kv", "live");
    await install("f", "uninstalling");
    await resource("f", "kv", "kv", "retained");

    const rows = await listRemovedAppsCore(env.DB);

    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[1]).toEqual({
      id: "a",
      slug: "cut",
      label: "Links",
      workerName: "a",
      uninstalledAt: new Date(AT).toISOString(),
      retained: [
        { id: "a:kv", kind: "kv", binding: null, name: "a-kv", cfId: "cf-kv" },
        { id: "a:r2", kind: "r2", binding: null, name: "a-r2", cfId: "cf-r2" },
      ],
      activeJobId: null,
      lastFailure: null,
    });
    expect(rows[0]?.label).toBe("b");
  });

  it("shows a deletion in progress, and the last one that failed", async () => {
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    await install("b", "uninstalled", AT);
    await resource("b", "kv", "kv", "retained");
    await job("j1", "a", "succeeded");
    await job("j2", "a", "running", { deleteRetained: true });
    await job("k1", "b", "succeeded");
    await job("k2", "b", "failed", { deleteRetained: true });

    const rows = await listRemovedAppsCore(env.DB);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("a")?.activeJobId).toBe("j2");
    expect(byId.get("a")?.lastFailure).toBeNull();
    expect(byId.get("b")?.activeJobId).toBeNull();
    expect(byId.get("b")?.lastFailure).toEqual({ jobId: "k2", error: "boom" });
  });
});

describe("forgetRemovedAppCore", () => {
  it("hides the install and changes nothing else: resources, row, and jobs stay", async () => {
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    await job("j1", "a", "succeeded");
    const before = await env.DB.prepare("SELECT * FROM resources ORDER BY rowid").all();

    await forgetRemovedAppCore(env.DB, "a", new Date(AT + 5));

    expect(await listRemovedAppsCore(env.DB)).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT status, forgotten_at FROM installs WHERE id = 'a'",
    ).first();
    expect(row).toEqual({ status: "uninstalled", forgotten_at: AT + 5 });
    const after = await env.DB.prepare("SELECT * FROM resources ORDER BY rowid").all();
    expect(after.results).toEqual(before.results);
    const jobs = await env.DB.prepare("SELECT id FROM jobs").all();
    expect(jobs.results).toEqual([{ id: "j1" }]);

    // Forgetting again keeps the first time.
    await forgetRemovedAppCore(env.DB, "a", new Date(AT + 9));
    const again = await env.DB.prepare("SELECT forgotten_at FROM installs WHERE id = 'a'").first();
    expect(again).toEqual({ forgotten_at: AT + 5 });
  });

  it("refuses an install that is missing, not uninstalled, or busy", async () => {
    await expect(forgetRemovedAppCore(env.DB, "nope")).rejects.toThrow("There is no such install.");
    await install("e", "installed");
    await expect(forgetRemovedAppCore(env.DB, "e")).rejects.toThrow(
      "Only an uninstalled app can be forgotten.",
    );
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    await job("j2", "a", "running", { deleteRetained: true });
    await expect(forgetRemovedAppCore(env.DB, "a")).rejects.toThrow(/queued or running/);
    const row = await env.DB.prepare("SELECT forgotten_at FROM installs WHERE id = 'a'").first();
    expect(row).toEqual({ forgotten_at: null });
  });
});

describe("admin actions", () => {
  /** The admin check the server functions pass, for a signed-in member. */
  const asMember = () =>
    requireRole("admin", async () => ({
      user: { id: "u2", email: "m@example.com", name: "M", role: "member" },
      session: { id: "s2", expiresAt: new Date("2030-01-01T00:00:00Z") },
    }));

  async function refusal(promise: Promise<unknown>): Promise<number | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      return error instanceof AuthGuardError ? error.status : -1;
    }
  }

  it("refuses a member Delete retained data before anything is started", async () => {
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    let created = 0;
    const status = await refusal(
      deleteRetainedDataAs(
        asMember,
        {
          db: env.DB,
          createJob: async (id) => {
            created += 1;
            return { id };
          },
        },
        "a",
      ),
    );
    expect(status).toBe(403);
    expect(created).toBe(0);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });

  it("refuses a member Forget and leaves the install listed", async () => {
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    expect(await refusal(forgetRemovedAppAs(asMember, env.DB, "a"))).toBe(403);
    const row = await env.DB.prepare("SELECT forgotten_at FROM installs WHERE id = 'a'").first();
    expect(row).toEqual({ forgotten_at: null });
    expect((await listRemovedAppsCore(env.DB)).map((r) => r.id)).toEqual(["a"]);
  });

  it("lets an admin through", async () => {
    await install("a", "uninstalled", AT);
    await resource("a", "kv", "kv", "retained");
    const asAdmin = () =>
      requireRole("admin", async () => ({
        user: { id: "u1", email: "a@example.com", name: "A", role: "admin" },
        session: { id: "s1", expiresAt: new Date("2030-01-01T00:00:00Z") },
      }));
    await forgetRemovedAppAs(asAdmin, env.DB, "a", new Date(AT));
    expect(await listRemovedAppsCore(env.DB)).toEqual([]);
  });
});

describe("isDeleteRetainedJob", () => {
  it("tells a deletion of kept data from an uninstall", () => {
    expect(isDeleteRetainedJob({ kind: "uninstall", input_json: '{"deleteRetained":true}' })).toBe(
      true,
    );
    expect(isDeleteRetainedJob({ kind: "uninstall", input_json: '{"retry":false}' })).toBe(false);
    expect(isDeleteRetainedJob({ kind: "rollback", input_json: '{"deleteRetained":true}' })).toBe(
      false,
    );
    expect(isDeleteRetainedJob({ kind: "uninstall", input_json: "not json" })).toBe(false);
    expect(isDeleteRetainedJob({ kind: "uninstall", input_json: null })).toBe(false);
  });
});
