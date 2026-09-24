import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  CloudflareApiError,
  type CreateDeploymentArgs,
  type WorkerDeployment,
  type WorkerVersion,
} from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthGuardError, requireRole } from "../../auth/guards";
import { readAutoUpdateDefaults } from "../../auto-update/auto-update.server";
import { createDb } from "../../db/client";
import { createMigrator, KNOWN_SCHEMA_VERSION } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import { NO_ACTIVE_SELF_UPDATE_SQL } from "./guard";
import { parseVersionHistory } from "./plan";
import {
  appflareVersionOf,
  changedSecretsOf,
  managerVersionRows,
  readManagerHealth,
  rollbackSchemaRefusal,
} from "./rollback";
import {
  listManagerVersionsCore,
  ManagerRollbackError,
  type ManagerVersionsApi,
  ROLLBACK_BUSY,
  type RollBackManagerDeps,
  rollBackManagerAs,
  rollBackManagerCore,
} from "./rollback.server";

const OLD = "11111111-1111-4111-8111-111111111111";
const SERVING = "22222222-2222-4222-8222-222222222222";
const OLDEST = "33333333-3333-4333-8333-333333333333";
const NEWER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-25T12:00:00.000Z");

function version(
  id: string,
  number: number,
  appflare: string | null,
  extra: Array<Record<string, unknown>> = [],
): WorkerVersion {
  const bindings: Array<Record<string, unknown>> = [
    { type: "d1", name: "DB", id: "db-1" },
    { type: "kv_namespace", name: "KV", namespace_id: "kv-1" },
    ...extra,
  ];
  if (appflare !== null)
    bindings.push({ type: "plain_text", name: "APPFLARE_VERSION", text: appflare });
  return {
    id,
    number,
    metadata: { created_on: "2026-09-20T00:00:00Z", has_preview: true },
    annotations: { "workers/triggered_by": "version_upload" },
    resources: { bindings },
  };
}

interface FakeOptions {
  details?: WorkerVersion[];
  serving?: string;
  deployError?: unknown;
}

function fakeApi(options: FakeOptions = {}) {
  const details = new Map(
    (
      options.details ?? [
        version(SERVING, 41, "0.5.0", [{ type: "service", name: "SANDBOX", service: "s" }]),
        version(OLD, 40, "0.4.0"),
        version(OLDEST, 39, "0.3.0"),
      ]
    ).map((v) => [v.id, v]),
  );
  const deployments: CreateDeploymentArgs[] = [];
  const api: ManagerVersionsApi = {
    versions: {
      async listVersions() {
        return [...details.values()].map(({ resources: _, ...rest }) => rest);
      },
      async getVersion(_name: string, id: string) {
        const found = details.get(id);
        if (found === undefined) throw new Error(`no version ${id}`);
        return found;
      },
      async listDeployments(): Promise<WorkerDeployment[]> {
        return [
          { id: "d1", versions: [{ version_id: options.serving ?? SERVING, percentage: 100 }] },
        ];
      },
      async createDeployment(_name: string, args: CreateDeploymentArgs) {
        if (options.deployError !== undefined) throw options.deployError;
        deployments.push(args);
        return { id: "d2" };
      },
    },
    workers: {
      async getAccountSubdomain() {
        return { subdomain: "acme" };
      },
    },
  };
  return { api, deployments };
}

function healthFetch(report: Record<string, unknown> | null, urls: string[] = []) {
  return async (url: string) => {
    urls.push(url);
    return report === null ? new Response("not found", { status: 404 }) : Response.json(report);
  };
}

function deps(
  api: ManagerVersionsApi,
  report: Record<string, unknown> | null,
  urls: string[] = [],
): RollBackManagerDeps {
  return {
    db: env.DB,
    api: async () => api,
    currentVersion: "0.5.0",
    fetch: healthFetch(report, urls),
    sleep: async () => {},
    now: () => NOW,
    newId: () => "rb1",
    cache: new Map(),
    probeAttempts: 2,
  };
}

const HEALTHY = { version: "0.4.0", db: "ok", knownSchemaVersion: KNOWN_SCHEMA_VERSION };

async function jobRow() {
  return env.DB.prepare(
    "SELECT kind, status, error, workflow_instance_id, worker_version_id, input_json FROM jobs WHERE id = 'rb1'",
  ).first<{
    kind: string;
    status: string;
    error: string | null;
    workflow_instance_id: string | null;
    worker_version_id: string | null;
    input_json: string;
  }>();
}

async function logs(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT message FROM job_logs WHERE job_id = 'rb1' ORDER BY id",
  ).all<{ message: string }>();
  return rows.results.map((r) => r.message);
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: "acc-1",
    [SETTING.workerName]: "appflare",
    [SETTING.autoUpdateManager]: "on",
  });
});

