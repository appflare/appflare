import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { certsFetch, createTestAccessTeam } from "../test/access-jwt";
import { type FakeRoute, FORBIDDEN, fakeCloudflare } from "../test/fake-cloudflare";
import { readAccessConfig, writeAccessConfig } from "./config";
import {
  ACCESS_MESSAGES,
  AccessToggleError,
  checkAccessMove,
  checkAccessPrerequisites,
  disableAccess,
  enableAccess,
  listAdminEmails,
  syncAccessAdmins,
} from "./toggle.server";

const TOKEN = "cfat_TEST-token-value-DO-NOT-LEAK";
const ACC = "acc0000000000000000000000000000a";
const A = `/accounts/${ACC}`;
const HOST = "appflare.appflare-dev.workers.dev";
const TEAM = "appflare-test.cloudflareaccess.com";
const NOW = new Date("2026-09-23T12:00:00.000Z");

type Routes = Parameters<typeof fakeCloudflare>[0];

/** An account with a Zero Trust organization and no Access applications yet. */
function readyRoutes(): Routes {
  return {
    [`GET ${A}/access/apps`]: { result: [], result_info: { page: 1, total_pages: 1 } },
    [`GET ${A}/access/organizations`]: { result: { auth_domain: TEAM, name: TEAM } },
    [`GET ${A}/access/identity_providers`]: {
      result: [
        {
          id: "idp-1",
          type: "cloudflare",
          name: "",
          config: { restrict_to_account_members: true },
        },
        { id: "idp-2", type: "onetimepin", name: "" },
      ],
      result_info: { page: 1, total_pages: 1 },
    },
    [`POST ${A}/access/apps`]: (() => {
      let n = 0;
      return (): FakeRoute => {
        n += 1;
        return { result: { id: `app-${n}`, aud: `aud-${n}` } };
      };
    })(),
    [`POST ${A}/access/apps/app-1/policies`]: { result: { id: "pol-1" } },
    [`POST ${A}/access/apps/app-2/policies`]: { result: { id: "pol-2" } },
    [`DELETE ${A}/access/apps/app-1`]: { result: { id: "app-1" } },
    [`DELETE ${A}/access/apps/app-2`]: { result: { id: "app-2" } },
    [`PUT ${A}/access/apps/app-1/policies/pol-1`]: { result: { id: "pol-1" } },
  };
}

let teamKeys: Awaited<ReturnType<typeof createTestAccessTeam>>;

function setup(routes: Routes, options: { certsDown?: boolean } = {}) {
  const api = fakeCloudflare(routes);
  const client = createClient({
    accountId: ACC,
    token: TOKEN,
    fetch: api.fetch,
    onRequest: api.onRequest,
  });
  const certs = options.certsDown
    ? { fetch: async () => new Response("down", { status: 503 }), calls: [] as string[] }
    : certsFetch(() => teamKeys.jwks);
  const deps = {
    db: env.DB,
    client,
    hostname: HOST,
    actorEmail: "Owner@Example.com",
    fetch: certs.fetch,
    now: () => NOW,
  };
  return { api, deps, certs };
}

async function addUser(email: string, role: string | null, banned = false) {
  await createDb(env.DB)
    .insert(user)
    .values({ id: crypto.randomUUID(), name: email, email, role, banned });
}

function bodyOf(api: ReturnType<typeof fakeCloudflare>, key: string, index = 0): unknown {
  const call = api.calls.filter((c) => c.key === key)[index];
  return call?.body ? JSON.parse(call.body) : undefined;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  teamKeys = await createTestAccessTeam();
  await addUser("owner@example.com", "admin");
  await addUser("second-admin@example.com", "admin");
  await addUser("member@example.com", "member");
  await addUser("banned-admin@example.com", "admin", true);
});

describe("listAdminEmails", () => {
  it("lists admins who are not banned, never members", async () => {
    expect(await listAdminEmails(env.DB)).toEqual([
      "owner@example.com",
      "second-admin@example.com",
    ]);
  });
});

