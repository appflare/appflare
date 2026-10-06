import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startRollbackCore, startUpdateCore } from "../installs/versions.server";
import { type ArtifactFixtureOptions, buildArtifactFixture } from "../test/artifact-fixture";
import { fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import {
  cacheIndex,
  INSTALL_ID,
  OLD_VERSION,
  type SeedResource,
  seedInstall,
} from "../test/seed-install";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";
import { runUpdate, type UpdateJobParams } from "./update";
import { staleAddressValues } from "./update/address-settings";

/**
 * Settings filled in with the app's address (`{{appUrl}}`, `{{appHostname}}`)
 * after an update or a rollback: a rollback redeploys a version with the
 * address the app had when it was uploaded, and an update renders the
 * address the app had when it started. Either deploys the settings again
 * (a settings refresh job) when the address the app has now differs.
 */

const DOMAIN = "links.example.com";
const WORKERS_DEV = "https://cut.appflare-dev.workers.dev";

const APP: ArtifactFixtureOptions = {
  catalog: {
    vars: [
      { name: "PUBLIC_URL", label: "Public address", default: "{{appUrl}}", optional: true },
      { name: "PUBLIC_HOST", label: "Public host", default: "{{appHostname}}", optional: true },
      { name: "DEV_URL", label: "workers.dev address", default: "{{workerUrl}}", optional: true },
    ],
  },
};

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
  { kind: "domain", name: DOMAIN, cfId: "dom-1" },
];

const jobEnv = (): JobEnv => ({ DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN });

/** A job Workflow binding that records the jobs started through it. */
function jobsBinding() {
  const created: Array<{ id: string; params: unknown }> = [];
  return {
    created,
    JOBS: {
      create: async (o: { id: string; params: unknown }) => {
        created.push(o);
        return { id: o.id };
      },
    } as NonNullable<JobEnv["JOBS"]>,
  };
}

/** Serves the app on its domain instead of workers.dev (a live domain, workers.dev off). */
async function servedOnDomain(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1").bind(INSTALL_ID),
    env.DB.prepare("UPDATE resources SET live_at = 1 WHERE kind = 'domain'"),
  ]);
}

