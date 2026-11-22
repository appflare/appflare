import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AccessConfig, writeAccessConfig, writeAccessSignIn } from "../access/config";
import { createAccessKeyStore } from "../access/keys";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { session } from "../db/schema";
import {
  AUD,
  certsFetch,
  createTestAccessTeam,
  TEAM_DOMAIN,
  type TestAccessTeam,
} from "../test/access-jwt";
import {
  ACCESS_SIGN_IN_PATH,
  ACCESS_SIGN_IN_REFUSED,
  SIGNED_OUT_COOKIE,
  SIGNED_OUT_MAX_AGE_SECONDS,
  signedOutHere,
} from "./access-sign-in";
import { ACCESS_SIGN_IN_RATE_LIMIT } from "./access-sign-in-plugin";
import { type Auth, createAuth } from "./server";
import { withSetCookies } from "./session-cookie";

const BASE = "https://appflare.appflare-dev.workers.dev";
const SECRET = "test-only-better-auth-secret-0000000000000";
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
let a: Auth;

function signInRequest(token: string | null, ip = "203.0.113.9"): Request {
  const headers = new Headers({
    origin: BASE,
    "content-type": "application/json",
    "cf-connecting-ip": ip,
  });
  if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${BASE}/api/auth${ACCESS_SIGN_IN_PATH}`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

async function tokenFor(email: string): Promise<string> {
  return team.sign(team.claims(Date.now(), { email }));
}

/** The session cookie's `name=value`, from a response's Set-Cookie headers. */
function sessionCookie(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => /session_token=/.test(c));
}

beforeAll(async () => {
  team = await createTestAccessTeam("kid-1");
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  const certs = certsFetch(() => team.jwks);
  a = createAuth({
    db: createDb(env.DB),
    secret: SECRET,
    baseURL: BASE,
    accessSignIn: { d1: env.DB, keys: createAccessKeyStore({ fetch: certs.fetch }) },
  });
  await a.api.createUser({
    body: {
      email: "ada@example.com",
      name: "Ada",
      password: "correct horse battery staple",
      role: "admin",
    },
  });
  await writeAccessConfig(env.DB, CONFIG);
});

describe("the Access sign-in endpoint", () => {
  it("opens a session for the matching user and sets its cookie", async () => {
    await writeAccessSignIn(env.DB, true);
    const response = await a.handler(signInRequest(await tokenFor("Ada@Example.com")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { email: "ada@example.com", name: "Ada", role: "admin" },
    });
    const cookie = sessionCookie(response.headers);
    expect(cookie).toBeDefined();
    expect(await createDb(env.DB).select().from(session)).toHaveLength(1);

    // The cookie is a working session.
    const read = await a.api.getSession({ headers: new Headers({ cookie: cookie ?? "" }) });
    expect(read?.user.email).toBe("ada@example.com");
  });

  it("works through the server API too, handing back the cookies", async () => {
    await writeAccessSignIn(env.DB, true);
    const { headers, response } = await a.api.signInWithCloudflareAccess({
      headers: new Headers({ "Cf-Access-Jwt-Assertion": await tokenFor("ada@example.com") }),
      returnHeaders: true,
    });
    expect(response.user.email).toBe("ada@example.com");
    expect(sessionCookie(headers)).toBeDefined();

    // A later read in the same request, with the cookies just set, finds the
    // session: from the signed copy, and from D1.
    const same = withSetCookies(new Headers({ cookie: "theme=dark" }), headers.getSetCookie());
    expect((await a.api.getSession({ headers: same }))?.user.email).toBe("ada@example.com");
    expect(
      (await a.api.getSession({ headers: same, query: { disableCookieCache: true } }))?.user.email,
    ).toBe("ada@example.com");
  });

  it("refuses with a 403 and the reason, and opens no session", async () => {
    const off = await a.handler(signInRequest(await tokenFor("ada@example.com")));
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: ACCESS_SIGN_IN_REFUSED, reason: "sign-in-off" });

    await writeAccessSignIn(env.DB, true);
    const stranger = await a.handler(
      signInRequest(await tokenFor("eve@example.com"), "203.0.113.10"),
    );
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ reason: "no-user" });
    const missing = await a.handler(signInRequest(null, "203.0.113.11"));
    expect(await missing.json()).toMatchObject({ reason: "missing" });

    expect(sessionCookie(stranger.headers)).toBeUndefined();
    expect(await createDb(env.DB).select().from(session)).toHaveLength(0);
  });

  it("is rate limited per client address", async () => {
    await writeAccessSignIn(env.DB, true);
    const statuses: number[] = [];
    for (let i = 0; i <= ACCESS_SIGN_IN_RATE_LIMIT.max; i++) {
      statuses.push((await a.handler(signInRequest(null))).status);
    }
    expect(statuses).toEqual([...Array(ACCESS_SIGN_IN_RATE_LIMIT.max).fill(403), 429]);
    const other = await a.handler(signInRequest(null, "198.51.100.7"));
    expect(other.status).toBe(403);
  });
});

/** The sign-out marker's `Set-Cookie` header in `headers`, if any. */
function markerSetCookie(headers: Headers): string | undefined {
  return headers.getSetCookie().find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`));
}

