import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import type { CatalogManifest, SandboxInfo } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { planAppUpdates } from "../auto-update/auto-update";
import { readCandidateRows, updateCandidates } from "../auto-update/cron.server";
import { OFFICIAL_TRUST } from "../catalog/catalogs.server";
import { lookupOf, OFFICIAL_SOURCE } from "../catalog/merged.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { RemoteRefs } from "../installs/git-refs";
import {
  checkSourceChangesCore,
  discardSourceBuildCore,
  installSourceBuildCore,
  type ReadRefs,
  type SourceBuildDeps,
  startSourceBuildCore,
  updateFromSourceBuildCore,
} from "../installs/source-builds.server";
import { sandboxInfo } from "../sandbox/binding";
import { PINNED_SANDBOX_VERSION, sandboxReleaseProblem } from "../sandbox/release";
import { jobProperties } from "../telemetry/events";
import { type ArtifactFixture, baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, fakeAccount, SUBDOMAIN, TOKEN } from "../test/fake-account";
import { type FakeSandbox, type FakeSandboxOptions, fakeSandbox } from "../test/fake-sandbox";
import { fakeSandboxAccount, sandboxRelease } from "../test/fake-sandbox-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { type InstallJobParams, runInstall } from "./install";
import type { JobEnv } from "./run-job";
import { runSourceBuild, type SourceBuildJobParams } from "./source-build";
import { runUpdate, type UpdateJobParams } from "./update";

/**
 * Builds from a repository, end to end: the build for review (a
 * `source_build` job against a fake `SANDBOX` binding and a fake git host),
 * then the install and the rebuild-and-update from it through the ordinary
 * install and update jobs (the stateful fake account), and the rules for
 * such installs: recorded as not from the catalog, never updated by the
 * cron, and nothing of the repository in usage data.
 */

const NOW = 1_790_000_000_000;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEWER = "fedcba9876543210fedcba9876543210fedcba98";
const VERSION = "0.0.0-20260920.0123456";
const NEWER_VERSION = "0.0.0-20260921.fedcba9";

/** What the sandbox Worker builds from the repository at `commit`: unsigned, worked out, not the catalog's. */
function repositoryBuild(commit: string, version: string): Promise<ArtifactFixture> {
  const catalog = baseCatalog();
  return buildArtifactFixture({
    keyId: "unsigned",
    version,
    catalog: {
      name: "cut",
      summary: "Self-hosted link shortener.",
      categories: [],
      maintainers: [],
      source: { ref: "main", sha: commit },
      install: { ...catalog.install, tier: "sandbox", version },
      plan: "paid",
      requires: ["containers"],
      secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password", generate: false }],
      vars: [],
      postInstall: [],
    },
    tweak: (m) => {
      m.source = { repo: "MendyLanda/cut", sha: commit, ref: "main" };
    },
  });
}

/** A fake git host: `main` at `commit`. */
function refsAt(commit: string): RemoteRefs {
  return {
    refs: new Map([
      ["HEAD", commit],
      ["refs/heads/main", commit],
      ["refs/tags/v1.0.0", NEWER],
    ]),
    head: "refs/heads/main",
  };
}

function accountFetch(account: ReturnType<typeof fakeAccount>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    if (key === "GET /tokens/verify") {
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { status: "active" },
      });
    }
    if (/^PUT \/workers\/scripts\/[^/]+\/secrets$/.test(key)) {
      return Response.json({ success: true, errors: [], messages: [], result: {} });
    }
    return account.fetch(input, init);
  };
}

async function paidAccount(): Promise<void> {
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.accountSubdomain]: SUBDOMAIN,
    [SETTING.accountPlan]: "paid",
  });
}

/** The catalog app a build from source starts from, when a test sets one. */
let catalogApp: Awaited<ReturnType<SourceBuildDeps["loadCatalogApp"]>> | null = null;

function buildDeps(
  sandbox: FakeSandbox | undefined,
  remote: ReadRefs,
  capture: (p: SourceBuildJobParams) => void,
  ids: () => string,
): SourceBuildDeps {
  return {
    db: env.DB,
    createJob: async (id, p) => {
      capture(p);
      return { id };
    },
    async sandbox() {
      if (sandbox === undefined) return { connected: false, info: null };
      const info: SandboxInfo = await sandboxInfo(sandbox);
      return { connected: true, info };
    },
    listRefs: async () => remote,
    loadCatalogApp: async () => {
      if (catalogApp === null) throw new Error("no catalog app in this test");
      return catalogApp;
    },
    newId: ids,
  };
}

