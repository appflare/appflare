import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import {
  AUD,
  certsFetch,
  createTestAccessTeam,
  TEAM_DOMAIN,
  type TestAccessTeam,
} from "../test/access-jwt";
import { type AccessConfig, writeAccessConfig, writeAccessSignIn } from "./config";
import { createAccessKeyStore } from "./keys";
import { type AccessSignInDeps, accessSignInOfferFor, checkAccessSignIn } from "./sign-in.server";

const CONFIG: AccessConfig = {
  appId: "app-1",
  policyId: "pol-1",
  healthAppId: "app-health",
  aud: AUD,
  teamDomain: TEAM_DOMAIN,
  domain: "appflare.appflare-dev.workers.dev",
  enabledAt: "2026-09-23T12:00:00.000Z",
};

let team: TestAccessTeam;
let clock: number;
let deps: AccessSignInDeps;

function headers(token?: string): Headers {
  const h = new Headers();
  if (token !== undefined) h.set("Cf-Access-Jwt-Assertion", token);
  return h;
}

async function addUser(
  values: Partial<typeof user.$inferInsert> & { id: string; email: string },
): Promise<void> {
  await createDb(env.DB)
    .insert(user)
    .values({ name: values.id, role: "admin", ...values });
}

async function tokenFor(email: string | undefined): Promise<string> {
  const claims = team.claims(clock, { email });
  if (email === undefined) delete claims.email;
  return team.sign(claims);
}

beforeAll(async () => {
  team = await createTestAccessTeam("kid-1");
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  clock = Date.parse("2026-09-23T12:00:00.000Z");
  const certs = certsFetch(() => team.jwks);
  deps = {
    d1: env.DB,
    keys: createAccessKeyStore({ fetch: certs.fetch, now: () => clock }),
    now: () => clock,
  };
  await addUser({ id: "u-ada", email: "ada@example.com", name: "Ada", isOwner: true });
});

describe("Sign in with Cloudflare Access, while it cannot apply", () => {
  it("refuses while protection is off, even with the switch row left behind", async () => {
    await writeAccessSignIn(env.DB, true);
    const result = await checkAccessSignIn(deps, headers(await tokenFor("ada@example.com")));
    expect(result).toEqual({ ok: false, reason: "protection-off" });
  });

  it("refuses while protection is on but the switch is off", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    const result = await checkAccessSignIn(deps, headers(await tokenFor("ada@example.com")));
    expect(result).toEqual({ ok: false, reason: "sign-in-off" });
  });
});

describe("Sign in with Cloudflare Access, while it is on", () => {
  beforeEach(async () => {
    await writeAccessConfig(env.DB, CONFIG);
    await writeAccessSignIn(env.DB, true);
  });

  it("finds the user the verified Access email belongs to", async () => {
    const result = await checkAccessSignIn(deps, headers(await tokenFor("ada@example.com")));
    expect(result).toEqual({
      ok: true,
      user: { id: "u-ada", email: "ada@example.com", name: "Ada", role: "admin", isOwner: true },
    });
  });

  it("ignores case in the email", async () => {
    const result = await checkAccessSignIn(deps, headers(await tokenFor("Ada@Example.COM")));
    expect(result).toMatchObject({ ok: true, user: { id: "u-ada" } });
  });

  it("refuses a request without an Access token", async () => {
    expect(await checkAccessSignIn(deps, headers())).toEqual({ ok: false, reason: "missing" });
    expect(await checkAccessSignIn(deps, undefined)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a token that does not verify, with the reason", async () => {
    const other = await createTestAccessTeam("kid-1");
    const forged = await other.sign(other.claims(clock, { email: "ada@example.com" }));
    expect(await checkAccessSignIn(deps, headers(forged))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const expired = await team.sign(
      team.claims(clock - 2 * 3600_000, { email: "ada@example.com" }),
    );
    expect(await checkAccessSignIn(deps, headers(expired))).toEqual({
      ok: false,
      reason: "expired",
    });
    const elsewhere = await team.sign(
      team.claims(clock, { email: "ada@example.com", aud: ["another-app"] }),
    );
    expect(await checkAccessSignIn(deps, headers(elsewhere))).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
    expect(await checkAccessSignIn(deps, headers("not.a.token"))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a token without an email, as a service token carries", async () => {
    expect(await checkAccessSignIn(deps, headers(await tokenFor(undefined)))).toEqual({
      ok: false,
      reason: "no-email",
    });
    expect(await checkAccessSignIn(deps, headers(await tokenFor("  ")))).toEqual({
      ok: false,
      reason: "no-email",
    });
  });

  it("refuses an email no user has, and creates no user", async () => {
    const result = await checkAccessSignIn(deps, headers(await tokenFor("eve@example.com")));
    expect(result).toEqual({ ok: false, reason: "no-user" });
    expect(await createDb(env.DB).select({ id: user.id }).from(user)).toEqual([{ id: "u-ada" }]);
  });

  it("refuses an email two users share once case is ignored", async () => {
    await addUser({ id: "u-ada-2", email: "ADA@example.com" });
    const result = await checkAccessSignIn(deps, headers(await tokenFor("ada@example.com")));
    expect(result).toEqual({ ok: false, reason: "ambiguous-user" });
  });

  it("refuses a banned user, and lets one whose ban ended through", async () => {
    await addUser({ id: "u-bob", email: "bob@example.com", role: "member", banned: true });
    expect(await checkAccessSignIn(deps, headers(await tokenFor("bob@example.com")))).toEqual({
      ok: false,
      reason: "banned",
    });

    await addUser({
      id: "u-cy",
      email: "cy@example.com",
      role: "member",
      banned: true,
      banExpires: new Date(clock + 60_000),
    });
    expect(await checkAccessSignIn(deps, headers(await tokenFor("cy@example.com")))).toEqual({
      ok: false,
      reason: "banned",
    });
    clock += 120_000;
    expect(await checkAccessSignIn(deps, headers(await tokenFor("cy@example.com")))).toMatchObject({
      ok: true,
      user: { id: "u-cy", role: "member", isOwner: false },
    });
  });

  it("reads the switch on every call", async () => {
    const token = await tokenFor("ada@example.com");
    expect((await checkAccessSignIn(deps, headers(token))).ok).toBe(true);
    await writeAccessSignIn(env.DB, false);
    expect(await checkAccessSignIn(deps, headers(token))).toEqual({
      ok: false,
      reason: "sign-in-off",
    });
  });
});

describe("accessSignInOfferFor (the sign-in page's Continue as)", () => {
  it("names the matching user's email while the switch is on", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    await writeAccessSignIn(env.DB, true);
    expect(await accessSignInOfferFor(deps, headers(await tokenFor("Ada@Example.com")))).toBe(
      "ada@example.com",
    );
  });

  it("is null for any refusal", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    const token = await tokenFor("ada@example.com");
    expect(await accessSignInOfferFor(deps, headers(token))).toBeNull();
    await writeAccessSignIn(env.DB, true);
    expect(await accessSignInOfferFor(deps, headers(await tokenFor("eve@example.com")))).toBeNull();
  });

  it("reads nothing without an Access token", async () => {
    const broken = { ...deps, d1: undefined as unknown as D1Database };
    expect(await accessSignInOfferFor(broken, headers())).toBeNull();
  });

  it("is null rather than failing when the check cannot run", async () => {
    const broken = {
      ...deps,
      d1: {
        prepare() {
          throw new Error("D1 unavailable");
        },
      } as unknown as D1Database,
    };
    expect(
      await accessSignInOfferFor(broken, headers(await tokenFor("ada@example.com"))),
    ).toBeNull();
  });
});