async function logsOf(jobId: string) {
  return (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ level: string; message: string }>()
  ).results.map((l) => l.message);
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("rollback of a version whose settings use the app's address", () => {
  /**
   * An install updated to 1.1.0 while it was served on workers.dev, and
   * moved to its domain since; the snapshot's 1.0.0 version was uploaded
   * with `deployedWith` as its address.
   */
  async function rollbackTo(
    deployedWith: { url: string; host: string },
    /** Keys (`METHOD /path`) the fake answers once with this status instead of doing the work. */
    failOnce: ReadonlyArray<[string, number]> = [],
  ) {
    const old = await buildArtifactFixture({ ...APP, version: "1.0.0" });
    const current = await buildArtifactFixture({ ...APP, version: "1.1.0" });
    await seedInstall({
      version: "1.1.0",
      currentVersionId: NEW_VERSION,
      manifestJson: new TextDecoder().decode(current.manifestBytes),
      resources: RESOURCES,
    });
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, worker_version_id) VALUES ('upd1', ?1, 'update', 'succeeded', ?2)",
    )
      .bind(INSTALL_ID, NEW_VERSION)
      .run();
    await env.DB.prepare(
      `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at,
         catalog_version, manifest_json, artifact_url, artifact_digest, pin_sha, do_migration_tag,
         target_catalog_version, config_json)
       VALUES ('upd1', ?1, 'upd1', ?2, '{}', 1000, '1.0.0', ?3,
         'https://artifacts.test/cut/old.zip', ?4, 'oldsha', NULL, '1.1.0', '{}')`,
    )
      .bind(INSTALL_ID, OLD_VERSION, new TextDecoder().decode(old.manifestBytes), old.digest)
      .run();
    await servedOnDomain();
    const fake = fakeAccount(null, {
      deployments: [
        { id: "dep-2", versions: [{ version_id: NEW_VERSION, percentage: 100 }] },
        { id: "dep-1", versions: [{ version_id: OLD_VERSION, percentage: 100 }] },
      ],
      domainHealth: { [DOMAIN]: [{ status: 200, body: "ok" }] },
      failOnce: new Map(failOnce),
      versionBindings: {
        [OLD_VERSION]: [
          { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
          { type: "plain_text", name: "PUBLIC_URL", text: deployedWith.url },
          { type: "plain_text", name: "PUBLIC_HOST", text: deployedWith.host },
          { type: "plain_text", name: "DEV_URL", text: WORKERS_DEV },
        ],
      },
    });
    let params: RollbackJobParams | null = null;
    await startRollbackCore(
      {
        db: env.DB,
        createJob: async (_id, p) => {
          params = p;
          return { id: "rb1" };
        },
        newId: () => "rb1",
      },
      { installId: INSTALL_ID, snapshotId: "upd1" },
    );
    if (params === null) throw new Error("no rollback params");
    const jobs = jobsBinding();
    const step = fakeStep();
    let error: unknown = null;
    try {
      await runRollback({
        params,
        step,
        env: { ...jobEnv(), JOBS: jobs.JOBS },
        deps: { fetch: fake.fetch },
      });
    } catch (e) {
      error = e;
    }
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'rb1'").first<{
      status: string;
    }>();
    return { step, error, job, created: jobs.created, logs: await logsOf("rb1") };
  }

  it("deploys the settings again with the address the app has now", async () => {
    const r = await rollbackTo({ url: WORKERS_DEV, host: "cut.appflare-dev.workers.dev" });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const names = r.step.names;
    expect(names.indexOf("finish")).toBeLessThan(
      names.indexOf(`check the address settings of version ${OLD_VERSION}`),
    );
    expect(names.at(-1)).toBe("settings for the app's current address");
    expect(r.created).toHaveLength(1);
    expect(r.created[0]?.params).toMatchObject({
      kind: "reconfigure",
      installId: INSTALL_ID,
      refreshVars: ["appUrl"],
    });
    // The one line after the final one says why the settings change runs.
    expect(r.logs.at(-1)).toContain(
      `This version's settings were filled in with another address ({{appUrl}}) than the app has now (https://${DOMAIN}), so a settings change (job `,
    );
  });

  it("ends its log with the final line, the version's settings read before it", async () => {
    // The read of the version's secrets fails, so its settings are read on their own.
    const r = await rollbackTo({ url: WORKERS_DEV, host: "cut.appflare-dev.workers.dev" }, [
      [`GET /workers/scripts/cut/versions/${OLD_VERSION}`, 500],
    ]);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const names = r.step.names;
    expect(names.indexOf(`read the address settings of version ${OLD_VERSION}`)).toBeLessThan(
      names.indexOf("finish"),
    );
    expect(names.indexOf("finish")).toBeLessThan(
      names.indexOf(`check the address settings of version ${OLD_VERSION}`),
    );
    const final = r.logs.findIndex((m) => m.startsWith("Rolled back from 1.1.0 to 1.0.0"));
    expect(final).toBeGreaterThan(-1);
    // After the final line: only the settings change it starts, never a step's API calls.
    expect(r.logs.slice(final + 1)).toEqual([
      expect.stringContaining(
        `than the app has now (https://${DOMAIN}), so a settings change (job `,
      ),
    ]);
    expect(r.logs.slice(0, final)).toContain("API calls");
    expect(r.created[0]?.params).toMatchObject({ kind: "reconfigure", refreshVars: ["appUrl"] });
  });

  it("writes nothing after its final line when the settings name the app's address", async () => {
    const r = await rollbackTo({ url: `https://${DOMAIN}`, host: DOMAIN }, [
      [`GET /workers/scripts/cut/versions/${OLD_VERSION}`, 500],
    ]);
    expect(r.error).toBeNull();
    expect(r.logs.at(-1)).toMatch(/^Rolled back from 1\.1\.0 to 1\.0\.0/);
    expect(r.created).toEqual([]);
  });

  it("leaves the settings alone when the version already names the app's address", async () => {
    const r = await rollbackTo({ url: `https://${DOMAIN}`, host: DOMAIN });
    expect(r.error).toBeNull();
    expect(r.step.names).toContain(`check the address settings of version ${OLD_VERSION}`);
    expect(r.step.names).not.toContain("settings for the app's current address");
    expect(r.created).toEqual([]);
  });

  it("refreshes for {{appHostname}} alone too", async () => {
    const r = await rollbackTo({ url: `https://${DOMAIN}`, host: "cut.appflare-dev.workers.dev" });
    expect(r.created[0]?.params).toMatchObject({ refreshVars: ["appUrl"] });
  });
});

