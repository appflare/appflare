import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AccessDestination } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { FAKE_TEAM_DOMAIN, fakeAccessAccount } from "../test/fake-access-account";
import { SUBDOMAIN } from "../test/fake-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { readInstallAccess, USERS_POLICY_NAME } from "./install-access.server";
import {
  accessAppName,
  installDestinations,
  PROTECT_MESSAGES,
  protectInstall,
  readInstallProtection,
  sameDestinations,
  syncInstallAccessDestinations,
  unprotectInstall,
} from "./protect.server";
import { ACCESS_MESSAGES } from "./toggle.server";

/**
 * Protecting one install with its own Cloudflare Access application, against
 * a stateful fake of the account's Access objects: what is made and
 * recorded, doing it twice, picking up after a partial failure, refusing an
 * address another application covers, keeping destinations in step, and
 * taking it all off again.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOST = `cut.${SUBDOMAIN}.workers.dev`;
const MANIFEST = JSON.stringify({ version: "1.0.0", catalog: { name: "Cut" }, worker: {} });

function setup() {
  const cf = fakeAccessAccount({ now: () => NOW });
  cf.scripts.push({ id: "cut", tag: "tag-cut" }, { id: "cut-worker", tag: "tag-cut-worker" });
  const deps = { db: env.DB, client: cf.client, authSecret: AUTH, now: () => NOW };
  return { cf, deps };
}

/** Calls that change something at Cloudflare. */
function writes(cf: ReturnType<typeof fakeAccessAccount>) {
  return cf.keys().filter((k) => !k.startsWith("GET "));
}

async function resourceRows(kind: string) {
  return (
    await env.DB.prepare(
      "SELECT id, name, cf_id, deleted_at FROM resources WHERE kind = ?1 ORDER BY rowid",
    )
      .bind(kind)
      .all<{ id: string; name: string; cf_id: string | null; deleted_at: number | null }>()
  ).results;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall({
    manifestJson: MANIFEST,
    resources: [
      { kind: "worker", name: "cut", cfId: "cut" },
      { kind: "domain", name: "links.example.com", cfId: "dom-1" },
    ],
  });
  await createDb(env.DB)
    .insert(user)
    .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
});

describe("installDestinations", () => {
  it("names each Worker by tag, a Worker not uploaded yet by its workers.dev host, then external domains", () => {
    expect(
      installDestinations({
        workers: [
          { name: "cut", tag: "tag-cut" },
          { name: "cut-api", tag: null },
        ],
        subdomain: SUBDOMAIN,
        externalHosts: ["b.customer.net", "A.customer.net", "a.customer.net"],
      }),
    ).toEqual([
      { type: "worker", worker_id: "tag-cut" },
      { type: "public", uri: `cut-api.${SUBDOMAIN}.workers.dev` },
      { type: "public", uri: "a.customer.net" },
      { type: "public", uri: "b.customer.net" },
    ]);
    expect(() =>
      installDestinations({
        workers: [{ name: "cut", tag: null }],
        subdomain: null,
        externalHosts: [],
      }),
    ).toThrow(PROTECT_MESSAGES.noSubdomain);
    const one: AccessDestination[] = [
      { type: "public", uri: "A.example.com" },
      { type: "worker", worker_id: "t" },
    ];
    const other: AccessDestination[] = [
      { type: "worker", worker_id: "t" },
      { type: "public", uri: "a.example.com" },
    ];
    expect(sameDestinations(one, other)).toBe(true);
    expect(sameDestinations(one, other.slice(1))).toBe(false);
  });
});