/** Starts a build for review and runs its job; returns the build's id. */
async function build(opts: {
  fixture: ArtifactFixture;
  request?: Parameters<typeof startSourceBuildCore>[1];
  remote?: ReadRefs;
  sandbox?: FakeSandboxOptions;
  ids?: () => string;
}) {
  const sandbox = fakeSandbox(opts.fixture, opts.sandbox ?? {});
  let params: SourceBuildJobParams | null = null;
  let n = 0;
  const { jobId } = await startSourceBuildCore(
    buildDeps(
      sandbox,
      opts.remote ?? refsAt(COMMIT),
      (p) => {
        params = p;
      },
      opts.ids ?? (() => `b${++n}`),
    ),
    opts.request ?? {
      kind: "repository",
      repository: "https://github.com/MendyLanda/cut",
      costConfirmed: true,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  const account = fakeAccount(opts.fixture);
  const fetch = accountFetch(account);
  const baseEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, SANDBOX: sandbox };
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runSourceBuild({
      params,
      step,
      env: { ...baseEnv, SELF: fakeSelf(baseEnv, { fetch, now: () => NOW }) },
      deps: { fetch, now: () => NOW },
    });
  } catch (e) {
    error = e;
  }
  const row = await env.DB.prepare("SELECT * FROM source_builds WHERE id = ?1")
    .bind(jobId)
    .first<Record<string, unknown>>();
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<Record<string, unknown>>();
  return { jobId, params: params as SourceBuildJobParams, sandbox, step, error, row, job };
}

beforeEach(async () => {
  catalogApp = null;
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await paidAccount();
});

