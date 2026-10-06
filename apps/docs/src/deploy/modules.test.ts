import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeStore } from "../install/test-store.ts";
import { oauthSetup, PREVIEW_ORIGIN, PUBLIC_OAUTH_CLIENT_ID } from "./config.ts";
import { handoffHash, handoffProof, newHandoffSecret } from "./handoff-secret.ts";
import { InstallerApiError, installerApi } from "./installer-api.ts";
import { HandoffError, isOwnerSetupUrl, managerApi } from "./manager-api.ts";
import { deployStorage, GRANT_KEY, INSTALLATION_KEY } from "./storage.ts";
import { AuthorizationNeeded, RENEW_BEFORE_MS, TokenKeeper } from "./tokens.ts";

describe("oauthSetup", () => {
  it("uses the public client and the callback on the page's own registered origin", () => {
    expect(oauthSetup("https://appflare.dev")).toEqual({
      ok: true,
      clientId: PUBLIC_OAUTH_CLIENT_ID,
      redirectUri: "https://appflare.dev/deploy/callback",
    });
    expect(oauthSetup(PREVIEW_ORIGIN)).toEqual({
      ok: true,
      clientId: PUBLIC_OAUTH_CLIENT_ID,
      redirectUri: `${PREVIEW_ORIGIN}/deploy/callback`,
    });
  });

  it("cannot sign in from an origin Cloudflare does not return to", () => {
    expect(oauthSetup("http://localhost:5173")).toEqual({
      ok: false,
      reason: "unregistered-origin",
    });
    expect(oauthSetup("https://www.appflare.dev")).toMatchObject({ ok: false });
  });

  it("takes a development client and callback, but only on the page's own origin", () => {
    expect(
      oauthSetup("http://localhost:5173", {
        clientId: "dev-client",
        callbackUrl: "http://localhost:5173/deploy/callback",
      }),
    ).toEqual({
      ok: true,
      clientId: "dev-client",
      redirectUri: "http://localhost:5173/deploy/callback",
    });
    expect(
      oauthSetup("http://localhost:5173", { callbackUrl: "https://appflare.dev/deploy/callback" }),
    ).toEqual({ ok: false, reason: "callback-elsewhere" });
    expect(oauthSetup("https://appflare.dev", { clientId: "  " })).toMatchObject({
      clientId: PUBLIC_OAUTH_CLIENT_ID,
    });
  });
});

describe("deployStorage", () => {
  const grant = {
    clientId: "c",
    accessToken: "access",
    expiresAt: 1,
    refreshToken: "refresh",
    scopes: ["d1.write"],
  };
  const installation = {
    installationId: "00000000-0000-4000-8000-000000000001",
    key: "k".repeat(43),
    handoffSecret: "s".repeat(43),
    accountId: "0123456789abcdef0123456789abcdef",
  };

  it("keeps the grant in sessionStorage and the installation in localStorage, and nothing else", () => {
    const session = fakeStore();
    const local = fakeStore();
    const storage = deployStorage(
      () => session,
      () => local,
    );
    expect(storage.grant.write(grant)).toBe(true);
    expect(storage.installation.write(installation)).toBe(true);
    expect([...session.data.keys()]).toEqual([GRANT_KEY]);
    expect([...local.data.keys()]).toEqual([INSTALLATION_KEY]);
    expect(local.data.get(INSTALLATION_KEY)).not.toContain("refresh");
    expect(storage.grant.read()).toEqual(grant);
    expect(storage.installation.read()).toEqual(installation);
  });

  it("refuses to write a token into the installation slot", () => {
    const local = fakeStore();
    const storage = deployStorage(
      () => fakeStore(),
      () => local,
    );
    const withToken = { ...installation, refreshToken: "refresh" } as typeof installation;
    expect(storage.installation.write(withToken)).toBe(false);
    expect(local.data.size).toBe(0);
  });

  it("drops a stored value that does not check out", () => {
    const local = fakeStore({ [INSTALLATION_KEY]: JSON.stringify({ ...installation, key: "x" }) });
    const storage = deployStorage(
      () => fakeStore(),
      () => local,
    );
    expect(storage.installation.read()).toBeNull();
    expect(local.data.size).toBe(0);
  });

  it("keeps nothing, without throwing, where the browser refuses storage", () => {
    const storage = deployStorage(
      () => fakeStore({}, true),
      () => {
        throw new DOMException("blocked", "SecurityError");
      },
    );
    expect(storage.grant.write(grant)).toBe(false);
    expect(storage.installation.write(installation)).toBe(false);
    expect(storage.grant.read()).toBeNull();
    expect(storage.installation.read()).toBeNull();
  });
});