describe("update while the app's address moves", () => {
  async function update(moveDuringJob: boolean) {
    const fixture = await buildArtifactFixture({ ...APP, version: "1.1.0" });
    const fake = fakeAccount(fixture, {
      deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    });
    await seedInstall({ resources: RESOURCES });
    await env.DB.prepare("UPDATE installs SET config_json = '{}' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    await cacheIndex(fixture);
    let params: UpdateJobParams | null = null;
    await startUpdateCore(
      {
        db: env.DB,
        loadApp: async () => fixture.index,
        loadManifest: async () => fixture.manifest,
        createJob: async (_id, p) => {
          params = p;
          return { id: "job1" };
        },
        newId: () => "job1",
      },
      { installId: INSTALL_ID, confirmNoPreview: true },
    );
    if (params === null) throw new Error("no update params");
    // The domain goes live (and workers.dev off) while the new version is promoted.
    const fetch: FetchLike = async (input, init) => {
      if (
        moveDuringJob &&
        init?.method === "POST" &&
        String(input).endsWith("/workers/scripts/cut/deployments")
      ) {
        await servedOnDomain();
      }
      return fake.fetch(input, init);
    };
    const jobs = jobsBinding();
    const step = fakeStep();
    let error: unknown = null;
    try {
      await runUpdate({
        params,
        step,
        env: { ...jobEnv(), SELF: fakeSelf(jobEnv(), { fetch }), JOBS: jobs.JOBS },
        deps: { fetch, signingKeys: fixture.keys },
      });
    } catch (e) {
      error = e;
    }
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'job1'").first<{
      status: string;
    }>();
    return { fake, step, error, job, created: jobs.created, logs: await logsOf("job1") };
  }

  it("deploys the settings again when a domain took over while the update ran", async () => {
    const r = await update(true);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    // The upload rendered the address the update started with.
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({ type: "plain_text", name: "PUBLIC_URL", text: WORKERS_DEV });
    expect(r.step.names.slice(-2)).toEqual([
      "check the app's address",
      "settings for the app's current address",
    ]);
    expect(r.created[0]?.params).toMatchObject({ kind: "reconfigure", refreshVars: ["appUrl"] });
    expect(r.logs.join("\n")).toContain(
      "The app's address ({{appUrl}}) changed while the update ran, and its settings use it, so a settings change",
    );
  });

  it("starts nothing when the address stayed", async () => {
    const r = await update(false);
    expect(r.error).toBeNull();
    expect(r.step.names.at(-1)).toBe("check the app's address");
    expect(r.created).toEqual([]);
  });
});

describe("staleAddressValues", () => {
  it("names the values a deployed version carries differently, for the vars that use them", async () => {
    const fixture = await buildArtifactFixture({
      catalog: {
        vars: [
          { name: "URL", label: "URL", default: "{{appUrl}}/x", optional: true },
          { name: "WILD", label: "Wild", default: "*.{{wildcardHostname}}", optional: true },
          { name: "PLAIN", label: "Plain", default: "same", optional: true },
        ],
      },
    });
    const base = {
      manifest: fixture.manifest,
      worker: { manifest: fixture.manifest },
      userVars: {},
      workerName: "cut",
      subdomain: "appflare-dev",
      accountId: "acc",
      access: null,
      email: null,
      address: { appUrl: `https://${DOMAIN}`, wildcardHostname: "apps.example.com" },
    };
    const deployed = (url: string, wild: string) => [
      { type: "plain_text", name: "URL", text: url },
      { type: "plain_text", name: "WILD", text: wild },
      // A var that names no address never counts, whatever it holds.
      { type: "plain_text", name: "PLAIN", text: "other" },
    ];
    expect(
      staleAddressValues({
        ...base,
        deployed: deployed(`https://${DOMAIN}/x`, "*.apps.example.com"),
      }),
    ).toEqual([]);
    expect(staleAddressValues({ ...base, deployed: deployed(`${WORKERS_DEV}/x`, "*.") })).toEqual([
      "appUrl",
      "wildcardHostname",
    ]);
    expect(
      staleAddressValues({ ...base, deployed: deployed(`https://${DOMAIN}/x`, "*.") }),
    ).toEqual(["wildcardHostname"]);
  });

  it("names the email domain when a deployed version was filled in with another zone", async () => {
    const fixture = await buildArtifactFixture({
      catalog: { vars: [{ name: "AUTH_FROM", label: "From", default: "", optional: true }] },
    });
    const base = {
      manifest: fixture.manifest,
      worker: { manifest: fixture.manifest },
      userVars: { AUTH_FROM: "accounts@{{emailDomain}}" },
      workerName: "cut",
      subdomain: "appflare-dev",
      accountId: "acc",
      access: null,
      email: { zoneName: "b.com", zoneId: "zone-b" },
      address: { appUrl: `https://${DOMAIN}`, wildcardHostname: null },
    };
    const deployed = (from: string) => [{ type: "plain_text", name: "AUTH_FROM", text: from }];
    expect(staleAddressValues({ ...base, deployed: deployed("accounts@b.com") })).toEqual([]);
    expect(staleAddressValues({ ...base, deployed: deployed("accounts@a.com") })).toEqual([
      "emailZone",
    ]);
    // Settings that do not use it never count.
    expect(
      staleAddressValues({ ...base, userVars: {}, deployed: deployed("accounts@a.com") }),
    ).toEqual([]);
  });
});