describe("building a repository for review", () => {
  it("resolves the branch first, builds that commit, and records the verified build", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const r = await build({ fixture });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ kind: "source_build", status: "succeeded", install_id: null });
    expect(r.params).toMatchObject({
      repo: "MendyLanda/cut",
      ref: "main",
      commit: COMMIT,
      purpose: "install",
      origin: "repository",
      buildCommand: { mode: "detect" },
    });
    expect(r.sandbox.requests[0]).toMatchObject({
      protocol: 1,
      runId: `src-${r.jobId}`,
      repo: "MendyLanda/cut",
      ref: "main",
      commit: COMMIT,
    });
    expect(r.step.names).toEqual(
      expect.arrayContaining([
        "check sandbox Worker",
        "wait for the sandbox Worker to settle",
        "build in sandbox",
        "verify built manifest",
      ]),
    );
    expect(r.row).toMatchObject({
      status: "built",
      purpose: "install",
      origin: "repository",
      repo: "MendyLanda/cut",
      commit_sha: COMMIT,
      ref: "main",
      version: VERSION,
      digest: fixture.digest,
    });
    // Nothing was deployed, and no install exists yet.
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{
      n: number;
    }>();
    expect(installs?.n).toBe(0);
  });

  it("clones a private repository with the GitHub access token that read it, by secret name", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const token = { id: "01J8TOKEN00000000000000000", label: "Acme private" };
    const r = await build({ fixture, remote: { ...refsAt(COMMIT), token } });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded" });
    expect(r.params.githubToken).toEqual(token);
    expect(r.sandbox.requests[0]).toMatchObject({
      commit: COMMIT,
      tokenSecret: `GITHUB_TOKEN_${token.id}`,
    });
    const logs = await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1")
      .bind(r.jobId)
      .all<{ message: string }>();
    expect(logs.results.some((l) => l.message.includes('GitHub access token "Acme private"'))).toBe(
      true,
    );
  });

  it("says to try again in a minute when a token added just now is not on the sandbox Worker yet", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const token = { id: "01J8TOKEN00000000000000000", label: "Acme private" };
    await env.DB.prepare(
      "INSERT INTO github_tokens (id, label, repositories, created_at) VALUES (?1, ?2, 'acme/*', ?3)",
    )
      .bind(token.id, token.label, NOW - 60_000)
      .run();
    const r = await build({
      fixture,
      remote: { ...refsAt(COMMIT), token },
      sandbox: {
        repositoryOutcome: () => ({
          ok: false,
          protocol: 1,
          sandboxVersion: "0.4.0",
          minutes: 0,
          logKey: null,
          log: "",
          stage: "checkout",
          message: `the sandbox Worker does not hold the GitHub access token GITHUB_TOKEN_${token.id}: if it was just added, try again in a minute`,
          retryable: false,
          exitCode: null,
        }),
      },
    });
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String(r.job?.error)).toContain(
      'the GitHub access token "Acme private" was just added, and the sandbox Worker does not have it yet; try again in a minute',
    );
  });

  it("refuses a private build on a sandbox Worker that cannot use GitHub access tokens", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const r = await build({
      fixture,
      remote: { ...refsAt(COMMIT), token: { id: "01J8TOKEN00000000000000000", label: "Acme" } },
      sandbox: {
        info: {
          protocol: 1,
          sandboxVersion: "0.1.3",
          image: "docker.io/mendylanda/appflare-sandbox:0.1.3",
          features: ["self-deploying", "repository-builds"],
        },
      },
    });
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String(r.job?.error)).toContain("cannot clone with a GitHub access token");
    expect(r.sandbox.requests).toEqual([]);
  });

  it("refuses a manifest that does not describe the commit it built", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const r = await build({
      fixture,
      sandbox: { manifestBytes: (await repositoryBuild(NEWER, VERSION)).manifestBytes },
    });
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String(r.job?.error)).toMatch(/^verify built manifest: .*digest/);
    expect(r.row).toMatchObject({ status: "failed" });
  });

  it("refuses to start on a sandbox Worker that cannot build from a repository", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    await expect(
      build({
        fixture,
        sandbox: {
          info: {
            protocol: 1,
            sandboxVersion: "0.1.2",
            image: "docker.io/mendylanda/appflare-sandbox:0.1.2",
            features: ["self-deploying"],
          },
        },
      }),
    ).rejects.toThrow(/sandbox Worker 0\.1\.2 cannot build from a repository yet/);
  });

  it("refuses to start on Workers Free, without sandbox builds, or without the cost confirmation", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    await writeSettings(createDb(env.DB), { [SETTING.accountPlan]: "free" });
    await expect(build({ fixture })).rejects.toThrow(/needs the Workers Paid plan/);
    await paidAccount();
    await expect(
      startSourceBuildCore(
        buildDeps(
          undefined,
          refsAt(COMMIT),
          () => {},
          () => "x",
        ),
        {
          kind: "repository",
          repository: "MendyLanda/cut",
          costConfirmed: true,
        },
      ),
    ).rejects.toThrow(/Sandbox builds are off/);
    await expect(
      build({
        fixture,
        request: { kind: "repository", repository: "MendyLanda/cut", costConfirmed: false },
      }),
    ).rejects.toThrow(/Confirm its cost/);
  });

  it("turns sandbox builds on first when they are off, then builds once they are on", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const world = fakeSandboxAccount(await sandboxRelease(PINNED_SANDBOX_VERSION));
    const created: Array<{ id: string; params: unknown }> = [];
    let n = 0;
    const deps: SourceBuildDeps = {
      ...buildDeps(
        undefined,
        refsAt(COMMIT),
        () => {},
        () => `s${++n}`,
      ),
      createJob: async (id, params) => {
        created.push({ id, params });
        return { id };
      },
      autoEnable: {
        client: async () => createClient({ accountId: ACC, token: TOKEN, fetch: world.fetch }),
        releaseProblem: (version) =>
          sandboxReleaseProblem(world.fetch, {}, version, { viaApi: false }),
        createJob: async (id, params) => {
          created.push({ id, params });
          return { id };
        },
        currentVersion: "0.5.0",
      },
    };
    const request = {
      kind: "repository",
      repository: "MendyLanda/cut",
      costConfirmed: true,
    } as const;
    const { jobId } = await startSourceBuildCore(deps, request);
    expect(jobId).toBe("s2");
    // The enable job (s3; s1 is the install id the build is for) first, then the build.
    expect(created.map((c) => c.id)).toEqual(["s3", "s2"]);
    const params = created[1]?.params as SourceBuildJobParams;
    expect(params.sandboxEnableJob).toBe("s3");
    const enable = await env.DB.prepare("SELECT * FROM jobs WHERE id = 's3'").first<
      Record<string, unknown>
    >();
    expect(enable).toMatchObject({ kind: "sandbox_enable", status: "queued" });

    // A second build while that enable job runs waits for the same one.
    const second = await startSourceBuildCore(deps, request);
    expect(created.at(-1)?.params).toMatchObject({ sandboxEnableJob: "s3" });
    expect(created.filter((c) => c.id === "s3")).toHaveLength(1);
    expect(second.jobId).not.toBe("s3");

    // The enable job finishes; the build (now with its binding) waits, then builds.
    await env.DB.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = 's3'").run();
    const sandbox = fakeSandbox(fixture);
    const account = fakeAccount(fixture);
    const fetch = accountFetch(account);
    const baseEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, SANDBOX: sandbox };
    const step = fakeStep();
    await runSourceBuild({
      params,
      step,
      env: { ...baseEnv, SELF: fakeSelf(baseEnv, { fetch, now: () => NOW }) },
      deps: { fetch, now: () => NOW },
    });
    expect(step.names.slice(0, 4)).toEqual([
      "start",
      "wait for sandbox builds (1)",
      "check sandbox Worker",
      "wait for the sandbox Worker to settle",
    ]);
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 's2'").first();
    expect(job).toMatchObject({ status: "succeeded" });

    // Usage data counts the enable as one Appflare started by itself.
    const props = jobProperties(
      {
        id: "s3",
        kind: "sandbox_enable",
        status: "succeeded",
        inputJson: enable?.input_json as string,
        error: null,
        startedAt: null,
        finishedAt: null,
        appSlug: null,
        installVersion: null,
        buildKind: null,
        snapshotTargetVersion: null,
        startedBy: "admin",
      },
      true,
      null,
    );
    expect(props).toMatchObject({ kind: "sandbox_enable", trigger: "auto" });
  });

  it("refuses to turn sandbox builds on when the account lacks something, naming it", async () => {
    const world = fakeSandboxAccount(await sandboxRelease(PINNED_SANDBOX_VERSION), {
      r2Enabled: false,
    });
    const deps: SourceBuildDeps = {
      ...buildDeps(
        undefined,
        refsAt(COMMIT),
        () => {},
        () => "r",
      ),
      autoEnable: {
        client: async () => createClient({ accountId: ACC, token: TOKEN, fetch: world.fetch }),
        releaseProblem: async () => null,
        createJob: async () => {
          throw new Error("not reached");
        },
        currentVersion: "0.5.0",
      },
    };
    await expect(
      startSourceBuildCore(deps, {
        kind: "repository",
        repository: "MendyLanda/cut",
        costConfirmed: true,
      }),
    ).rejects.toThrow(
      /Sandbox builds are off, and Appflare cannot turn them on: R2 is not enabled on this account.*\/settings\/account#checklist-sandbox/,
    );
    expect(await env.DB.prepare("SELECT id FROM jobs").all()).toMatchObject({ results: [] });
  });

  it("refuses a branch the repository does not have before any container starts", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    await expect(
      build({
        fixture,
        request: {
          kind: "repository",
          repository: "https://github.com/MendyLanda/cut/tree/nope",
          costConfirmed: true,
        },
      }),
    ).rejects.toThrow("MendyLanda/cut has no branch or tag named nope.");
  });

  it("throws a build away and deletes its objects", async () => {
    const fixture = await repositoryBuild(COMMIT, VERSION);
    const r = await build({ fixture });
    const cleanups: Array<{ installId: string; keep: string[] }> = [];
    await discardSourceBuildCore(
      {
        db: env.DB,
        cleanup: async (installId, keep) => {
          cleanups.push({ installId, keep });
        },
      },
      r.jobId,
    );
    expect(cleanups).toEqual([{ installId: r.params.installId, keep: [] }]);
    const row = await env.DB.prepare("SELECT status FROM source_builds WHERE id = ?1")
      .bind(r.jobId)
      .first<{ status: string }>();
    expect(row?.status).toBe("discarded");
    await expect(
      installSourceBuildCore(
        { db: env.DB, createJob: async (id) => ({ id }) },
        {
          buildId: r.jobId,
          workerName: "cut",
          secrets: { ADMIN_PASSWORD: "pw" },
          vars: {},
          paidConfirmed: true,
          requirementsConfirmed: true,
        },
      ),
    ).rejects.toThrow(/thrown away/);
  });
});