describe("rollbackSchemaRefusal (the downgrade banner's comparison)", () => {
  it("lets code that knows every migration serve the database", () => {
    expect(rollbackSchemaRefusal("0.4.0", 16, 16)).toBeNull();
    expect(rollbackSchemaRefusal("0.4.0", 15, 16)).toBeNull();
  });

  it("refuses code older than the database's schema", () => {
    expect(rollbackSchemaRefusal("0.4.0", 16, 15)).toMatch(
      /written for database schema 15, and the database is at schema 16/,
    );
  });

  it("refuses a version that cannot say which schema it knows", () => {
    expect(rollbackSchemaRefusal("0.3.0", 16, null)).toMatch(
      /does not report which database schema/,
    );
  });
});

describe("the pure reads", () => {
  it("reads the Appflare release from the version's binding", () => {
    expect(appflareVersionOf(version(OLD, 40, "0.4.0"))).toBe("0.4.0");
    expect(appflareVersionOf(version(OLD, 40, null))).toBeNull();
  });

  it("marks the serving version and the older ones", () => {
    const listed = [
      version(OLD, 40, "0.4.0"),
      version(SERVING, 41, "0.5.0"),
      version(NEWER, 42, "0.6.0"),
    ];
    const rows = managerVersionRows(listed, new Map(listed.map((v) => [v.id, v])), SERVING, 41);
    expect(rows.map((r) => [r.number, r.appflareVersion, r.serving, r.older])).toEqual([
      [42, "0.6.0", false, false],
      [41, "0.5.0", true, false],
      [40, "0.4.0", false, true],
    ]);
  });

  it("reads a health report, with or without the schema it knows", () => {
    expect(readManagerHealth(JSON.stringify(HEALTHY))).toEqual(HEALTHY);
    expect(readManagerHealth('{"version":"0.3.0","db":"ok"}')).toEqual({
      version: "0.3.0",
      db: "ok",
      knownSchemaVersion: null,
    });
    expect(readManagerHealth("<html>")).toBeNull();
  });

  it("names the secrets Cloudflare says changed", () => {
    const error = new CloudflareApiError({
      status: 400,
      method: "POST",
      path: "/accounts/a/workers/scripts/appflare/deployments",
      errors: [
        {
          code: 10220,
          message:
            "Cannot deploy. The following secrets have changed: CF_API_TOKEN, BETTER_AUTH_SECRET",
        },
      ],
    });
    expect(changedSecretsOf(error)).toEqual(["CF_API_TOKEN", "BETTER_AUTH_SECRET"]);
    expect(changedSecretsOf(new Error("other"))).toBeNull();
  });
});

describe("listManagerVersionsCore", () => {
  it("lists the newest versions with their releases and the serving one", async () => {
    const { api } = fakeApi();
    const view = await listManagerVersionsCore({ db: env.DB, api, cache: new Map() });
    expect(view.servingVersionId).toBe(SERVING);
    expect(view.versions.map((v) => [v.appflareVersion, v.serving, v.older])).toEqual([
      ["0.5.0", true, false],
      ["0.4.0", false, true],
      ["0.3.0", false, true],
    ]);
  });
});