describe("protectInstall", () => {
  it("makes one application covering the install's Worker, letting in Appflare's users and its token", async () => {
    const { cf, deps } = setup();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(result.teamDomain).toBe(FAKE_TEAM_DOMAIN);
    const [app] = [...cf.apps.values()];
    expect(app).toMatchObject({
      name: accessAppName("Cut", "cut"),
      type: "self_hosted",
      session_duration: "24h",
      app_launcher_visible: false,
      // The Worker's own destination covers its custom domain: none of its own.
      destinations: [{ type: "worker", worker_id: "tag-cut" }],
    });
    const users = [...cf.policies.values()].find((p) => p.name === USERS_POLICY_NAME);
    expect(app?.policies).toEqual([
      { id: users?.id, name: USERS_POLICY_NAME, decision: "allow", precedence: 1 },
      {
        id: expect.any(String),
        name: `Appflare health checks ${INSTALL_ID}`,
        decision: "non_identity",
        precedence: 2,
      },
    ]);
    const record = await readInstallAccess(env.DB, INSTALL_ID);
    const probes = cf.appPolicies.get(record?.probesPolicyId ?? "");
    expect(probes?.include).toEqual([{ service_token: { token_id: record?.tokenId } }]);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toEqual({
      accessAppId: app?.id,
      probesPolicyId: record?.probesPolicyId,
      aud: app?.aud,
      teamDomain: FAKE_TEAM_DOMAIN,
      coverage: {
        destinations: [{ type: "worker", worker_id: "tag-cut" }],
        workerTags: { cut: "tag-cut" },
      },
      syncFailedAt: null,
    });
    expect(await resourceRows("access_app")).toEqual([
      {
        id: `${INSTALL_ID}:access_app:app`,
        name: "Appflare: Cut (cut)",
        cf_id: app?.id,
        deleted_at: null,
      },
    ]);
    // Everything is checked before anything is made.
    expect(cf.keys().indexOf("POST /access/policies")).toBeGreaterThan(
      cf.keys().indexOf("GET /access/apps"),
    );
  });

  it("changes nothing when protected already, and keeps the audience tag", async () => {
    const { cf, deps } = setup();
    const first = await protectInstall(deps, { installId: INSTALL_ID });
    const before = writes(cf).length;
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again.outcome).toBe("unchanged");
    expect(again.aud).toBe(first.aud);
    // Only the users policy is rewritten (as every protect keeps it current).
    expect(writes(cf).slice(before)).toEqual([
      `PUT /access/policies/${[...cf.policies.keys()][0]}`,
    ]);
    expect(cf.apps.size).toBe(1);
  });

  it("takes over an application whose creation was not recorded, with a fresh token policy", async () => {
    const { cf, deps } = setup();
    const first = await protectInstall(deps, { installId: INSTALL_ID });
    const oldProbes = (await readInstallAccess(env.DB, INSTALL_ID))?.probesPolicyId;
    // The answer to the create was lost: nothing recorded the application.
    await env.DB.prepare(
      "UPDATE install_access SET access_app_id = NULL, probes_policy_id = NULL, access_aud = NULL",
    ).run();
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again.outcome).toBe("adopted");
    expect(again.accessAppId).toBe(first.accessAppId);
    expect(again.aud).toBe(first.aud);
    expect(cf.apps.size).toBe(1);
    const record = await readInstallAccess(env.DB, INSTALL_ID);
    expect(record?.accessAppId).toBe(first.accessAppId);
    expect(record?.probesPolicyId).not.toBe(oldProbes);
    // The old inline policy went with the rewrite: one token policy, naming the token.
    expect([...cf.appPolicies.values()].map((p) => p.include)).toEqual([
      [{ service_token: { token_id: record?.tokenId } }],
    ]);
  });

  it("picks up after a refusal part way, making nothing twice", async () => {
    const { cf, deps } = setup();
    cf.forbidden.add("POST /accounts/acc0000000000000000000000000000a/access/service_tokens");
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      /cannot manage Access service tokens/,
    );
    // The users policy exists; no application was made.
    expect(cf.policies.size).toBe(1);
    expect(cf.apps.size).toBe(0);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toBeNull();
    cf.forbidden.clear();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(cf.policies.size).toBe(1);
    expect(cf.tokens.size).toBe(1);
    expect(cf.apps.size).toBe(1);
  });

  it("refuses an address another application covers, before making anything", async () => {
    const { cf, deps } = setup();
    for (const [name, destinations] of [
      ["Team", [{ type: "public", uri: `*.${SUBDOMAIN}.workers.dev` }]],
      ["Old cut", [{ type: "worker", worker_id: "tag-cut" }]],
      ["Links", [{ type: "public", uri: "links.example.com/admin/*" }]],
    ] as const) {
      cf.apps.clear();
      cf.apps.set("other", { id: "other", aud: "aud-x", name, destinations, policies: [] });
      await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
        `The Cloudflare Access application "${name}" already covers`,
      );
    }
    expect(writes(cf)).toEqual([]);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toBeNull();
  });

  it("covers Workers before they exist, then switches to them by tag keeping the audience tag", async () => {
    const { cf, deps } = setup();
    const before = await protectInstall(deps, {
      installId: INSTALL_ID,
      appName: "Cut",
      workers: [
        { name: "cut", tag: null },
        { name: "cut-worker", tag: null },
      ],
    });
    expect([...cf.apps.values()][0]?.destinations).toEqual([
      { type: "public", uri: HOST },
      { type: "public", uri: `cut-worker.${SUBDOMAIN}.workers.dev` },
    ]);
    const after = await protectInstall(deps, {
      installId: INSTALL_ID,
      appName: "Cut",
      // One tag from the upload, one looked up.
      workers: [{ name: "cut", tag: "tag-cut" }, { name: "cut-worker" }],
    });
    expect(after.outcome).toBe("updated");
    expect(after.accessAppId).toBe(before.accessAppId);
    expect(after.aud).toBe(before.aud);
    const app = [...cf.apps.values()][0];
    expect(app?.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut" },
      { type: "worker", worker_id: "tag-cut-worker" },
    ]);
    // The token policy is referenced by id, so it stays.
    expect(app?.policies.map((p) => p.precedence)).toEqual([1, 2]);
    expect(cf.appPolicies.size).toBe(1);
  });

  it("covers an external domain with a public destination, recorded or about to be added", async () => {
    const { cf, deps } = setup();
    const pending = await protectInstall(deps, {
      installId: INSTALL_ID,
      pendingExternalHosts: ["Go.Customer.net"],
    });
    expect(pending.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut" },
      { type: "public", uri: "go.customer.net" },
    ]);
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:custom_hostname:x', ?1, 'custom_hostname', 'APP_I1', 'go.customer.net', 'z/ch', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    // Recorded now: the sync keeps it.
    await syncInstallAccessDestinations(deps, INSTALL_ID);
    expect([...cf.apps.values()][0]?.destinations).toContainEqual({
      type: "public",
      uri: "go.customer.net",
    });
    // Removed: the destination comes off.
    await env.DB.prepare(
      "UPDATE resources SET deleted_at = 2 WHERE id = 'i1:custom_hostname:x'",
    ).run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("updated");
    expect([...cf.apps.values()][0]?.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut" },
    ]);
  });

  it("takes over an application by its name only when it covers nothing but this install", async () => {
    const { cf, deps } = setup();
    cf.apps.set("mine", {
      id: "mine",
      aud: "aud-mine",
      name: accessAppName("Cut", "cut"),
      destinations: [{ type: "public", uri: HOST }],
      policies: [],
    });
    const adopted = await protectInstall(deps, { installId: INSTALL_ID });
    expect(adopted).toMatchObject({ outcome: "adopted", accessAppId: "mine", aud: "aud-mine" });
    expect(cf.apps.size).toBe(1);

    // One made by hand under that name for more than the app is never taken over.
    await unprotectInstall(deps, INSTALL_ID);
    cf.apps.set("hand", {
      id: "hand",
      aud: "aud-hand",
      name: accessAppName("Cut", "cut"),
      destinations: [
        { type: "worker", worker_id: "tag-cut" },
        { type: "public", uri: "intranet.example.com" },
      ],
      policies: [],
    });
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      `"${accessAppName("Cut", "cut")}" already covers one of its Workers`,
    );
    expect(cf.apps.get("hand")?.destinations).toHaveLength(2);
  });

  it("refuses a Worker the account does not have, an app deployed by its own installer, and no Zero Trust", async () => {
    const { cf, deps } = setup();
    cf.scripts.length = 0;
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      PROTECT_MESSAGES.workerMissing("cut"),
    );
    cf.scripts.push({ id: "cut", tag: "tag-cut" });
    cf.organization.current = null;
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      ACCESS_MESSAGES.noOrganization,
    );
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying'").run();
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      PROTECT_MESSAGES.selfDeploying("Cut"),
    );
    expect(writes(cf)).toEqual([]);
  });

  it("waits for another Access change (the lock) instead of interleaving", async () => {
    const { deps } = setup();
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('access_lock', 'someone', ?1)",
    )
      .bind(Date.now())
      .run();
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      ACCESS_MESSAGES.busy,
    );
  });
});