describe("signing out sticks", () => {
  const MARKER = `${SIGNED_OUT_COOKIE}=1`;

  async function signedInCookies(): Promise<string> {
    const response = await a.handler(signInRequest(await tokenFor("ada@example.com")));
    expect(response.status).toBe(200);
    return withSetCookies(new Headers(), response.headers.getSetCookie()).get("cookie") ?? "";
  }

  beforeEach(async () => {
    await writeAccessSignIn(env.DB, true);
  });

  it("sets the sign-out marker when signing out, long-lived and out of scripts' reach", async () => {
    const cookie = await signedInCookies();
    const response = await a.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json", cookie },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const marker = markerSetCookie(response.headers);
    expect(marker).toMatch(new RegExp(`^${SIGNED_OUT_COOKIE}=1;`));
    expect(marker).toMatch(new RegExp(`Max-Age=${SIGNED_OUT_MAX_AGE_SECONDS}`, "i"));
    expect(marker).toMatch(/HttpOnly/i);
    expect(marker).toMatch(/SameSite=Lax/i);
    expect(marker).toMatch(/Secure/i);
    expect(marker).toMatch(/Path=\//i);
    // The browser now carries it, which keeps pages from signing it in again.
    const after = withSetCookies(new Headers({ cookie }), response.headers.getSetCookie());
    expect(signedOutHere(after)).toBe(true);
  });

  it("clears the marker when Continue as signs the browser in", async () => {
    const request = signInRequest(await tokenFor("ada@example.com"));
    const withMarker = new Request(request, {
      headers: { ...Object.fromEntries(request.headers), cookie: MARKER },
    });
    const response = await a.handler(withMarker);
    expect(response.status).toBe(200);
    expect(markerSetCookie(response.headers)).toMatch(/Max-Age=0/i);
    const after = withSetCookies(new Headers({ cookie: MARKER }), response.headers.getSetCookie());
    expect(signedOutHere(after)).toBe(false);
  });

  it("clears the marker when a password sign-in succeeds, and keeps it when one fails", async () => {
    const signIn = (password: string) =>
      a.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json", cookie: MARKER },
          body: JSON.stringify({ email: "ada@example.com", password }),
        }),
      );
    const failed = await signIn("not the password");
    expect(failed.status).toBe(401);
    expect(markerSetCookie(failed.headers)).toBeUndefined();

    const succeeded = await signIn("correct horse battery staple");
    expect(succeeded.status).toBe(200);
    expect(markerSetCookie(succeeded.headers)).toMatch(/Max-Age=0/i);
  });

  it("touches no marker the browser does not have", async () => {
    const response = await a.handler(signInRequest(await tokenFor("ada@example.com")));
    expect(markerSetCookie(response.headers)).toBeUndefined();
  });
});