describe("rollBackManagerCore", () => {
  it("checks the older version's preview, then deploys it and records a self_rollback job", async () => {
    const { api, deployments } = fakeApi();
    const urls: string[] = [];
    const result = await rollBackManagerCore(deps(api, HEALTHY, urls), { versionId: OLD });
    expect(result).toEqual({
      jobId: "rb1",
      version: "0.4.0",
      versionId: OLD,
      fromVersion: "0.5.0",
      finishedAt: NOW.toISOString(),
    });
    expect(urls).toEqual(["https://11111111-appflare.acme.workers.dev/api/health"]);
    // One deployment of the target to all traffic, never forced.
    expect(deployments).toEqual([
      {
        versions: [{ version_id: OLD, percentage: 100 }],
        annotations: { "workers/message": "Appflare: roll back to 0.4.0" },
      },
    ]);
    const job = await jobRow();
    expect(job).toMatchObject({
      kind: "self_rollback",
      status: "succeeded",
      workflow_instance_id: null,
      worker_version_id: OLD,
    });
    expect(JSON.parse(job?.input_json ?? "{}")).toEqual({
      versionId: OLD,
      fromVersion: "0.5.0",
      version: "0.4.0",
      fromVersionId: SERVING,
    });
    // Automatic updates would move Appflare forward again at once.
    expect((await readAutoUpdateDefaults(createDb(env.DB))).manager).toBe(false);
    const history = await readSettings(createDb(env.DB), [SETTING.managerVersionHistory]);
    expect(parseVersionHistory(history.manager_version_history)).toEqual([
      {
        version: "0.4.0",
        from: "0.5.0",
        jobId: "rb1",
        workerVersionId: OLD,
        at: NOW.toISOString(),
      },
    ]);
    const lines = await logs();
    expect(lines).toContain(`Version ${OLD} (Appflare 0.4.0) now serves all traffic.`);
    expect(lines.some((l) => l.includes("SANDBOX"))).toBe(true);
  });

  it("refuses a version whose code is older than the database's schema", async () => {
    const { api, deployments } = fakeApi();
    const stale = { ...HEALTHY, knownSchemaVersion: KNOWN_SCHEMA_VERSION - 1 };
    await expect(rollBackManagerCore(deps(api, stale), { versionId: OLD })).rejects.toThrow(
      /the database is at schema/,
    );
    expect(deployments).toEqual([]);
    expect(await jobRow()).toMatchObject({ kind: "self_rollback", status: "failed" });
    expect((await readAutoUpdateDefaults(createDb(env.DB))).manager).toBe(true);
  });

  it("refuses a version that does not report the schema it knows", async () => {
    const { api, deployments } = fakeApi();
    const { knownSchemaVersion: _, ...older } = HEALTHY;
    await expect(rollBackManagerCore(deps(api, older), { versionId: OLD })).rejects.toThrow(
      ManagerRollbackError,
    );
    expect(deployments).toEqual([]);
  });

  it("refuses when the preview answers as another release or not at all", async () => {
    const { api, deployments } = fakeApi();
    await expect(
      rollBackManagerCore(deps(api, { ...HEALTHY, version: "0.3.9" }), { versionId: OLD }),
    ).rejects.toThrow(/reports Appflare 0.3.9, not 0.4.0/);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), {
      [SETTING.accountId]: "acc-1",
      [SETTING.workerName]: "appflare",
    });
    await expect(rollBackManagerCore(deps(api, null), { versionId: OLD })).rejects.toThrow(
      /did not answer with Appflare's health report/,
    );
    expect(deployments).toEqual([]);
  });

  it("refuses the serving version and newer ones", async () => {
    const { api } = fakeApi({ serving: OLD });
    await expect(rollBackManagerCore(deps(api, HEALTHY), { versionId: OLD })).rejects.toThrow(
      /already serves all traffic/,
    );
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), {
      [SETTING.accountId]: "acc-1",
      [SETTING.workerName]: "appflare",
    });
    const newer = fakeApi({ serving: OLDEST });
    await expect(rollBackManagerCore(deps(newer.api, HEALTHY), { versionId: OLD })).rejects.toThrow(
      /not older than the version serving now/,
    );
    expect(newer.deployments).toEqual([]);
  });

  it("passes on Cloudflare's refusal when secrets changed, never forcing it", async () => {
    const deployError = new CloudflareApiError({
      status: 400,
      method: "POST",
      path: "/accounts/acc-1/workers/scripts/appflare/deployments",
      errors: [{ code: 10220, message: "The following secrets have changed: CF_API_TOKEN" }],
    });
    const { api } = fakeApi({ deployError });
    await expect(rollBackManagerCore(deps(api, HEALTHY), { versionId: OLD })).rejects.toThrow(
      /the secret\(s\) CF_API_TOKEN changed since version/,
    );
    expect(await jobRow()).toMatchObject({ status: "failed" });
    expect((await readAutoUpdateDefaults(createDb(env.DB))).manager).toBe(true);
  });

  it("does not start while another job runs", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('other', NULL, 'sandbox_update', 'running')",
    ).run();
    const { api, deployments } = fakeApi();
    await expect(rollBackManagerCore(deps(api, HEALTHY), { versionId: OLD })).rejects.toThrow(
      ROLLBACK_BUSY,
    );
    expect(await jobRow()).toBeNull();
    expect(deployments).toEqual([]);
  });

  it("holds every other job while it runs", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, started_at) VALUES ('rb0', NULL, 'self_rollback', 'running', ?1)",
    )
      .bind(NOW.getTime())
      .run();
    const free = await env.DB.prepare(
      `SELECT 1 AS free WHERE ${NO_ACTIVE_SELF_UPDATE_SQL}`,
    ).first();
    expect(free).toBeNull();
  });
});

describe("rollBackManagerAs", () => {
  const session = (role: string) => async () => ({
    user: { id: "u1", email: "u@example.com", name: "U", role },
    session: { id: "s1", expiresAt: new Date("2030-01-01T00:00:00Z") },
  });

  it("refuses a member before anything is read or written", async () => {
    const { api, deployments } = fakeApi();
    let status: number | null = null;
    try {
      await rollBackManagerAs(() => requireRole("admin", session("member")), deps(api, HEALTHY), {
        versionId: OLD,
      });
    } catch (error) {
      status = error instanceof AuthGuardError ? error.status : -1;
    }
    expect(status).toBe(403);
    expect(await jobRow()).toBeNull();
    expect(deployments).toEqual([]);
  });

  it("lets an admin (the owner is one) roll back", async () => {
    const { api, deployments } = fakeApi();
    await rollBackManagerAs(() => requireRole("admin", session("admin")), deps(api, HEALTHY), {
      versionId: OLD,
    });
    expect(deployments).toHaveLength(1);
  });
});