describe("checkAccessPrerequisites", () => {
  it("reports the team, the allow list and the login methods, and changes nothing", async () => {
    const { api, deps } = setup(readyRoutes());
    expect(await checkAccessPrerequisites(deps)).toEqual({
      ok: true,
      hostname: HOST,
      teamDomain: TEAM,
      adminEmails: ["owner@example.com", "second-admin@example.com"],
      loginMethods: [
        "Cloudflare account (members of this Cloudflare account only)",
        "One-time PIN (a code sent by email)",
      ],
    });
    expect(api.keys().every((k) => k.startsWith("GET "))).toBe(true);
  });

  it("says which permission is missing when the token cannot list Access applications", async () => {
    const { deps } = setup({ ...readyRoutes(), [`GET ${A}/access/apps`]: FORBIDDEN });
    const check = await checkAccessPrerequisites(deps);
    expect(check).toMatchObject({ ok: false, problem: "apps-permission" });
    expect(check.ok ? "" : check.message).toContain("Access: Apps and Policies: Edit");
  });

  it("says which permission is missing when the token cannot read the organization", async () => {
    const { deps } = setup({ ...readyRoutes(), [`GET ${A}/access/organizations`]: FORBIDDEN });
    const check = await checkAccessPrerequisites(deps);
    expect(check).toMatchObject({ ok: false, problem: "organization-permission" });
    expect(check.ok ? "" : check.message).toContain(
      "Access: Organizations, Identity Providers, and Groups: Read",
    );
  });

  it("explains how to get a Zero Trust organization when the account has none", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`GET ${A}/access/organizations`]: {
        status: 404,
        errors: [{ code: 12130, message: "access.api.error.not_found" }],
      },
    });
    expect(await checkAccessPrerequisites(deps)).toEqual({
      ok: false,
      problem: "no-organization",
      message: ACCESS_MESSAGES.noOrganization,
    });
    expect(ACCESS_MESSAGES.noOrganization).toContain("50 users");
  });

  it("refuses a hostname that already has an Access application", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`GET ${A}/access/apps`]: {
        result: [{ id: "old", aud: "x", name: "Mine", domain: HOST }],
        result_info: { page: 1, total_pages: 1 },
      },
    });
    expect(await checkAccessPrerequisites(deps)).toMatchObject({
      ok: false,
      problem: "app-exists",
    });
  });

  it("refuses a hostname an application protects through its destinations", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`GET ${A}/access/apps`]: {
        result: [
          {
            id: "multi",
            aud: "x",
            name: "Several addresses",
            domain: null,
            destinations: [
              { type: "worker", worker_id: "tag-1" },
              { type: "public", uri: "other.example.com" },
              { type: "public", uri: HOST.toUpperCase() },
            ],
          },
        ],
        result_info: { page: 1, total_pages: 1 },
      },
    });
    expect(await checkAccessPrerequisites(deps)).toEqual({
      ok: false,
      problem: "app-exists",
      message: ACCESS_MESSAGES.appExists("Several addresses"),
    });
  });

  it("refuses a hostname listed only in self_hosted_domains", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`GET ${A}/access/apps`]: {
        result: [{ id: "old", aud: "x", name: "Old", self_hosted_domains: [HOST] }],
        result_info: { page: 1, total_pages: 1 },
      },
    });
    expect(await checkAccessPrerequisites(deps)).toMatchObject({ problem: "app-exists" });
  });

  it("does not count an application protecting only a path of the hostname", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`GET ${A}/access/apps`]: {
        result: [
          {
            id: "path",
            aud: "x",
            domain: null,
            destinations: [{ type: "public", uri: `${HOST}/open/*` }],
          },
        ],
        result_info: { page: 1, total_pages: 1 },
      },
    });
    expect(await checkAccessPrerequisites(deps)).toMatchObject({ ok: true });
  });

  it("refuses local development hosts", async () => {
    const { api, deps } = setup(readyRoutes());
    expect(await checkAccessPrerequisites({ ...deps, hostname: "localhost" })).toMatchObject({
      ok: false,
      problem: "unsupported-host",
    });
    expect(api.calls).toHaveLength(0);
  });
});

