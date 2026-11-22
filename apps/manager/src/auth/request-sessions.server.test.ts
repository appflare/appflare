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
import { createRequestSessions, type RequestSessions } from "./request-sessions.server";
import { type Auth, createAuth } from "./server";

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
let sessions: RequestSessions;
let certCalls: string[];

/** A page request as the browser sends it: no session yet, an Access sign-in. */
async function pageRequest(email: string | null): Promise<Request> {
  const headers = new Headers({ cookie: "theme=dark", accept: "text/html" });
  if (email !== null) {
    headers.set("Cf-Access-Jwt-Assertion", await team.sign(team.claims(Date.now(), { email })));
  }
  return new Request(`${BASE}/settings/users`, { headers });
}

beforeAll(async () => {
  team = await createTestAccessTeam("kid-1");
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  const certs = certsFetch(() => team.jwks);
  certCalls = certs.calls;
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
      password: "correct horse battery",
      role: "admin",
    },
  });
  await writeAccessConfig(env.DB, CONFIG);
  await writeAccessSignIn(env.DB, true);
  sessions = createRequestSessions();
});

describe("signInWithAccess", () => {
  it("opens a session and hands back the user and the cookies to send", async () => {
    const result = await sessions.signInWithAccess(a, await pageRequest("ada@example.com"));
    expect(result?.user).toMatchObject({ email: "ada@example.com", role: "admin" });
    expect(result?.setCookies.some((c) => /session_token=/.test(c))).toBe(true);
    expect(await createDb(env.DB).select().from(session)).toHaveLength(1);
  });

  it("lets a later Better Auth call in the same request see the new session", async () => {
    const request = await pageRequest("ada@example.com");
    // Before: the request itself carries no session.
    await expect(
      a.api.listPasskeys({ headers: sessions.headersFor(request) }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await sessions.signInWithAccess(a, request);
    // After: the same request's headers, as every auth.api call must forward them.
    expect(await a.api.listPasskeys({ headers: sessions.headersFor(request) })).toEqual([]);
    expect((await a.api.getSession({ headers: sessions.headersFor(request) }))?.user.email).toBe(
      "ada@example.com",
    );
    // The raw headers still have no session: forwarding them is the bug this guards against.
    await expect(a.api.listPasskeys({ headers: request.headers })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(sessions.headersFor(request).get("accept")).toBe("text/html");
  });

  it("leaves other requests alone", async () => {
    const signedIn = await pageRequest("ada@example.com");
    await sessions.signInWithAccess(a, signedIn);
    const other = await pageRequest("ada@example.com");
    expect(sessions.headersFor(other)).toBe(other.headers);
  });

  it("is null without an Access token, and reads nothing", async () => {
    const request = await pageRequest(null);
    expect(await sessions.signInWithAccess(a, request)).toBeNull();
    expect(certCalls).toHaveLength(0);
    expect(sessions.headersFor(request)).toBe(request.headers);
  });

  it("is null, opening nothing, when the endpoint refuses", async () => {
    expect(await sessions.signInWithAccess(a, await pageRequest("eve@example.com"))).toBeNull();
    await writeAccessSignIn(env.DB, false);
    expect(await sessions.signInWithAccess(a, await pageRequest("ada@example.com"))).toBeNull();
    expect(await createDb(env.DB).select().from(session)).toHaveLength(0);
  });

  it("is null rather than failing the page when the endpoint is missing", async () => {
    const without = createAuth({ db: createDb(env.DB), secret: SECRET, baseURL: BASE });
    expect(
      await sessions.signInWithAccess(without, await pageRequest("ada@example.com")),
    ).toBeNull();
  });
});
