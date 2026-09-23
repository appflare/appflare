import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { passkey, session } from "../db/schema";
import { listOwnPasskeys, removeOwnPasskey, toPasskeyRow } from "./passkeys.server";
import { type Auth, createAuth, passkeyRelyingParty } from "./server";

const HOST = "appflare.appflare-dev.workers.dev";
const BASE = `https://${HOST}`;
const SECRET = "test-only-better-auth-secret-0000000000000";
const PASSWORD = "correct horse battery staple";

function auth(baseURL = BASE): Auth {
  return createAuth({ db: createDb(env.DB), secret: SECRET, baseURL });
}

/** Creates a user the way `/setup` and admins do, then signs in; returns request headers. */
async function signedInAs(a: Auth, email: string): Promise<{ userId: string; headers: Headers }> {
  const { user } = await a.api.createUser({
    body: { email, name: email, password: PASSWORD, role: "member" },
  });
  const { headers: setCookies } = await a.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = setCookies
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: user.id, headers: new Headers({ cookie, origin: BASE }) };
}

async function seedPasskey(userId: string, id: string, name: string | null, createdAt: Date) {
  await createDb(env.DB)
    .insert(passkey)
    .values({
      id,
      name,
      userId,
      publicKey: "cHVibGljLWtleQ",
      credentialID: `cred-${id}`,
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      transports: "internal,hybrid",
      createdAt,
      aaguid: "bada5566-a7aa-401f-bd96-45619a55120d",
    });
}

function call(a: Auth, method: "GET" | "POST", path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", BASE);
  if (method === "POST") headers.set("content-type", "application/json");
  return a.handler(
    new Request(`${BASE}/api/auth${path}`, {
      ...init,
      method,
      headers,
      body: method === "POST" ? (init.body ?? "{}") : undefined,
    }),
  );
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("passkeyRelyingParty", () => {
  it("binds passkeys to the manager's own hostname and origin", () => {
    expect(passkeyRelyingParty(BASE)).toEqual({ rpID: HOST, origin: BASE });
  });

  it("keeps a port in the origin but not in the RP id", () => {
    expect(passkeyRelyingParty("http://localhost:5173")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:5173",
    });
  });
});

describe("passkey plugin registration", () => {
  it("is registered next to the admin plugin", () => {
    const ids = auth().options.plugins.map((p) => p.id);
    expect(ids).toEqual(["admin", "passkey"]);
  });

  it("pins the relying party instead of trusting the request's Origin header", () => {
    const plugin = auth().options.plugins.find((p) => p.id === "passkey");
    // The plugin object keeps the options it was created with; without a pinned
    // `origin` it would verify against whatever Origin header the browser sent.
    expect((plugin as { options?: unknown } | undefined)?.options).toMatchObject({
      rpID: HOST,
      origin: BASE,
    });
  });

  it("rate-limits the two passkey endpoints that work without a session", () => {
    const rules = auth().options.rateLimit?.customRules;
    expect(rules).toMatchObject({
      "/passkey/generate-authenticate-options": { window: 10, max: 3 },
      "/passkey/verify-authentication": { window: 10, max: 3 },
    });
  });

  it("exposes the passkey server API", () => {
    const api = auth().api;
    expect(typeof api.listPasskeys).toBe("function");
    expect(typeof api.deletePasskey).toBe("function");
    expect(typeof api.generatePasskeyRegistrationOptions).toBe("function");
    expect(typeof api.verifyPasskeyAuthentication).toBe("function");
  });

  it("has a passkey table with the columns the plugin writes", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('passkey')").all<{
      name: string;
    }>();
    expect(results.map((r) => r.name).sort()).toEqual(
      [
        "aaguid",
        "backed_up",
        "counter",
        "created_at",
        "credential_id",
        "device_type",
        "id",
        "name",
        "public_key",
        "transports",
        "user_id",
      ].sort(),
    );
  });
});