describe("syncInstallAccessDestinations", () => {
  it("does nothing for an app Appflare does not protect", async () => {
    const { cf, deps } = setup();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("not-protected");
    expect(cf.calls).toEqual([]);
  });

  it("writes only a change of destinations, keeping settings changed in the dashboard", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const app = [...cf.apps.values()][0];
    if (app === undefined) throw new Error("no app");
    app.session_duration = "8h";
    cf.calls.length = 0;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("unchanged");
    expect(cf.calls).toEqual([]);

    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:custom_hostname:x', ?1, 'custom_hostname', 'APP_I1', 'go.customer.net', NULL, 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("updated");
    const updated = cf.apps.get(app.id);
    expect(updated?.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut" },
      { type: "public", uri: "go.customer.net" },
    ]);
    expect(updated?.session_duration).toBe("8h");
    expect(updated?.aud).toBe(app.aud);
    expect(updated?.policies.length).toBe(2);
    expect(cf.appPolicies.size).toBe(1);

    await env.DB.prepare(
      "UPDATE resources SET deleted_at = 2 WHERE id = 'i1:custom_hostname:x'",
    ).run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("updated");
    expect(cf.apps.get(app.id)?.destinations).toEqual([{ type: "worker", worker_id: "tag-cut" }]);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut" },
    ]);
  });
});