/** Builds the repository, then installs the build through the install job. */
async function installFromRepository() {
  const fixture = await repositoryBuild(COMMIT, VERSION);
  const built = await build({ fixture });
  let params: InstallJobParams | null = null;
  const started = await installSourceBuildCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => "install-job",
    },
    {
      buildId: built.jobId,
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: "pw" },
      vars: {},
      paidConfirmed: false,
      requirementsConfirmed: true,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  const account = fakeAccount(fixture);
  const fetch = accountFetch(account);
  const baseEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, SANDBOX: built.sandbox };
  let error: unknown = null;
  try {
    await runInstall({
      params,
      step: fakeStep(),
      env: { ...baseEnv, SELF: fakeSelf(baseEnv, { fetch, now: () => NOW }) },
      deps: { fetch, now: () => NOW },
    });
  } catch (e) {
    error = e;
  }
  const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(started.installId)
    .first<Record<string, unknown>>();
  return { built, started, params: params as InstallJobParams, error, install, account };
}

describe("installing a reviewed build", () => {
  it("installs it as it was built and records it as not from the catalog", async () => {
    const r = await installFromRepository();
    expect(r.error).toBeNull();
    expect(r.started.installId).toBe(r.built.params.installId);
    expect(r.params.prebuilt).toMatchObject({
      buildId: r.built.jobId,
      origin: "repository",
      commit: COMMIT,
      version: VERSION,
    });
    // Nothing is built again: the install reads the reviewed build.
    expect(r.built.sandbox.requests).toHaveLength(1);
    expect(r.install).toMatchObject({
      status: "installed",
      app_slug: "repository:MendyLanda/cut",
      origin: "repository",
      source_url: "https://github.com/MendyLanda/cut",
      source_ref: "main",
      pin_sha: COMMIT,
      build_kind: "sandbox",
      catalog_version: VERSION,
      artifact_url: `https://sandbox/builds/${r.started.installId}/${VERSION}/cut-${VERSION}.zip`,
    });
    const row = await env.DB.prepare("SELECT status FROM source_builds WHERE id = ?1")
      .bind(r.built.jobId)
      .first<{ status: string }>();
    expect(row?.status).toBe("used");
  });

  it("installs a build once", async () => {
    const r = await installFromRepository();
    await expect(
      installSourceBuildCore(
        { db: env.DB, createJob: async (id) => ({ id }) },
        {
          buildId: r.built.jobId,
          workerName: "cut-2",
          secrets: { ADMIN_PASSWORD: "pw" },
          vars: {},
          paidConfirmed: true,
          requirementsConfirmed: true,
        },
      ),
    ).rejects.toThrow(/already installed/);
  });

  it("is never updated by the cron, whatever the catalog lists under the same name", async () => {
    const r = await installFromRepository();
    await env.DB.prepare("UPDATE installs SET auto_update = 'on' WHERE id = ?1")
      .bind(r.started.installId)
      .run();
    const catalogCut = (await buildArtifactFixture({ version: "9.9.9" })).index;
    const rows = await readCandidateRows(env.DB);
    const candidates = await updateCandidates(
      env.DB,
      rows,
      new Map([
        ...lookupOf([catalogCut]),
        [
          "repository:cut",
          {
            key: "repository:cut",
            app: catalogCut,
            source: OFFICIAL_SOURCE,
            trust: OFFICIAL_TRUST,
          },
        ],
      ]),
    );
    expect(planAppUpdates(candidates, true)).toEqual([
      { installId: r.started.installId, action: "skip", reason: "not-in-catalog" },
    ]);
  });

  it("sends nothing of the repository in usage data: the kind and the outcome only", async () => {
    const r = await installFromRepository();
    const jobs = (
      await env.DB.prepare(
        "SELECT j.*, i.app_slug, i.catalog_version, i.build_kind FROM jobs j LEFT JOIN installs i ON i.id = j.install_id",
      ).all<Record<string, unknown>>()
    ).results;
    expect(jobs.map((j) => j.kind).sort()).toEqual(["install", "source_build"]);
    for (const j of jobs) {
      const props = jobProperties(
        {
          id: String(j.id),
          kind: String(j.kind),
          status: String(j.status),
          inputJson: j.input_json as string | null,
          error: null,
          startedAt: null,
          finishedAt: null,
          appSlug: (j.app_slug as string | null) ?? null,
          installVersion: (j.catalog_version as string | null) ?? null,
          buildKind: (j.build_kind as string | null) ?? null,
          snapshotTargetVersion: null,
          startedBy: "admin",
        },
        true,
        // The index is not known: slugs are sent as they are, except a repository's.
        null,
      );
      expect(props).toMatchObject({ slug: "custom", origin: "repository", catalog_version: null });
      expect(JSON.stringify(props)).not.toMatch(/github|MendyLanda|cut/i);
    }
    expect(r.install?.origin).toBe("repository");
  });
});