describe("the handoff secret", () => {
  it("is 32 random bytes as base64url, fresh each time", () => {
    const a = newHandoffSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newHandoffSecret()).not.toBe(a);
  });

  it("hashes as hex SHA-256 of its characters, and proves as the installer and Appflare compute it", async () => {
    const secret = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const hash = createHash("sha256").update(secret, "utf8").digest("hex");
    expect(await handoffHash(secret)).toBe(hash);
    const challenge = "abcdefghijklmnopqrstuvwxyz012345";
    const expected = createHmac("sha256", Buffer.from(hash, "hex"))
      .update(`appflare-handoff:${challenge}`)
      .digest("base64url");
    expect(await handoffProof(secret, challenge)).toBe(expected);
  });
});

describe("TokenKeeper", () => {
  function keeper(expiresIn: number, answer: () => Response | Promise<Response>) {
    let clock = 1_000_000;
    const store = fakeStore();
    const slot = deployStorage(
      () => store,
      () => fakeStore(),
    ).grant;
    slot.write({
      clientId: "client",
      accessToken: "access-1",
      expiresAt: clock + expiresIn,
      refreshToken: "refresh-1",
      scopes: ["d1.write"],
    });
    const calls: string[] = [];
    const tokens = new TokenKeeper({
      slot,
      now: () => clock,
      fetch: async (_url, init) => {
        calls.push(String(init?.body));
        return answer();
      },
    });
    return { tokens, calls, store, advance: (ms: number) => (clock += ms) };
  }

  const rotated = () =>
    Response.json({ access_token: "access-2", expires_in: 3600, refresh_token: "refresh-2" });

  it("uses the access token while it has time left", async () => {
    const k = keeper(RENEW_BEFORE_MS + 60_000, rotated);
    expect(await k.tokens.accessToken()).toBe("access-1");
    expect(k.calls).toEqual([]);
  });

  it("renews close to expiry, once for concurrent callers, and keeps the rotated refresh token", async () => {
    const k = keeper(RENEW_BEFORE_MS - 1, rotated);
    const [a, b] = await Promise.all([k.tokens.accessToken(), k.tokens.accessToken()]);
    expect([a, b]).toEqual(["access-2", "access-2"]);
    expect(k.calls).toHaveLength(1);
    expect(new URLSearchParams(k.calls[0]).get("refresh_token")).toBe("refresh-1");
    expect(k.tokens.grant()?.refreshToken).toBe("refresh-2");
    expect(JSON.parse(k.store.data.get(GRANT_KEY) ?? "{}").refreshToken).toBe("refresh-2");
  });

  it("forgets a grant Cloudflare no longer accepts and asks for a new sign-in", async () => {
    const k = keeper(0, () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(k.tokens.accessToken()).rejects.toBeInstanceOf(AuthorizationNeeded);
    expect(k.tokens.grant()).toBeNull();
    expect(k.store.data.has(GRANT_KEY)).toBe(false);
  });

  it("hands over the refresh token a renewal in progress rotates to, never the one it replaces", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const k = keeper(RENEW_BEFORE_MS - 1, async () => {
      await gate;
      return rotated();
    });
    const renewal = k.tokens.accessToken();
    const sent: string[] = [];
    const handed = k.tokens.handOver(async (grant) => {
      sent.push(grant.refreshToken);
      // A renewal asked for while the grant is being handed over does not rotate it.
      await k.tokens.renew();
      return "ok";
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([]);
    open();
    expect(await renewal).toBe("access-2");
    expect(await handed).toBe("ok");
    expect(sent).toEqual(["refresh-2"]);
    expect(k.calls).toHaveLength(1);
  });

  it("keeps using a still-valid token when an early renewal hits a hiccup", async () => {
    const k = keeper(60_000, () => new Response("busy", { status: 503 }));
    expect(await k.tokens.accessToken()).toBe("access-1");
    expect(k.tokens.grant()?.refreshToken).toBe("refresh-1");
  });
});

describe("installerApi", () => {
  it("posts JSON with the bearer token to the page's own origin, without cookies or a referrer", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const api = installerApi({
      accessToken: async () => "access-token",
      fetch: async (url, init) => {
        seen.push({ url, ...(init === undefined ? {} : { init }) });
        return Response.json({ release: { version: "0.4.2" } });
      },
    });
    expect(await api.release()).toEqual({ version: "0.4.2" });
    expect(seen[0]?.url).toBe("/api/install/release");
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(seen[0]?.init).toMatchObject({
      method: "POST",
      referrerPolicy: "no-referrer",
      credentials: "omit",
      body: "{}",
    });
  });

  it("carries the installer's own message, status and wait", async () => {
    const api = installerApi({
      accessToken: async () => "t",
      fetch: async () =>
        Response.json(
          { error: { code: "busy", message: "Another window is working on this installation." } },
          { status: 409, headers: { "retry-after": "2" } },
        ),
    });
    const error = await api.step("00000000-0000-4000-8000-000000000001", "k").catch((e) => e);
    expect(error).toBeInstanceOf(InstallerApiError);
    expect(error).toMatchObject({ status: 409, code: "busy", retryAfterMs: 2000, retryable: true });
    expect(error.message).toBe("Another window is working on this installation.");
  });

  it("treats a 401 as a sign-in to redo, and no answer as worth retrying", async () => {
    const unauthorized = installerApi({
      accessToken: async () => "t",
      fetch: async () =>
        Response.json({ error: { code: "cloudflare_auth", message: "x" } }, { status: 401 }),
    });
    expect(await unauthorized.accounts().catch((e) => e.needsAuthorization)).toBe(true);
    const offline = installerApi({
      accessToken: async () => "t",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await offline.accounts().catch((e) => [e.status, e.retryable])).toEqual([null, true]);
  });

  it("refuses an answer that does not have the documented shape", async () => {
    const api = installerApi({
      accessToken: async () => "t",
      fetch: async () => Response.json({ accounts: [{ id: "not-an-id", name: 1 }] }),
    });
    expect(await api.accounts().catch((e) => e.code)).toBe("invalid_response");
  });
});

describe("managerApi", () => {
  const address = "https://appflare.example.com";
  const secret = "s".repeat(43);

  it("accepts the owner setup page on the same address only", () => {
    expect(isOwnerSetupUrl(`${address}/setup#claim=abcdefghijklmnop`, address)).toBe(true);
    expect(isOwnerSetupUrl(`https://evil.example/setup#claim=abcdefghijklmnop`, address)).toBe(
      false,
    );
    expect(isOwnerSetupUrl(`${address}/elsewhere#claim=abcdefghijklmnop`, address)).toBe(false);
    expect(isOwnerSetupUrl(`${address}/setup?x=1#claim=abcdefghijklmnop`, address)).toBe(false);
    expect(
      isOwnerSetupUrl(`http://appflare.example.com/setup#claim=abcdefghijklmnop`, address),
    ).toBe(false);
    expect(isOwnerSetupUrl("javascript:alert(1)", address)).toBe(false);
  });

  it("does not follow redirects, sends no cookies and no referrer", async () => {
    let init: RequestInit | undefined;
    const api = managerApi(async (_url, given) => {
      init = given;
      return new Response("not json");
    });
    expect(await api.probe(address, secret)).toEqual({ kind: "unverified", reason: "other" });
    expect(init).toMatchObject({
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("refuses an owner setup URL that leads elsewhere", async () => {
    const api = managerApi(async () =>
      Response.json({
        ok: true,
        ownerSetupUrl: "https://evil.example/setup#claim=abcdefghijklmnop",
      }),
    );
    const error = await api
      .handOff(address, {
        secret,
        grant: { refreshToken: "r", clientId: "c", scopes: [] },
        accountId: "a",
        installer: { url: "https://appflare.dev", installationId: "i", key: "k" },
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HandoffError);
    expect(error.kind).toBe("invalid");
  });

  const handOffWith = (answer: () => Promise<Response>) =>
    managerApi(answer)
      .handOff(address, {
        secret,
        grant: { refreshToken: "r", clientId: "c", scopes: [] },
        accountId: "a",
        installer: { url: "https://appflare.dev", installationId: "i", key: "k" },
      })
      .catch((e) => e);

  it.each([
    [409, { error: "done" }, "done"],
    [403, { error: "forbidden" }, "refused"],
    [400, { error: "refused" }, "declined"],
    [400, { error: "invalid" }, "invalid"],
    [429, {}, "rate-limited"],
    [503, { error: "busy" }, "busy"],
    [502, { error: "failed" }, "failed"],
    [500, {}, "failed"],
  ])("names an answer of %i %j", async (status, body, kind) => {
    const error = await handOffWith(async () => Response.json(body, { status }));
    expect(error).toBeInstanceOf(HandoffError);
    expect(error.kind).toBe(kind);
  });

  it("tells another browser finishing setup apart from an owner that exists, with the minutes", async () => {
    const error = await handOffWith(async () =>
      Response.json({ error: "setup_elsewhere", message: "…", minutes: 12 }, { status: 409 }),
    );
    expect(error).toMatchObject({ kind: "elsewhere", minutes: 12 });
  });

  it("asks to connect Cloudflare again when the grant handed over was used up", async () => {
    const error = await handOffWith(async () =>
      Response.json({ error: "authorize_again", message: "…" }, { status: 401 }),
    );
    expect(error).toBeInstanceOf(AuthorizationNeeded);
  });

  it("does not claim nothing was sent when the answer never came", async () => {
    const error = await handOffWith(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(error.kind).toBe("no-answer");
  });
});