describe("passkey routes", () => {
  it.each([
    ["GET", "/passkey/list-user-passkeys"],
    ["GET", "/passkey/generate-register-options"],
    ["POST", "/passkey/verify-registration"],
    ["POST", "/passkey/delete-passkey"],
    ["POST", "/passkey/update-passkey"],
  ] as const)("%s %s rejects calls without a session", async (method, path) => {
    const body =
      path === "/passkey/verify-registration"
        ? JSON.stringify({ response: {} })
        : JSON.stringify({ id: "pk1", name: "x" });
    const res = await call(auth(), method, path, method === "POST" ? { body } : {});
    expect(res.status).toBe(401);
  });

  it("offers sign-in options for this hostname without a session", async () => {
    const res = await call(auth(), "GET", "/passkey/generate-authenticate-options");
    expect(res.status).toBe(200);
    const options = (await res.json()) as { rpId: string; challenge: string };
    expect(options.rpId).toBe(HOST);
    expect(options.challenge.length).toBeGreaterThan(0);
  });

  it("stops anonymous sign-in option requests after three in ten seconds", async () => {
    const a = auth();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await call(a, "GET", "/passkey/generate-authenticate-options", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("refuses to verify a sign-in without the challenge it issued", async () => {
    const res = await call(auth(), "POST", "/passkey/verify-authentication", {
      body: JSON.stringify({ response: { id: "cred-unknown" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("CHALLENGE_NOT_FOUND");
  });

  it("builds registration options with Appflare as the relying party", async () => {
    const a = auth();
    const { headers } = await signedInAs(a, "admin@example.com");
    const res = await call(a, "GET", "/passkey/generate-register-options?name=Laptop", {
      headers,
    });
    expect(res.status).toBe(200);
    const options = (await res.json()) as { rp: { id: string; name: string } };
    expect(options.rp).toEqual({ id: HOST, name: "Appflare" });
  });

  it("refuses to add a passkey from a session signed in more than a day ago", async () => {
    const a = auth();
    const { userId, headers } = await signedInAs(a, "admin@example.com");
    // Better Auth's default freshness window is 24 hours.
    await createDb(env.DB)
      .update(session)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(session.userId, userId));

    const res = await call(a, "GET", "/passkey/generate-register-options?name=Laptop", {
      headers,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SESSION_NOT_FRESH");
  });
});

describe("own passkeys", () => {
  it("lists only the signed-in user's passkeys, oldest first", async () => {
    const a = auth();
    const me = await signedInAs(a, "me@example.com");
    const other = await signedInAs(a, "other@example.com");
    await seedPasskey(me.userId, "pk-new", "Phone", new Date("2026-09-20T10:00:00Z"));
    await seedPasskey(me.userId, "pk-old", null, new Date("2026-09-01T10:00:00Z"));
    await seedPasskey(other.userId, "pk-theirs", "Theirs", new Date("2026-09-10T10:00:00Z"));

    const rows = await listOwnPasskeys(a, me.headers);
    expect(rows).toEqual([
      {
        id: "pk-old",
        name: null,
        provider: "1Password",
        synced: true,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "pk-new",
        name: "Phone",
        provider: "1Password",
        synced: true,
        createdAt: "2026-09-20T10:00:00.000Z",
      },
    ]);
  });

  it("removes the user's own passkey and refuses someone else's", async () => {
    const a = auth();
    const me = await signedInAs(a, "me@example.com");
    const other = await signedInAs(a, "other@example.com");
    await seedPasskey(me.userId, "pk-mine", "Laptop", new Date("2026-09-01T10:00:00Z"));
    await seedPasskey(other.userId, "pk-theirs", "Theirs", new Date("2026-09-01T10:00:00Z"));

    await expect(removeOwnPasskey(a, me.headers, "pk-theirs")).rejects.toMatchObject({
      statusCode: 401,
    });
    await removeOwnPasskey(a, me.headers, "pk-mine");

    expect(await listOwnPasskeys(a, me.headers)).toEqual([]);
    expect((await listOwnPasskeys(a, other.headers)).map((r) => r.id)).toEqual(["pk-theirs"]);
  });

  it("rejects listing without a session", async () => {
    await expect(listOwnPasskeys(auth(), new Headers())).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe("toPasskeyRow", () => {
  it("drops blank names and unknown authenticators", () => {
    expect(
      toPasskeyRow({
        id: "pk",
        name: "  ",
        aaguid: "00000000-0000-0000-0000-000000000000",
        backedUp: false,
        createdAt: null,
      }),
    ).toEqual({ id: "pk", name: null, provider: null, synced: false, createdAt: null });
  });
});