describe("enableAccess", () => {
  it("creates the application, the admins' policy and the health bypass, then stores the settings", async () => {
    const { api, deps, certs } = setup(readyRoutes());
    const result = await enableAccess(deps);
    expect(result).toEqual({
      ok: true,
      hostname: HOST,
      teamDomain: TEAM,
      adminEmails: ["owner@example.com", "second-admin@example.com"],
    });

    expect(bodyOf(api, `POST ${A}/access/apps`, 0)).toEqual({
      type: "self_hosted",
      name: `Appflare (${HOST})`,
      domain: HOST,
      session_duration: "24h",
      app_launcher_visible: false,
    });
    expect(bodyOf(api, `POST ${A}/access/apps/app-1/policies`)).toEqual({
      name: "Appflare admins",
      decision: "allow",
      include: [
        { email: { email: "owner@example.com" } },
        { email: { email: "second-admin@example.com" } },
      ],
      precedence: 1,
    });
    expect(bodyOf(api, `POST ${A}/access/apps`, 1)).toMatchObject({
      domain: `${HOST}/api/health`,
    });
    expect(bodyOf(api, `POST ${A}/access/apps/app-2/policies`)).toMatchObject({
      decision: "bypass",
      include: [{ everyone: {} }],
    });
    expect(certs.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);

    expect(await readAccessConfig(env.DB)).toEqual({
      appId: "app-1",
      policyId: "pol-1",
      healthAppId: "app-2",
      aud: "aud-1",
      teamDomain: TEAM,
      domain: HOST,
      enabledAt: NOW.toISOString(),
    });
    // Nothing the token could leak through: the logs are method, path, status.
    expect(JSON.stringify(api.logs)).not.toContain(TOKEN);
  });

  it("always allows the admin turning it on, even if their row says otherwise", async () => {
    const { api, deps } = setup(readyRoutes());
    await enableAccess({ ...deps, actorEmail: "late-admin@example.com" });
    const body = bodyOf(api, `POST ${A}/access/apps/app-1/policies`) as { include: unknown[] };
    expect(body.include).toContainEqual({ email: { email: "late-admin@example.com" } });
  });

  it("creates nothing when a check fails", async () => {
    const { api, deps } = setup({
      ...readyRoutes(),
      [`GET ${A}/access/organizations`]: { status: 404, errors: [] },
    });
    expect(await enableAccess(deps)).toMatchObject({ ok: false, problem: "no-organization" });
    expect(api.keys().some((k) => k.startsWith("POST"))).toBe(false);
    expect(await readAccessConfig(env.DB)).toBeNull();
  });

  it("removes what it created and stores nothing when a later step fails", async () => {
    const { api, deps } = setup({
      ...readyRoutes(),
      [`POST ${A}/access/apps/app-2/policies`]: FORBIDDEN,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(enableAccess(deps)).rejects.toThrow(ACCESS_MESSAGES.appsPermission);
    expect(api.keys()).toContain(`DELETE ${A}/access/apps/app-2`);
    expect(api.keys()).toContain(`DELETE ${A}/access/apps/app-1`);
    expect(await readAccessConfig(env.DB)).toBeNull();
    vi.restoreAllMocks();
  });

  it("does not turn on when the team's signing keys cannot be fetched", async () => {
    const { api, deps } = setup(readyRoutes(), { certsDown: true });
    await expect(enableAccess(deps)).rejects.toThrow(ACCESS_MESSAGES.keysUnreachable);
    expect(api.keys().filter((k) => k.startsWith("DELETE"))).toHaveLength(2);
    expect(await readAccessConfig(env.DB)).toBeNull();
  });

  it("refuses when protection is already on", async () => {
    const { deps } = setup(readyRoutes());
    await enableAccess(deps);
    await expect(enableAccess(deps)).rejects.toThrow(ACCESS_MESSAGES.alreadyOn);
  });
});

describe("disableAccess", () => {
  it("deletes both applications, then clears the settings", async () => {
    const { api, deps } = setup(readyRoutes());
    await enableAccess(deps);
    expect(await disableAccess(deps)).toEqual({ ok: true, wasOn: true });
    expect(api.keys().filter((k) => k.startsWith("DELETE"))).toEqual([
      `DELETE ${A}/access/apps/app-2`,
      `DELETE ${A}/access/apps/app-1`,
    ]);
    expect(await readAccessConfig(env.DB)).toBeNull();
  });

  it("treats applications already deleted in the dashboard as deleted", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`DELETE ${A}/access/apps/app-1`]: { status: 404, errors: [] },
      [`DELETE ${A}/access/apps/app-2`]: { status: 404, errors: [] },
    });
    await enableAccess(deps);
    expect(await disableAccess(deps)).toEqual({ ok: true, wasOn: true });
    expect(await readAccessConfig(env.DB)).toBeNull();
  });

  it("keeps checking tokens when an application could not be deleted", async () => {
    const { deps } = setup({ ...readyRoutes(), [`DELETE ${A}/access/apps/app-1`]: FORBIDDEN });
    await enableAccess(deps);
    await expect(disableAccess(deps)).rejects.toBeInstanceOf(AccessToggleError);
    expect(await readAccessConfig(env.DB)).not.toBeNull();
  });

  it("is a no-op when protection is off", async () => {
    const { api, deps } = setup(readyRoutes());
    expect(await disableAccess(deps)).toEqual({ ok: true, wasOn: false });
    expect(api.calls).toHaveLength(0);
  });
});

