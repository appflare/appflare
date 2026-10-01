import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { FAKE_ACC, fakeAccessAccount } from "../test/fake-access-account";
import { recordProtectedInstall } from "../test/protected-install";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { checkAppAccessCore, readInstallAccessView } from "./app-access.server";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "./messages";

const AUTH = "auth-secret-0123456789abcdef0123456789";

async function addUser(email: string, role: string | null, banned = false) {
  await createDb(env.DB)
    .insert(user)
    .values({ id: crypto.randomUUID(), name: email, email, role, banned });
}

async function setUsersPolicy(id: string) {
  await writeSettings(createDb(env.DB), { [SETTING.appAccessUsersPolicyId]: id });
}

async function useManifest(f: Awaited<ReturnType<typeof buildArtifactFixture>>) {
  await env.DB.prepare("UPDATE installs SET manifest_json = ?2 WHERE id = ?1")
    .bind(INSTALL_ID, new TextDecoder().decode(f.manifestBytes))
    .run();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await addUser("owner@example.com", "admin");
  await addUser("member@example.com", "member");
  await addUser("banned@example.com", "member", true);
});

describe("checkAppAccessCore", () => {
  it("counts the users who get in and names the login methods", async () => {
    const cf = fakeAccessAccount();
    const idps = [
      { id: "idp-1", name: "One-time PIN", type: "onetimepin", config: {} },
      {
        id: "idp-2",
        name: "Cloudflare",
        type: "cloudflare",
        config: { restrict_to_account_members: true },
      },
    ];
    const client = {
      access: {
        ...cf.client.access,
        listIdentityProviders: async () => idps,
      },
    } as typeof cf.client;
    const check = await checkAppAccessCore({ db: env.DB, client });
    expect(check).toEqual({
      problem: null,
      users: 2,
      loginMethods: [
        "One-time PIN (a code sent by email)",
        "Cloudflare account (members of this Cloudflare account only)",
      ],
      oneTimePin: true,
    });
  });

  it("says what stands in the way, by where it is fixed, and leaves unreadable login methods out", async () => {
    const none = fakeAccessAccount();
    none.organization.current = null;
    const noOrg = await checkAppAccessCore({ db: env.DB, client: none.client });
    expect(noOrg.problem).toEqual({
      kind: "no-organization",
      message: ACCESS_MESSAGES.noOrganization,
    });
    // The fake account has no identity providers route: Cloudflare's 404.
    expect(noOrg.loginMethods).toBeNull();
    expect(noOrg.oneTimePin).toBe(false);

    const tokens = fakeAccessAccount();
    tokens.forbidden.add(`GET /accounts/${FAKE_ACC}/access/service_tokens`);
    expect((await checkAppAccessCore({ db: env.DB, client: tokens.client })).problem).toEqual({
      kind: "tokens-permission",
      message: INSTALL_ACCESS_MESSAGES.tokensPermission,
    });
  });
});

describe("readInstallAccessView", () => {
  it("shows an app that is not protected, with what its entry offers", async () => {
    await useManifest(
      await buildArtifactFixture({
        catalog: { access: { mode: "recommended", bypass: ["/s/*", "/api/webhook"] } },
      }),
    );
    expect(await readInstallAccessView(env.DB, INSTALL_ID)).toEqual({
      offer: "recommended",
      protected: false,
      appName: null,
      teamDomain: null,
      publicPaths: ["/s/*", "/api/webhook"],
      syncFailedAt: null,
      usesAccessValues: false,
      users: 2,
      repair: null,
    });
  });

  it("shows a protected app: its Access application, team, a failed sync, and the Access values in use", async () => {
    await useManifest(
      await buildArtifactFixture({
        catalog: {
          requires: ["access"],
          access: { mode: "required" },
          vars: [{ name: "POLICY_AUD", label: "Audience", default: "{{accessAud}}" }],
        },
      }),
    );
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: "s" });
    await env.DB.prepare(
      `UPDATE install_access SET access_team_domain = 'team.cloudflareaccess.com',
         access_aud = 'aud-1', access_sync_failed_at = ?2, users_policy_id = 'users-1'
       WHERE install_id = ?1`,
    )
      .bind(INSTALL_ID, Date.parse("2026-10-01T10:00:00.000Z"))
      .run();
    await setUsersPolicy("users-1");
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, ?2, 'access_app', NULL, 'Appflare: Cut (cut)', 'app-i1', 1)`,
    )
      .bind(`${INSTALL_ID}:access_app:app`, INSTALL_ID)
      .run();
    expect(await readInstallAccessView(env.DB, INSTALL_ID)).toEqual({
      offer: "required",
      protected: true,
      appName: "Appflare: Cut (cut)",
      teamDomain: "team.cloudflareaccess.com",
      publicPaths: [],
      syncFailedAt: "2026-10-01T10:00:00.000Z",
      usesAccessValues: true,
      users: 2,
      repair: "sync-failed",
    });
  });

  it("has nothing for an app deployed by its own installer, or one that is gone", async () => {
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    expect(await readInstallAccessView(env.DB, INSTALL_ID)).toBeNull();
    await env.DB.prepare(
      "UPDATE installs SET build_kind = 'artifact', status = 'uninstalled' WHERE id = ?1",
    )
      .bind(INSTALL_ID)
      .run();
    expect(await readInstallAccessView(env.DB, INSTALL_ID)).toBeNull();
    expect(await readInstallAccessView(env.DB, "no-such-install")).toBeNull();
  });

  it("needs protecting again when Appflare users was made anew, or is not on record", async () => {
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: "s" });
    await env.DB.prepare(
      `UPDATE install_access SET access_team_domain = 'team.cloudflareaccess.com',
         access_aud = 'aud-1', users_policy_id = 'users-old' WHERE install_id = ?1`,
    )
      .bind(INSTALL_ID)
      .run();
    expect((await readInstallAccessView(env.DB, INSTALL_ID))?.repair).toBe("users-policy-missing");
    await setUsersPolicy("users-new");
    expect((await readInstallAccessView(env.DB, INSTALL_ID))?.repair).toBe("users-policy-replaced");
    await setUsersPolicy("users-old");
    expect((await readInstallAccessView(env.DB, INSTALL_ID))?.repair).toBeNull();
  });
});
