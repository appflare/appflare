import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readInstallProtection } from "../access/protect.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startAccessChangeCore } from "../installs/reconfigure.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import { ACC, fakeAccount, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { recordFixtureRevision } from "../test/recorded-revision";
import { INSTALL_ID, OLD_VERSION, seedInstall } from "../test/seed-install";
import { isAccessChangeJob } from "./reconcile.server";
import { accessFailureNote, type ReconfigureJobParams, runReconfigure } from "./reconfigure";
import type { JobEnv } from "./run-job";

/**
 * Turning Cloudflare Access protection of an installed app on and off: the
 * settings change job with `access`, started the way the app page will
 * start it. Protection on comes before the settings that use the Access
 * values are deployed again with them; protection off comes after they are
 * deployed again empty. Runs against the fake Cloudflare account, with the
 * account's Access objects (and its script tags) answered by the Access fake.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";

const USES_ACCESS: ArtifactFixtureOptions = {
  bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
  catalog: {
    vars: [
      { name: "TITLE", label: "Title", default: "Cut" },
      { name: "POLICY_AUD", label: "Audience", default: "{{accessAud}}", optional: true },
      { name: "TEAM", label: "Team", default: "{{accessTeamDomain}}", optional: true },
    ],
    requires: ["access"],
  },
};

const PLAIN: ArtifactFixtureOptions = {
  bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
  catalog: { vars: [{ name: "TITLE", label: "Title", default: "Cut" }] },
};

interface World {
  fixture: ArtifactFixture;
  account: ReturnType<typeof fakeAccount>;
  access: ReturnType<typeof fakeAccessAccount>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

async function world(app: ArtifactFixtureOptions): Promise<World> {
  const fixture = await buildArtifactFixture(app);
  const account = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    uploadedAssets: new Set(fixture.manifest.assets.files.map((f) => f.hash)),
  });
  const access = fakeAccessAccount();
  access.scripts.push({ id: "cut", tag: "tag-cut" });
  const accessPrefix = `/client/v4/accounts/${ACC}/access/`;
  const fetch = async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const scripts =
      request.method === "GET" && path === `/client/v4/accounts/${ACC}/workers/scripts`;
    if (path.startsWith(accessPrefix) || scripts) {
      const text = request.body === null ? undefined : await request.text();
      return access.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(text === undefined || text === "" ? {} : { body: text }),
      });
    }
    return account.fetch(input, init);
  };
  await seedInstall({
    manifestJson: new TextDecoder().decode(fixture.manifestBytes),
    resources: [
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
      { kind: "worker", name: "cut", cfId: "cut" },
      { kind: "subdomain", name: "cut.appflare-dev.workers.dev" },
    ],
  });
  await env.DB.prepare("UPDATE installs SET artifact_url = ?2, artifact_digest = ?3 WHERE id = ?1")
    .bind(INSTALL_ID, ZIP_URL, fixture.digest)
    .run();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1, 'admin')",
  ).run();
  return { fixture, account, access, fetch };
}

let jobs = 0;

async function change(w: World, access: "on" | "off") {
  let params: ReconfigureJobParams | null = null;
  const jobId = `job${++jobs}`;
  await startAccessChangeCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => jobId,
    },
    { installId: INSTALL_ID, access },
  );
  if (params === null) throw new Error("no Workflow params");
  const jobEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, BETTER_AUTH_SECRET: AUTH };
  const step = fakeStep();
  const self = fakeSelf(jobEnv, { fetch: w.fetch });
  let error: unknown = null;
  try {
    await runReconfigure({
      params,
      step,
      env: { ...jobEnv, SELF: self },
      deps: { fetch: w.fetch, signingKeys: w.fixture.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
  const status = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ status: string }>();
  const at = (name: string) => step.names.indexOf(name);
  return { params: params as ReconfigureJobParams, error, job, step, at, self, status };
}

/** The vars of the newest version uploaded. */
function uploadedVars(w: World): Record<string, string | undefined> {
  const bindings = (w.account.state.versions.at(-1)?.metadata.bindings ?? []) as Array<{
    type: string;
    name: string;
    text?: string;
  }>;
  return Object.fromEntries(
    bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]),
  );
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("turning protection on", () => {
  it("protects the app first, then deploys the settings that use the Access values with them", async () => {
    const w = await world(USES_ACCESS);
    const r = await change(w, "on");
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.params).toMatchObject({ access: "on", refreshVars: ["access"] });
    expect(JSON.parse(r.job?.input_json ?? "{}")).toMatchObject({
      access: "on",
      refreshVars: ["access"],
    });
    expect(r.at("protect with Cloudflare Access")).toBeGreaterThan(r.at("plan settings change"));
    expect(r.at("protect with Cloudflare Access")).toBeLessThan(r.at("upload Worker version"));
    expect(r.at("promote version")).toBeLessThan(r.at("health check 1"));
    const protection = await readInstallProtection(env.DB, INSTALL_ID);
    expect(protection?.aud).toMatch(/^aud-/);
    expect(uploadedVars(w)).toMatchObject({
      POLICY_AUD: protection?.aud,
      TEAM: "appflare-test.cloudflareaccess.com",
    });
    const [app] = [...w.access.apps.values()];
    expect(app?.destinations).toEqual([{ type: "worker", worker_id: "tag-cut" }]);
    expect(r.status?.status).toBe("installed");
  });

  it("deploys nothing when no setting uses the Access values, and still checks the app", async () => {
    const w = await world(PLAIN);
    const r = await change(w, "on");
    expect(r.job?.status).toBe("succeeded");
    expect(r.params.refreshVars).toBeUndefined();
    expect(r.step.names).toContain("protect with Cloudflare Access");
    expect(r.step.names).not.toContain("upload Worker version");
    expect(r.step.names).toContain("health check 1");
    expect(await readInstallProtection(env.DB, INSTALL_ID)).not.toBeNull();
  });

  it("covers the app's external domains too", async () => {
    const w = await world(PLAIN);
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:custom_hostname:x', ?1, 'custom_hostname', NULL, 'go.customer.net', NULL, 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await change(w, "on");
    expect(r.job?.status).toBe("succeeded");
    expect([...w.access.apps.values()][0]?.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut" },
      { type: "public", uri: "go.customer.net" },
    ]);
  });

  it("refuses an account that cannot protect apps, before anything changes", async () => {
    const w = await world(PLAIN);
    await expect(
      startAccessChangeCore(
        {
          db: env.DB,
          createJob: async (id) => ({ id }),
          accessPreflight: async () => ({
            message: "This Cloudflare account has no Zero Trust organization yet.",
            unchecked: false,
          }),
        },
        { installId: INSTALL_ID, access: "on" },
      ),
    ).rejects.toThrow("no Zero Trust organization");
    expect(w.access.calls).toEqual([]);
  });
});

