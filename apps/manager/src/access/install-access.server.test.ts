import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { FAKE_ACC, fakeAccessAccount } from "../test/fake-access-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { writeAccessConfig } from "./config";
import {
  accessAppSettings,
  anyProtectedInstall,
  appWithoutProbesPolicy,
  deleteInstallServiceToken,
  ensureAppAccessUsersPolicy,
  ensureInstallServiceToken,
  INSTALL_ACCESS_MESSAGES,
  listUserEmails,
  probesPolicy,
  RENEWALS_PER_RUN,
  ROTATION_GRACE_MS,
  readInstallAccess,
  recordInstallProtection,
  releaseAppAccessForRemoval,
  removeAppAccessUsersPolicyIfUnused,
  removeInstallAccess,
  renewInstallServiceTokens,
  resyncAppAccessUsersIfFailed,
  rotateInstallServiceToken,
  SERVICE_TOKEN_DURATION,
  serviceTokenName,
  serviceTokenNeedsRefresh,
  syncAppAccessUsers,
  tokenExpiry,
  USERS_POLICY_NAME,
  UsersPolicyMissingError,
} from "./install-access.server";
import { openServiceTokenSecret } from "./service-token-secret";
import { withAccessLock } from "./toggle.server";

const AUTH = "auth-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;
const I2 = "i2";

async function addUser(email: string, role: string | null, banned = false) {
  await createDb(env.DB)
    .insert(user)
    .values({ id: crypto.randomUUID(), name: email, email, role, banned });
}