describe("syncInstallAccessDestinations and a Worker it cannot find", () => {
  it("refuses instead of leaving the Worker uncovered", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:worker:cut-gone', ?1, 'worker', NULL, 'cut-gone', 'cut-gone', 2)`,
    )
      .bind(INSTALL_ID)
      .run();
    const before = [...cf.apps.values()][0]?.destinations;
    await expect(syncInstallAccessDestinations(deps, INSTALL_ID)).rejects.toThrow(
      PROTECT_MESSAGES.workerMissing("cut-gone"),
    );
    expect([...cf.apps.values()][0]?.destinations).toEqual(before);
  });
});

describe("unprotectInstall", () => {
  it("deletes the application, then the token, then the unused users policy, and forgets them", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    cf.calls.length = 0;
    const removed = await unprotectInstall(deps, INSTALL_ID);
    expect(removed).toEqual({ removed: true, usersPolicy: "removed" });
    expect(writes(cf).map((k) => k.replace(/\/[^/]+$/, "/<id>"))).toEqual([
      "DELETE /access/apps/<id>",
      "DELETE /access/service_tokens/<id>",
      "DELETE /access/policies/<id>",
    ]);
    expect(cf.apps.size + cf.tokens.size + cf.policies.size + cf.appPolicies.size).toBe(0);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toBeNull();
    expect((await resourceRows("access_app"))[0]?.deleted_at).not.toBeNull();
    expect((await resourceRows("access_service_token"))[0]?.deleted_at).not.toBeNull();
    const s = await readSettings(createDb(env.DB), [SETTING.appAccessUsersPolicyId]);
    expect(s.app_access_users_policy_id).toBeFalsy();
    // Again: nothing left to do.
    expect(await unprotectInstall(deps, INSTALL_ID)).toEqual({ removed: false, usersPolicy: null });
  });

  it("finds an application whose creation was not recorded, so the token can go", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      "UPDATE install_access SET access_app_id = NULL, probes_policy_id = NULL",
    ).run();
    const removed = await unprotectInstall(deps, INSTALL_ID);
    expect(removed.removed).toBe(true);
    expect(cf.apps.size + cf.tokens.size).toBe(0);
  });
});