describe("turning protection off", () => {
  it("deploys the settings with the Access values empty first, then removes the protection", async () => {
    const w = await world(USES_ACCESS);
    await change(w, "on");
    const r = await change(w, "off");
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.at("promote version")).toBeLessThan(r.at("remove Cloudflare Access protection"));
    expect(uploadedVars(w)).toMatchObject({ POLICY_AUD: "", TEAM: "" });
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toBeNull();
    expect(w.access.apps.size).toBe(0);
    expect(w.access.tokens.size).toBe(0);
    expect(r.at("remove Cloudflare Access protection")).toBeLessThan(r.at("health check 1"));
  });

  it("is refused for an app that is not protected, and for one whose entry requires protection", async () => {
    const w = await world(PLAIN);
    await expect(change(w, "off")).rejects.toThrow("there is nothing to turn off");
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const required = await world({
      ...PLAIN,
      catalog: { ...PLAIN.catalog, access: { mode: "required" }, requires: ["access"] },
    });
    await change(required, "on");
    await expect(change(required, "off")).rejects.toThrow("cannot be turned off");
    expect(await readInstallProtection(env.DB, INSTALL_ID)).not.toBeNull();
  });

  it("is refused for an app deployed by its own installer", async () => {
    await world(PLAIN);
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    await expect(
      startAccessChangeCore(
        { db: env.DB, createJob: async (id) => ({ id }) },
        { installId: INSTALL_ID, access: "on" },
      ),
    ).rejects.toThrow("deployed by its own installer");
  });
});

describe("with a revision of the release", () => {
  it("deploys the revision's Access values, opens its public paths, and keeps a protection it requires on", async () => {
    // Released without a word about Access; a revision requires protection,
    // keeps share links public and builds the team's address from its name.
    const w = await world({
      ...PLAIN,
      revision: {
        requires: ["access"],
        access: { mode: "required", bypass: ["/s/*"] },
        vars: [
          { name: "TITLE", label: "Title", default: "Cut" },
          {
            name: "ACCESS_URL",
            label: "Team address",
            default: "https://{{accessTeamName}}.cloudflareaccess.com",
            optional: true,
          },
        ],
      },
    });
    await recordFixtureRevision(w.fixture);
    const r = await change(w, "on");
    expect(r.error).toBeNull();
    expect(r.params).toMatchObject({ access: "on", refreshVars: ["access"] });
    expect(uploadedVars(w)).toMatchObject({
      ACCESS_URL: "https://appflare-test.cloudflareaccess.com",
    });
    const bypass = [...w.access.apps.values()].find((a) => String(a.name).endsWith("public paths"));
    expect(bypass?.destinations).toContainEqual({
      type: "public",
      uri: "cut.appflare-dev.workers.dev/s/*",
    });
    await expect(change(w, "off")).rejects.toThrow("cannot be turned off");
    expect(await readInstallProtection(env.DB, INSTALL_ID)).not.toBeNull();
  });
});

describe("accessFailureNote", () => {
  it("says what a half-done change left", () => {
    expect(accessFailureNote("on", "protected", false)).toContain("Turn protection on again");
    expect(accessFailureNote("on", "protected", true)).toBeNull();
    expect(accessFailureNote("off", null, true)).toContain("Turn protection off again");
    expect(accessFailureNote("off", "unprotected", true)).toBeNull();
    expect(accessFailureNote(undefined, null, true)).toBeNull();
  });
});

describe("isAccessChangeJob", () => {
  it("tells a change of protection from another settings change", () => {
    const row = (input: unknown) => ({ kind: "reconfigure", input_json: JSON.stringify(input) });
    expect(isAccessChangeJob(row({ access: "on" }))).toBe(true);
    expect(isAccessChangeJob(row({ access: "off" }))).toBe(true);
    expect(isAccessChangeJob(row({ refreshVars: ["access"] }))).toBe(false);
    expect(isAccessChangeJob({ kind: "update", input_json: '{"access":"on"}' })).toBe(false);
  });
});
