import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { session, user } from "../db/schema";
import { probeRoundTrips, type RoundTrips } from "../test/round-trips";
import { type Auth, createAuth, SESSION_COOKIE_CACHE_SECONDS } from "./server";
import { isSessionCopyCookie, mayUseSessionCopy, withoutSessionCopy } from "./session-cookie";

const BASE = "https://appflare.appflare-dev.workers.dev";
const SECRET = "test-only-better-auth-secret-0000000000000";
const PASSWORD = "correct horse battery staple";

let auth: Auth;
let probe: RoundTrips | null = null;

/** The `Cookie` header a browser sends after these `Set-Cookie` headers (expired ones dropped). */
function cookieHeader(setCookies: string[], previous = ""): string {
  const jar = new Map(
    previous
      .split("; ")
      .filter((c) => c.includes("="))
      .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as const),
  );
  for (const line of setCookies) {
    const [pair = ""] = line.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    if (/max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, pair.slice(pair.indexOf("=") + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function signIn(): Promise<{ userId: string; headers: Headers }> {
  const created = await auth.api.createUser({
    body: { email: "ada@example.com", name: "Ada", password: PASSWORD, role: "admin" },
  });
  const { headers } = await auth.api.signInEmail({
    body: { email: "ada@example.com", password: PASSWORD },
    returnHeaders: true,
  });
  return {
    userId: created.user.id,
    headers: new Headers({ cookie: cookieHeader(headers.getSetCookie()), origin: BASE }),
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  auth = createAuth({ db: createDb(env.DB), secret: SECRET, baseURL: BASE });
});

afterEach(() => {
  probe?.restore();
  probe = null;
  vi.useRealTimers();
});

describe("the session cookie cache", () => {
  it("is on for a minute", () => {
    expect(SESSION_COOKIE_CACHE_SECONDS).toBe(60);
    expect(auth.options.session?.cookieCache).toEqual({ enabled: true, maxAge: 60 });
  });

  it("answers a session check from the cookie, without D1", async () => {
    const { headers } = await signIn();
    probe = probeRoundTrips();
    const session = await auth.api.getSession({ headers });
    expect(session?.user.email).toBe("ada@example.com");
    expect(probe.d1Statements()).toBe(0);
  });

  it("reads D1 when asked to (changes), and without the cookie copy", async () => {
    const { headers } = await signIn();
    probe = probeRoundTrips();
    await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    expect(probe.d1Statements()).toBeGreaterThan(0);
    const fresh = probe.d1Statements();
    probe.clear();
    const tokenOnly = new Headers({
      cookie: (headers.get("cookie") ?? "")
        .split("; ")
        .filter((c) => !c.includes("session_data"))
        .join("; "),
    });
    const { headers: set } = await auth.api.getSession({
      headers: tokenOnly,
      returnHeaders: true,
    });
    expect(probe.d1Statements()).toBe(fresh);
    // The copy comes back with the answer, so the next check is served from it.
    expect(set.getSetCookie().some((c) => c.includes("session_data"))).toBe(true);
  });

  it("sees a role change at once when read fresh, and within a minute otherwise", async () => {
    const { userId, headers } = await signIn();
    const now = Date.now();
    await createDb(env.DB).update(user).set({ role: "member" }).where(eq(user.id, userId));
    expect((await auth.api.getSession({ headers }))?.user.role).toBe("admin");
    const fresh = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    expect(fresh?.user.role).toBe("member");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + (SESSION_COOKIE_CACHE_SECONDS + 1) * 1000);
    expect((await auth.api.getSession({ headers }))?.user.role).toBe("member");
  });

  it("is not trusted by Better Auth's own endpoints once the handler strips it", async () => {
    const { userId, headers } = await signIn();
    // The session is revoked elsewhere; the cookie copy still says it is valid.
    await createDb(env.DB).delete(session).where(eq(session.userId, userId));
    const request = new Request(`${BASE}/api/auth/passkey/generate-register-options?name=Laptop`, {
      headers: { cookie: headers.get("cookie") ?? "", origin: BASE },
    });
    expect(mayUseSessionCopy(request)).toBe(false);
    // Left in, the copy would still pass the endpoint's session check.
    expect((await auth.handler(new Request(request))).status).toBe(200);
    const res = await auth.handler(withoutSessionCopy(request));
    expect(res.status).toBe(401);
    // Only the session read keeps the copy.
    expect(mayUseSessionCopy(new Request(`${BASE}/api/auth/get-session`))).toBe(true);
    expect(mayUseSessionCopy(new Request(`${BASE}/api/auth/get-session`, { method: "POST" }))).toBe(
      false,
    );
  });

  it("strips the copy and nothing else from a request", () => {
    const request = new Request(`${BASE}/api/auth/list-sessions`, {
      headers: {
        cookie:
          "__Secure-better-auth.session_token=t.s; __Secure-better-auth.session_data=abc; better-auth.session_data.0=x; theme=dark",
      },
    });
    expect(withoutSessionCopy(request).headers.get("cookie")).toBe(
      "__Secure-better-auth.session_token=t.s; theme=dark",
    );
    const plain = new Request(`${BASE}/api/auth/list-sessions`, {
      headers: { cookie: "better-auth.session_token=t.s" },
    });
    expect(withoutSessionCopy(plain)).toBe(plain);
    expect(isSessionCopyCookie("better-auth.session_token")).toBe(false);
  });

  it("ends with signing out", async () => {
    const { headers } = await signIn();
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie: headers.get("cookie") ?? "", origin: BASE },
      }),
    );
    expect(response.ok).toBe(true);
    const after = new Headers({
      cookie: cookieHeader(response.headers.getSetCookie(), headers.get("cookie") ?? ""),
    });
    expect(await auth.api.getSession({ headers: after })).toBeNull();
  });
});