describe("building a catalog app from source", () => {
  /** The catalog's Cut, and a build of it at `commit` that keeps (or changes) its manifest. */
  async function fromSource(
    change?: (catalog: CatalogManifest) => CatalogManifest,
    options: {
      catalog?: (catalog: CatalogManifest) => CatalogManifest;
      sandbox?: FakeSandboxOptions;
    } = {},
  ) {
    const released = await buildArtifactFixture();
    const listed = options.catalog?.(released.manifest.catalog) ?? released.manifest.catalog;
    catalogApp = { app: released.index, catalog: listed };
    const kept = released.manifest.catalog;
    const built = change === undefined ? kept : change(kept);
    const fixture = await buildArtifactFixture({
      keyId: "unsigned",
      version: VERSION,
      catalog: {
        ...built,
        source: { ref: "main", sha: COMMIT },
        install: { ...built.install, tier: "sandbox", version: VERSION },
      },
      tweak: (m) => {
        m.source = { repo: "MendyLanda/cut", sha: COMMIT, ref: "main" };
      },
    });
    return build({
      fixture,
      request: { kind: "source", slug: "cut", ref: "main", costConfirmed: true },
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    });
  }

  it("refuses an app that lists install directories on a sandbox Worker that predates them", async () => {
    const r = await fromSource(undefined, {
      catalog: (c) => ({ ...c, install: { ...c.install, installDirs: [{ path: "." }] } }),
      sandbox: {
        info: {
          protocol: 1,
          sandboxVersion: "0.1.4",
          image: "docker.io/mendylanda/appflare-sandbox:0.1.4",
          features: ["self-deploying", "repository-builds", "github-tokens"],
        },
      },
    });
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String(r.job?.error)).toContain(
      "the sandbox Worker 0.1.4 cannot install the directories this app lists (install.installDirs)",
    );
    expect(r.sandbox.requests).toEqual([]);
  });

  it("refuses an app that patches its wrangler config on a sandbox Worker that predates patches", async () => {
    const r = await fromSource(undefined, {
      catalog: (c) => ({ ...c, install: { ...c.install, configPatch: { build: null } } }),
      sandbox: {
        info: {
          protocol: 1,
          sandboxVersion: "0.1.4",
          image: "docker.io/mendylanda/appflare-sandbox:0.1.4",
          features: ["self-deploying", "repository-builds", "github-tokens", "install-dirs"],
        },
      },
    });
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String(r.job?.error)).toContain(
      "the sandbox Worker 0.1.4 cannot apply this app's wrangler config patch (install.configPatch)",
    );
    expect(r.sandbox.requests).toEqual([]);
  });

  it("builds an app that patches its wrangler config on a sandbox Worker that applies patches", async () => {
    const configPatch = { build: null };
    const r = await fromSource(undefined, {
      catalog: (c) => ({ ...c, install: { ...c.install, configPatch } }),
    });
    expect(r.error).toBeNull();
    expect(r.sandbox.requests[0]).toMatchObject({ baseline: { install: { configPatch } } });
  });

  it("builds the catalog's repository with the catalog manifest as the baseline", async () => {
    const r = await fromSource();
    expect(r.error).toBeNull();
    expect(r.params).toMatchObject({
      origin: "source",
      repo: "MendyLanda/cut",
      commit: COMMIT,
      baseline: { slug: "cut", name: "Cut" },
    });
    expect(r.sandbox.requests[0]).toMatchObject({ baseline: { slug: "cut" } });
    expect(r.row).toMatchObject({ status: "built", origin: "source", app_slug: "cut" });
  });

  it("refuses a build whose manifest asks for more than the catalog's does", async () => {
    const r = await fromSource((c) => ({
      ...c,
      secrets: [...c.secrets, { name: "EXTRA", label: "Extra", generate: false }],
    }));
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String(r.job?.error)).toContain("its catalog manifest is not the catalog's");
  });
});