describe("syncAccessAdmins", () => {
  it("rewrites the allow policy with the current admins", async () => {
    const { api, deps } = setup(readyRoutes());
    await writeAccessConfig(env.DB, {
      appId: "app-1",
      policyId: "pol-1",
      healthAppId: "app-2",
      aud: "aud-1",
      teamDomain: TEAM,
      domain: HOST,
      enabledAt: NOW.toISOString(),
    });
    await addUser("new-admin@example.com", "admin");
    expect(await syncAccessAdmins(deps)).toEqual({
      ok: true,
      on: true,
      adminEmails: ["new-admin@example.com", "owner@example.com", "second-admin@example.com"],
    });
    expect(bodyOf(api, `PUT ${A}/access/apps/app-1/policies/pol-1`)).toMatchObject({
      decision: "allow",
      include: [
        { email: { email: "new-admin@example.com" } },
        { email: { email: "owner@example.com" } },
        { email: { email: "second-admin@example.com" } },
      ],
    });
  });

  it("does nothing while protection is off", async () => {
    const { api, deps } = setup(readyRoutes());
    expect(await syncAccessAdmins(deps)).toEqual({ ok: true, on: false });
    expect(api.calls).toHaveLength(0);
  });

  it("says how to recover when the policy was deleted in the dashboard", async () => {
    const { deps } = setup({
      ...readyRoutes(),
      [`PUT ${A}/access/apps/app-1/policies/pol-1`]: { status: 404, errors: [] },
    });
    await enableAccess(deps);
    await expect(syncAccessAdmins(deps)).rejects.toThrow(ACCESS_MESSAGES.policyMissing);
  });
});

describe("checkAccessMove", () => {
  const TARGET = "gate.example.com";

  async function accessOnHere() {
    await writeAccessConfig(env.DB, {
      appId: "app-1",
      policyId: "pol-1",
      healthAppId: "app-2",
      aud: "aud-1",
      teamDomain: TEAM,
      domain: HOST,
      enabledAt: NOW.toISOString(),
    });
  }

  function appsRoute(extra: unknown[]): Routes {
    return {
      ...readyRoutes(),
      [`GET ${A}/access/apps`]: {
        result: [
          { id: "app-1", aud: "aud-1", domain: HOST },
          { id: "app-2", aud: "aud-2", domain: `${HOST}/api/health` },
          ...extra,
        ],
        result_info: { page: 1, total_pages: 1 },
      },
    };
  }

  it("is null while protection is off", async () => {
    const { api, deps } = setup(readyRoutes());
    expect(await checkAccessMove(deps, TARGET)).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("returns the protection when nothing else protects the new hostname", async () => {
    await accessOnHere();
    const { deps } = setup(appsRoute([]));
    expect(await checkAccessMove(deps, TARGET)).toMatchObject({ appId: "app-1", domain: HOST });
  });

  it("refuses a hostname another application protects through its destinations", async () => {
    await accessOnHere();
    const { deps } = setup(
      appsRoute([
        {
          id: "other",
          aud: "x",
          name: "Gate",
          domain: null,
          destinations: [{ type: "public", uri: TARGET }],
        },
      ]),
    );
    await expect(checkAccessMove(deps, TARGET)).rejects.toThrow(ACCESS_MESSAGES.appExists("Gate"));
  });

  it("refuses a health path written in another case", async () => {
    await accessOnHere();
    const { deps } = setup(
      appsRoute([{ id: "other", aud: "x", name: "Upper", domain: `${TARGET}/API/Health` }]),
    );
    await expect(checkAccessMove(deps, TARGET)).rejects.toThrow(ACCESS_MESSAGES.appExists("Upper"));
  });

  it("refuses when another application's destinations cover the new health path", async () => {
    await accessOnHere();
    const { deps } = setup(
      appsRoute([
        {
          id: "other",
          aud: "x",
          name: "Health",
          domain: null,
          destinations: [{ type: "public", uri: `${TARGET}/api/health` }],
        },
      ]),
    );
    await expect(checkAccessMove(deps, TARGET)).rejects.toThrow(
      ACCESS_MESSAGES.appExists("Health"),
    );
  });
});