async function addInstall(id: string, worker: string) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, installed_at, updated_at)
     VALUES (?1, 'app', ?2, ?2, '1.0.0', 'https://artifacts.test/a.zip', 'installed', 1, 1)`,
  )
    .bind(id, worker)
    .run();
}

async function rows(table: string) {
  return (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
}

async function setting(key: string) {
  return (await readSettings(createDb(env.DB), [key as typeof SETTING.appAccessUsersPolicyId]))[
    key as typeof SETTING.appAccessUsersPolicyId
  ];
}

function setup(now: Date = NOW) {
  const cf = fakeAccessAccount({ now: () => now });
  const deps = { db: env.DB, client: cf.client, authSecret: AUTH, now: () => now };
  return { cf, deps };
}

/** What protecting an app will do with these helpers: the users policy, the token, the application. */
async function protect(
  cf: ReturnType<typeof fakeAccessAccount>,
  deps: ReturnType<typeof setup>["deps"],
  installId: string,
) {
  return withAccessLock(env.DB, async () => {
    const users = await ensureAppAccessUsersPolicy(deps);
    const token = await ensureInstallServiceToken(deps, installId);
    const app = await cf.client.access.createApp({
      type: "self_hosted",
      name: `App ${installId}`,
      destinations: [{ type: "worker", worker_id: `tag-${installId}` }],
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [
        { id: users.policyId, precedence: 1 },
        { ...probesPolicy(installId, token.tokenId), precedence: 2 },
      ],
    });
    const probes = app.policies?.find((p) => p.decision === "non_identity");
    await recordInstallProtection(env.DB, installId, {
      accessAppId: app.id,
      probesPolicyId: probes?.id ?? "",
    });
    return { app, token, users };
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await addInstall(I2, "notes");
  await addUser("Owner@Example.com", "admin");
  await addUser("member@example.com", "member");
  await addUser("banned@example.com", "member", true);
});

describe("an install's service token", () => {
  it("is made for the install alone, stored sealed, and recorded as a resource", async () => {
    const { cf, deps } = setup();
    const ready = await withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID));
    expect(ready).toEqual({ tokenId: "tok-1", clientId: "client-1.access", outcome: "created" });
    expect(cf.calls[1]?.body).toEqual({
      name: serviceTokenName(INSTALL_ID),
      duration: SERVICE_TOKEN_DURATION,
    });
    const [row] = await rows("install_access");
    expect(row).toMatchObject({
      install_id: INSTALL_ID,
      access_app_id: null,
      token_id: "tok-1",
      token_client_id: "client-1.access",
      token_expires_at: Date.parse("2027-09-30T12:00:00.000Z"),
    });
    expect(JSON.stringify(await rows("install_access"))).not.toContain("DO-NOT-LEAK");
    expect(
      await openServiceTokenSecret(
        AUTH,
        { installId: INSTALL_ID, tokenId: "tok-1" },
        String(row?.token_secret),
      ),
    ).toBe("secret-1-DO-NOT-LEAK");
    // Another install's id does not open it.
    expect(
      await openServiceTokenSecret(
        AUTH,
        { installId: I2, tokenId: "tok-1" },
        String(row?.token_secret),
      ),
    ).toBeNull();
    const resource = (await rows("resources")).find((r) => r.kind === "access_service_token");
    expect(resource).toMatchObject({
      id: `${INSTALL_ID}:access_service_token:token`,
      install_id: INSTALL_ID,
      name: serviceTokenName(INSTALL_ID),
      cf_id: "tok-1",
      deleted_at: null,
    });
  });

  it("gives every install its own token", async () => {
    const { cf, deps } = setup();
    await withAccessLock(env.DB, async () => {
      await ensureInstallServiceToken(deps, INSTALL_ID);
      await ensureInstallServiceToken(deps, I2);
    });
    expect(cf.tokens.size).toBe(2);
    const [a, b] = [
      await readInstallAccess(env.DB, INSTALL_ID),
      await readInstallAccess(env.DB, I2),
    ];
    expect(a?.tokenId).not.toBe(b?.tokenId);
  });

  it("keeps a working token, and rotates one whose secret no longer reads", async () => {
    const { cf, deps } = setup();
    await withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID));
    cf.calls.length = 0;
    expect(
      await withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID)),
    ).toMatchObject({ outcome: "kept", tokenId: "tok-1" });
    expect(cf.keys()).toEqual(["GET /access/service_tokens"]);
    const other = "another-auth-secret-0123456789abcdef";
    expect(
      await withAccessLock(env.DB, () =>
        ensureInstallServiceToken({ ...deps, authSecret: other }, INSTALL_ID),
      ),
    ).toMatchObject({ outcome: "rotated", tokenId: "tok-1" });
    const record = await readInstallAccess(env.DB, INSTALL_ID);
    expect(
      await openServiceTokenSecret(
        other,
        { installId: INSTALL_ID, tokenId: "tok-1" },
        record?.sealedSecret ?? "",
      ),
    ).toBe(cf.tokens.get("tok-1")?.client_secret);
  });

  it("adopts a token found by its name when an earlier write was lost, instead of making another", async () => {
    const { cf, deps } = setup();
    cf.tokens.set("tok-orphan", {
      id: "tok-orphan",
      name: serviceTokenName(INSTALL_ID),
      client_id: "orphan.access",
      client_secret: "never-stored",
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    const ready = await withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID));
    expect(ready).toEqual({ tokenId: "tok-orphan", clientId: "orphan.access", outcome: "adopted" });
    expect(cf.keys()).toEqual([
      "GET /access/service_tokens",
      "POST /access/service_tokens/tok-orphan/rotate",
    ]);
    expect(cf.tokens.size).toBe(1);
  });

  it("makes a new one when the token was deleted in the dashboard, and points the app's policy at it", async () => {
    const { cf, deps } = setup();
    const { app } = await protect(cf, deps, INSTALL_ID);
    // The dashboard refuses deleting a token a policy names; the user removed it from the policy first.
    const probes = [...cf.appPolicies.values()][0];
    if (probes !== undefined) probes.include = [{ everyone: {} }];
    cf.tokens.clear();
    const ready = await withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID));
    expect(ready.outcome).toBe("recreated");
    expect([...cf.appPolicies.values()][0]?.include).toEqual([
      { service_token: { token_id: ready.tokenId } },
    ]);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toMatchObject({
      accessAppId: app.id,
      tokenId: ready.tokenId,
    });
  });

  it("rotates on request and says when there is nothing to rotate", async () => {
    const { cf, deps } = setup();
    await withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID));
    const before = await readInstallAccess(env.DB, INSTALL_ID);
    const after = await withAccessLock(env.DB, () => rotateInstallServiceToken(deps, INSTALL_ID));
    expect(after.sealedSecret).not.toBe(before?.sealedSecret);
    await expect(withAccessLock(env.DB, () => rotateInstallServiceToken(deps, I2))).rejects.toThrow(
      INSTALL_ACCESS_MESSAGES.notRecorded,
    );
    cf.tokens.clear();
    await expect(
      withAccessLock(env.DB, () => rotateInstallServiceToken(deps, INSTALL_ID)),
    ).rejects.toThrow(INSTALL_ACCESS_MESSAGES.tokenMissing);
  });

  it("is deleted only after the app's policy stops naming it (12139), then forgotten", async () => {
    const { cf, deps } = setup();
    const { app } = await protect(cf, deps, INSTALL_ID);
    await expect(
      withAccessLock(env.DB, () => deleteInstallServiceToken(deps, INSTALL_ID)),
    ).rejects.toThrow(INSTALL_ACCESS_MESSAGES.tokenInUse);
    await cf.client.access.deleteApp(app.id);
    expect(await withAccessLock(env.DB, () => deleteInstallServiceToken(deps, INSTALL_ID))).toEqual(
      { deleted: true },
    );
    expect(cf.tokens.size).toBe(0);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toBeNull();
    const resource = (await rows("resources")).find((r) => r.kind === "access_service_token");
    expect(resource?.deleted_at).toBe(NOW.getTime());
    // Already gone, and never made, both count as done.
    expect(await withAccessLock(env.DB, () => deleteInstallServiceToken(deps, INSTALL_ID))).toEqual(
      { deleted: false },
    );
  });

  it("names the missing permission, and refuses without BETTER_AUTH_SECRET before any call", async () => {
    const { cf, deps } = setup();
    cf.forbidden.add("GET /accounts/acc0000000000000000000000000000a/access/service_tokens");
    await expect(
      withAccessLock(env.DB, () => ensureInstallServiceToken(deps, INSTALL_ID)),
    ).rejects.toThrow("Access: Service Tokens: Edit");
    cf.calls.length = 0;
    await expect(
      withAccessLock(env.DB, () =>
        ensureInstallServiceToken({ ...deps, authSecret: undefined }, INSTALL_ID),
      ),
    ).rejects.toThrow(INSTALL_ACCESS_MESSAGES.noAuthSecret);
    expect(cf.calls).toEqual([]);
  });

  it("records protection, which is what makes an install protected by Appflare", async () => {
    const { cf, deps } = setup();
    expect(await anyProtectedInstall(env.DB)).toBe(false);
    await protect(cf, deps, INSTALL_ID);
    expect(await anyProtectedInstall(env.DB)).toBe(true);
    await recordInstallProtection(env.DB, INSTALL_ID, null);
    expect(await anyProtectedInstall(env.DB)).toBe(false);
  });
});

describe("the users policy", () => {
  it("lists every user who is not banned, members included", async () => {
    expect(await listUserEmails(env.DB)).toEqual(["member@example.com", "owner@example.com"]);
  });

  it("is created once, then rewritten, adopted by name after a lost write, or recreated", async () => {
    const { cf, deps } = setup();
    expect(await ensureAppAccessUsersPolicy(deps)).toMatchObject({
      policyId: "pol-1",
      outcome: "created",
    });
    expect(cf.policies.get("pol-1")).toEqual({
      id: "pol-1",
      name: USERS_POLICY_NAME,
      decision: "allow",
      include: [
        { email: { email: "member@example.com" } },
        { email: { email: "owner@example.com" } },
      ],
    });
    expect(await ensureAppAccessUsersPolicy(deps)).toMatchObject({ outcome: "updated" });
    await env.DB.prepare("DELETE FROM settings WHERE key = 'app_access_users_policy_id'").run();
    expect(await ensureAppAccessUsersPolicy(deps)).toMatchObject({
      policyId: "pol-1",
      outcome: "adopted",
    });
    cf.policies.clear();
    expect(await ensureAppAccessUsersPolicy(deps)).toMatchObject({ outcome: "recreated" });
    expect(cf.policies.size).toBe(1);
  });

  it("syncs after user changes, remembers a failure for the cron, and does nothing before it exists", async () => {
    const { cf, deps } = setup();
    const lazy = { db: env.DB, client: async () => cf.client, now: () => NOW };
    expect(await syncAppAccessUsers(lazy)).toEqual({ ok: true, on: false });
    expect(cf.calls).toEqual([]);
    await ensureAppAccessUsersPolicy(deps);
    await addUser("third@example.com", "member");
    expect(await syncAppAccessUsers(lazy)).toMatchObject({ on: true });
    expect(cf.policies.get("pol-1")?.include).toContainEqual({
      email: { email: "third@example.com" },
    });

    cf.forbidden.add("PUT /accounts/acc0000000000000000000000000000a/access/policies/pol-1");
    await expect(syncAppAccessUsers(lazy)).rejects.toThrow("Access: Apps and Policies: Edit");
    expect(await setting(SETTING.appAccessUsersSyncFailedAt)).toBe(NOW.toISOString());
    // A client that cannot be made counts as a failure too.
    await expect(
      syncAppAccessUsers({ ...lazy, client: async () => Promise.reject(new Error("no token")) }),
    ).rejects.toThrow("no token");

    cf.forbidden.clear();
    expect(await resyncAppAccessUsersIfFailed(lazy)).toBe("resynced");
    expect(await setting(SETTING.appAccessUsersSyncFailedAt)).toBeUndefined();
    cf.calls.length = 0;
    expect(await resyncAppAccessUsersIfFailed(lazy)).toBe("not-needed");
    expect(cf.calls).toEqual([]);
  });

  it("never writes an empty list", async () => {
    const { cf, deps } = setup();
    await ensureAppAccessUsersPolicy(deps);
    await env.DB.prepare("UPDATE user SET banned = 1").run();
    cf.calls.length = 0;
    await expect(ensureAppAccessUsersPolicy(deps)).rejects.toThrow(INSTALL_ACCESS_MESSAGES.noUsers);
    await expect(syncAppAccessUsers({ db: env.DB, client: async () => cf.client })).rejects.toThrow(
      INSTALL_ACCESS_MESSAGES.noUsers,
    );
    expect(cf.calls).toEqual([]);
  });

  it("is removed only once no app uses it", async () => {
    const { cf, deps } = setup();
    expect(await removeAppAccessUsersPolicyIfUnused(deps)).toEqual({
      removed: false,
      reason: "none",
    });
    const { app } = await protect(cf, deps, INSTALL_ID);
    // Protected by Appflare: kept.
    expect(await removeAppAccessUsersPolicyIfUnused(deps)).toMatchObject({ reason: "in-use" });
    // An application made in the dashboard still references it: kept.
    await recordInstallProtection(env.DB, INSTALL_ID, null);
    expect(await removeAppAccessUsersPolicyIfUnused(deps)).toMatchObject({ reason: "in-use" });
    await cf.client.access.deleteApp(app.id);
    expect(await removeAppAccessUsersPolicyIfUnused(deps)).toEqual({
      removed: true,
      reason: "removed",
    });
    expect(cf.policies.size).toBe(0);
    expect(await setting(SETTING.appAccessUsersPolicyId)).toBeUndefined();
  });

  it("stays out of the manager's own Access rows, and they stay out of it", async () => {
    const { deps } = setup();
    await writeAccessConfig(env.DB, {
      appId: "app-own",
      policyId: "pol-own",
      healthAppId: null,
      aud: "aud",
      teamDomain: "t.cloudflareaccess.com",
      domain: "appflare.example.com",
      enabledAt: NOW.toISOString(),
    });
    await ensureAppAccessUsersPolicy(deps);
    // The recovery for the manager's own protection.
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'access_%'").run();
    expect(await setting(SETTING.appAccessUsersPolicyId)).toBe("pol-1");
  });
});

describe("renewInstallServiceTokens", () => {
  it("calls nothing while every token has more than 30 days and a readable secret", async () => {
    const { cf, deps } = setup();
    await protect(cf, deps, INSTALL_ID);
    cf.calls.length = 0;
    const later = new Date(Date.parse("2027-09-30T12:00:00.000Z") - 31 * DAY);
    let asked = 0;
    const renewals = await renewInstallServiceTokens({
      db: env.DB,
      authSecret: AUTH,
      now: () => later,
      client: async () => {
        asked += 1;
        return cf.client;
      },
    });
    expect(renewals).toEqual([]);
    expect(asked).toBe(0);
  });

  it("refreshes a token under 30 days, rotates an unreadable one, reports one deleted in the dashboard", async () => {
    const { cf, deps } = setup();
    await protect(cf, deps, INSTALL_ID);
    await protect(cf, deps, I2);
    const later = new Date(Date.parse("2027-09-30T12:00:00.000Z") - 29 * DAY);
    const cfLater = fakeAccessAccount({ now: () => later });
    for (const [id, t] of cf.tokens) cfLater.tokens.set(id, t);
    const before = await readInstallAccess(env.DB, INSTALL_ID);
    const renewals = await renewInstallServiceTokens({
      db: env.DB,
      authSecret: AUTH,
      now: () => later,
      client: async () => cfLater.client,
    });
    expect(renewals).toEqual([
      { installId: INSTALL_ID, status: "refreshed" },
      { installId: I2, status: "refreshed" },
    ]);
    const after = await readInstallAccess(env.DB, INSTALL_ID);
    expect(after?.sealedSecret).toBe(before?.sealedSecret);
    expect(after?.expiresAt?.getTime()).toBe(later.getTime() + 365 * DAY);

    const other = "rotated-auth-secret-0123456789abcdef";
    cfLater.tokens.delete(before?.tokenId ?? "");
    const next = await renewInstallServiceTokens({
      db: env.DB,
      authSecret: other,
      now: () => later,
      client: async () => cfLater.client,
    });
    expect(next).toEqual([
      { installId: INSTALL_ID, status: "missing" },
      { installId: I2, status: "rotated" },
    ]);
  });

  it("records an expiry Cloudflare answers in a form that does not parse as unknown", async () => {
    const { cf, deps } = setup();
    await protect(cf, deps, INSTALL_ID);
    const later = new Date(Date.parse("2027-09-30T12:00:00.000Z") - 29 * DAY);
    const cfLater = fakeAccessAccount({ now: () => later });
    for (const [id, t] of cf.tokens) cfLater.tokens.set(id, t);
    const client = createClient({
      accountId: FAKE_ACC,
      token: "cf-token-DO-NOT-LEAK",
      fetch: async (input, init) => {
        const response = await cfLater.fetch(input, init);
        if (!String(input).endsWith("/refresh")) return response;
        const body = (await response.json()) as { result: Record<string, unknown> };
        return Response.json({ ...body, result: { ...body.result, expires_at: "next year" } });
      },
    });
    const renewals = await renewInstallServiceTokens({
      db: env.DB,
      authSecret: AUTH,
      now: () => later,
      client: async () => client,
    });
    expect(renewals).toEqual([{ installId: INSTALL_ID, status: "refreshed" }]);
    expect((await readInstallAccess(env.DB, INSTALL_ID))?.expiresAt).toBeNull();
    // Null, never an invalid date, whichever answer it is.
    expect(tokenExpiry("next year")).toBeNull();
    expect(tokenExpiry(undefined)).toBeNull();
    expect(tokenExpiry("2027-09-30T12:00:00.000Z")?.toISOString()).toBe("2027-09-30T12:00:00.000Z");
  });

  it("re-reads each install under the lock: a token replaced meanwhile is left alone", async () => {
    const { cf, deps } = setup();
    await protect(cf, deps, INSTALL_ID);
    const other = "rotated-auth-secret-0123456789abcdef";
    const renewals = await renewInstallServiceTokens({
      db: env.DB,
      authSecret: other,
      now: () => NOW,
      client: async () => {
        // Between the scan and the lock, the token is rotated with the new secret already.
        await withAccessLock(env.DB, () =>
          ensureInstallServiceToken({ ...deps, authSecret: other }, INSTALL_ID),
        );
        cf.calls.length = 0;
        return cf.client;
      },
    });
    expect(renewals).toEqual([{ installId: INSTALL_ID, status: "fresh" }]);
    expect(cf.calls).toEqual([]);
  });

  it("handles at most a batch per run", () => {
    expect(RENEWALS_PER_RUN).toBe(10);
    expect(serviceTokenNeedsRefresh(null, NOW)).toBe(false);
    expect(serviceTokenNeedsRefresh(new Date(NOW.getTime() + 31 * DAY), NOW)).toBe(false);
    expect(serviceTokenNeedsRefresh(new Date(NOW.getTime() + 29 * DAY), NOW)).toBe(true);
    expect(serviceTokenNeedsRefresh(new Date(NOW.getTime() - DAY), NOW)).toBe(true);
  });
});

describe("releaseAppAccessForRemoval", () => {
  it("puts each app back without its token policy, deletes its token, and leaves the apps and users policy", async () => {
    const { cf, deps } = setup();
    const one = await protect(cf, deps, INSTALL_ID);
    const two = await protect(cf, deps, I2);
    cf.calls.length = 0;
    expect(await releaseAppAccessForRemoval(deps)).toEqual({
      released: [INSTALL_ID, I2],
      failed: [],
    });
    const put = cf.calls.find(
      (c) => c.key.endsWith(`/access/apps/${one.app.id}`) && c.key.startsWith("PUT"),
    );
    expect(put?.body).toEqual({
      type: "self_hosted",
      name: `App ${INSTALL_ID}`,
      destinations: [{ type: "worker", worker_id: `tag-${INSTALL_ID}` }],
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [{ id: one.users.policyId, precedence: 1 }],
    });
    expect(cf.apps.size).toBe(2);
    expect(cf.apps.get(two.app.id)?.policies.map((p) => p.id)).toEqual([two.users.policyId]);
    expect(cf.appPolicies.size).toBe(0);
    expect(cf.tokens.size).toBe(0);
    expect(cf.policies.size).toBe(1);
    expect(await rows("install_access")).toEqual([]);
  });

  it("deletes the token of an app whose application is already gone, and goes on past a failure", async () => {
    const { cf, deps } = setup();
    const one = await protect(cf, deps, INSTALL_ID);
    await protect(cf, deps, I2);
    cf.apps.delete(one.app.id);
    for (const [id, p] of cf.appPolicies) if (p.appId === one.app.id) cf.appPolicies.delete(id);
    cf.forbidden.add(`PUT /accounts/acc0000000000000000000000000000a/access/apps/*`);
    const result = await releaseAppAccessForRemoval(deps);
    expect(result.released).toEqual([INSTALL_ID]);
    expect(result.failed).toEqual([
      { installId: I2, message: INSTALL_ACCESS_MESSAGES.policiesPermission },
    ]);
    expect(await readInstallAccess(env.DB, I2)).not.toBeNull();
  });

  it("builds the body from what the application answered, never its read-only fields", () => {
    const body = appWithoutProbesPolicy(
      {
        id: "app-1",
        aud: "aud",
        domain: null,
        self_hosted_domains: ["x.example.com"],
        destinations: [{ type: "worker", worker_id: "tag" }],
        name: "App",
        session_duration: "24h",
        policies: [
          { id: "pol-users", precedence: 1 },
          { id: "apol-probes", name: "Appflare health checks i1", precedence: 2 },
          { id: "pol-dash", precedence: 3 },
        ],
        created_at: "then",
      } as Parameters<typeof appWithoutProbesPolicy>[0],
      "i1",
      null,
    );
    expect(body).toEqual({
      type: "self_hosted",
      destinations: [{ type: "worker", worker_id: "tag" }],
      name: "App",
      session_duration: "24h",
      policies: [
        { id: "pol-users", precedence: 1 },
        { id: "pol-dash", precedence: 3 },
      ],
    });
  });
});

describe("removeInstallAccess", () => {
  it("deletes the app's Access application, then its token, then the users policy once unused", async () => {
    const { cf, deps } = setup();
    await protect(cf, deps, INSTALL_ID);
    await protect(cf, deps, I2);
    expect(await withAccessLock(env.DB, () => removeInstallAccess(deps, INSTALL_ID))).toEqual({
      removed: true,
      usersPolicy: "in-use",
    });
    expect(cf.apps.size).toBe(1);
    expect(cf.tokens.size).toBe(1);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toBeNull();
    expect(await withAccessLock(env.DB, () => removeInstallAccess(deps, I2))).toEqual({
      removed: true,
      usersPolicy: "removed",
    });
    expect([cf.apps.size, cf.tokens.size, cf.policies.size]).toEqual([0, 0, 0]);
    expect(await withAccessLock(env.DB, () => removeInstallAccess(deps, I2))).toEqual({
      removed: false,
      usersPolicy: null,
    });
  });
});

describe("repairing the users policy from the cron", () => {
  it("makes a policy deleted in the dashboard again, says its id changed, and stops retrying", async () => {
    const { cf, deps } = setup();
    await ensureAppAccessUsersPolicy(deps);
    cf.policies.clear();
    const lazy = { db: env.DB, client: async () => cf.client, now: () => NOW };
    await expect(syncAppAccessUsers(lazy)).rejects.toBeInstanceOf(UsersPolicyMissingError);
    expect(await setting(SETTING.appAccessUsersSyncFailedAt)).toBe(NOW.toISOString());
    expect(await resyncAppAccessUsersIfFailed(lazy)).toBe("recreated");
    expect(cf.policies.size).toBe(1);
    expect(await setting(SETTING.appAccessUsersPolicyId)).not.toBe("pol-1");
    expect(await setting(SETTING.appAccessUsersSyncFailedAt)).toBeUndefined();
    expect(await resyncAppAccessUsersIfFailed(lazy)).toBe("not-needed");
  });

  it("does not make the policy again once it was removed because no app used it", async () => {
    const { cf, deps } = setup();
    await ensureAppAccessUsersPolicy(deps);
    cf.forbidden.add("PUT /accounts/acc0000000000000000000000000000a/access/policies/*");
    const lazy = { db: env.DB, client: async () => cf.client, now: () => NOW };
    await expect(syncAppAccessUsers(lazy)).rejects.toThrow();
    cf.forbidden.clear();
    await withAccessLock(env.DB, () => removeAppAccessUsersPolicyIfUnused(deps));
    cf.calls.length = 0;
    expect(await resyncAppAccessUsersIfFailed(lazy)).toBe("not-needed");
    expect(cf.calls).toEqual([]);
    expect(cf.policies.size).toBe(0);
  });

  it("syncs under the Access lock: a held lock is a remembered failure", async () => {
    const { cf, deps } = setup();
    await ensureAppAccessUsersPolicy(deps);
    await withAccessLock(env.DB, async () => {
      await expect(
        syncAppAccessUsers({ db: env.DB, client: async () => cf.client, now: () => NOW }),
      ).rejects.toThrow(/Another Access change/);
    });
    expect(await setting(SETTING.appAccessUsersSyncFailedAt)).toBe(NOW.toISOString());
  });

  it("gives a rotated token's previous secret a few minutes' grace", async () => {
    const { cf, deps } = setup();
    await protect(cf, deps, INSTALL_ID);
    cf.calls.length = 0;
    await renewInstallServiceTokens({
      db: env.DB,
      authSecret: "rotated-auth-secret-0123456789abcdef",
      now: () => NOW,
      client: async () => cf.client,
    });
    const rotate = cf.calls.find((c) => c.key.endsWith("/rotate"));
    expect(rotate?.body).toEqual({
      previous_client_secret_expires_at: new Date(NOW.getTime() + ROTATION_GRACE_MS).toISOString(),
    });
  });
});

describe("accessAppSettings", () => {
  it("leaves out the domain Cloudflare derived from the destinations, keeps one set alone", () => {
    const fromDestinations = accessAppSettings({
      id: "app-1",
      aud: "aud-1",
      name: "Appflare: 2FA (2fa)",
      domain: "2fa.example.workers.dev",
      self_hosted_domains: ["2fa.example.workers.dev"],
      destinations: [{ type: "public", uri: "2fa.example.workers.dev" }],
      session_duration: "24h",
    } as Parameters<typeof accessAppSettings>[0]);
    expect(fromDestinations).toEqual({
      name: "Appflare: 2FA (2fa)",
      destinations: [{ type: "public", uri: "2fa.example.workers.dev" }],
      session_duration: "24h",
    });
    const byDomain = accessAppSettings({
      id: "app-2",
      aud: "aud-2",
      name: "Legacy",
      domain: "legacy.example.com",
    } as Parameters<typeof accessAppSettings>[0]);
    expect(byDomain).toEqual({ name: "Legacy", domain: "legacy.example.com" });
  });
});