describe("checking for changes and rebuilding", () => {
  it("finds the newest commit of the branch the install follows", async () => {
    const r = await installFromRepository();
    const deps = { db: env.DB, listRefs: async () => refsAt(NEWER) };
    await expect(checkSourceChangesCore(deps, r.started.installId)).resolves.toEqual({
      repo: "MendyLanda/cut",
      ref: "main",
      pinned: false,
      installed: COMMIT,
      latest: NEWER,
      changed: true,
    });
    await expect(
      checkSourceChangesCore(
        { ...deps, listRefs: async () => refsAt(COMMIT) },
        r.started.installId,
      ),
    ).resolves.toMatchObject({ changed: false });
  });

  it("rebuilds the newest commit for review, then updates through the update job", async () => {
    const installed = await installFromRepository();
    const installId = installed.started.installId;
    const next = await repositoryBuild(NEWER, NEWER_VERSION);
    const rebuilt = await build({
      fixture: next,
      remote: refsAt(NEWER),
      request: { kind: "rebuild", installId, costConfirmed: true },
      ids: () => "rebuild-1",
    });
    expect(rebuilt.error).toBeNull();
    expect(rebuilt.params).toMatchObject({
      installId,
      purpose: "update",
      origin: "repository",
      ref: "main",
      commit: NEWER,
      // A rebuild never replaces the objects of the version that runs.
      avoidVersions: [VERSION],
    });
    expect(rebuilt.job).toMatchObject({ install_id: installId, status: "succeeded" });

    let params: UpdateJobParams | null = null;
    const started = await updateFromSourceBuildCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        newId: () => "update-job",
      },
      { buildId: rebuilt.jobId },
    );
    expect(started.jobId).toBe("update-job");
    if (params === null) throw new Error("no Workflow params");
    const serving = installed.account.state.deployments[0]?.versions[0]?.version_id;
    expect(serving).toBeDefined();
    const account = fakeAccount(next, {
      deployments: [{ id: "dep-0", versions: [{ version_id: serving ?? "", percentage: 100 }] }],
      previews: [{ status: 200, body: "ok" }],
    });
    const fetch = accountFetch(account);
    const baseEnv: JobEnv = {
      DB: env.DB,
      KV: env.KV,
      CF_API_TOKEN: TOKEN,
      SANDBOX: rebuilt.sandbox,
    };
    await runUpdate({
      params,
      step: fakeStep(),
      env: { ...baseEnv, SELF: fakeSelf(baseEnv, { fetch, now: () => NOW }) },
      deps: { fetch, now: () => NOW },
    });
    const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
      .bind(installId)
      .first<Record<string, unknown>>();
    expect(install).toMatchObject({
      status: "installed",
      origin: "repository",
      source_ref: "main",
      pin_sha: NEWER,
      catalog_version: NEWER_VERSION,
    });
    const snapshot = await env.DB.prepare(
      "SELECT * FROM snapshots WHERE job_id = 'update-job'",
    ).first<Record<string, unknown>>();
    expect(snapshot).toMatchObject({
      origin: "repository",
      source_ref: "main",
      pin_sha: COMMIT,
      catalog_version: VERSION,
    });
    // The update kept the new build and the one a rollback returns to.
    expect(rebuilt.sandbox.cleanups.at(-1)).toEqual({
      installId,
      keepVersions: [NEWER_VERSION, VERSION],
    });
  });

  it("refuses a rebuild of an app that comes from the catalog", async () => {
    const r = await installFromRepository();
    await env.DB.prepare("UPDATE installs SET origin = 'catalog' WHERE id = ?1")
      .bind(r.started.installId)
      .run();
    await expect(
      build({
        fixture: await repositoryBuild(NEWER, NEWER_VERSION),
        request: { kind: "rebuild", installId: r.started.installId, costConfirmed: true },
      }),
    ).rejects.toThrow(/updated from the catalog/);
  });
});
