import { describe, expect, it } from "vitest";
import { makeFakeFetch } from "./fake-fetch";
import type { FetchLike } from "./http";
import {
  APPFLARE_OAUTH_CALLBACK_URL,
  authorizationUrl,
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  CLOUDFLARE_OAUTH_REVOKE_URL,
  CLOUDFLARE_OAUTH_TOKEN_URL,
  CloudflareOAuthError,
  createOAuthState,
  createPkce,
  decodeOAuthState,
  encodeOAuthState,
  exchangeCode,
  isOAuthRelayOrigin,
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPE_BY_GROUP,
  MANAGER_OAUTH_SCOPES,
  missingManagerScopes,
  OAUTH_INVALID_RESPONSE,
  OAUTH_NETWORK_ERROR,
  OFFLINE_ACCESS_SCOPE,
  pkceChallenge,
  refreshGrant,
  revokeToken,
} from "./oauth";

const CLIENT_ID = "client-0123";
const CODE = "auth-code-DO-NOT-LEAK-1";
const VERIFIER = "verifier-DO-NOT-LEAK-0123456789abcdefghijklmnopq";
const REFRESH = "refresh-DO-NOT-LEAK-2";
const ACCESS = "access-DO-NOT-LEAK-3";
const ROTATED = "refresh-rotated-DO-NOT-LEAK-4";
const NOW = 1_800_000_000_000;
const now = () => NOW;

function tokenBody(extra: Record<string, unknown> = {}) {
  return {
    access_token: ACCESS,
    expires_in: 3600,
    refresh_token: ROTATED,
    scope: "workers-scripts.write d1.write offline_access",
    token_type: "bearer",
    ...extra,
  };
}

async function formOf(request: Request): Promise<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams(await request.clone().text()));
}

async function failure(promise: Promise<unknown>): Promise<CloudflareOAuthError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CloudflareOAuthError);
  return error as CloudflareOAuthError;
}

/** Every way an error can surface: message, string form, stack, JSON. */
function surfaces(error: Error): string {
  return [error.message, String(error), error.stack ?? "", JSON.stringify(error)].join("\n");
}

/** A refresh token whose form-encoded and percent-encoded forms differ from it. */
const ODD_REFRESH = "rt+Tok/en==more x";

const SECRETS = [CODE, VERIFIER, REFRESH, ACCESS, ROTATED, ODD_REFRESH];

/** A secret as sent in a form body, as in a URL, and as is. */
function formsOf(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ s: secret }).toString().slice("s=".length),
  ];
}

function expectNoSecrets(error: Error) {
  const text = surfaces(error);
  for (const secret of SECRETS) {
    for (const form of formsOf(secret)) expect(text).not.toContain(form);
  }
}

describe("endpoints", () => {
  it("are Cloudflare's documented OAuth endpoints and Appflare's callback", () => {
    expect(CLOUDFLARE_OAUTH_AUTHORIZE_URL).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(CLOUDFLARE_OAUTH_TOKEN_URL).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(CLOUDFLARE_OAUTH_REVOKE_URL).toBe("https://dash.cloudflare.com/oauth2/revoke");
    expect(APPFLARE_OAUTH_CALLBACK_URL).toBe("https://appflare.dev/deploy/callback");
  });
});

describe("PKCE", () => {
  it("matches the S256 example of RFC 7636 appendix B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a 43-character verifier and its challenge, fresh each time", async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(await pkceChallenge(a.verifier));
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.verifier).not.toBe(a.verifier);
  });

  it("refuses a verifier RFC 7636 does not allow, without repeating it", async () => {
    const tooShort = "short-secret-verifier";
    const error = await pkceChallenge(tooShort).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error?.message).not.toContain(tooShort);
    await expect(pkceChallenge(`${"a".repeat(43)} `)).rejects.toThrow(TypeError);
    await expect(pkceChallenge("a".repeat(129))).rejects.toThrow(TypeError);
  });
});

describe("authorizationUrl", () => {
  const args = {
    clientId: CLIENT_ID,
    redirectUri: APPFLARE_OAUTH_CALLBACK_URL,
    scopes: ["workers-scripts.write", "d1.write", OFFLINE_ACCESS_SCOPE],
    state: "c3RhdGU",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  };

  it("asks for a code with PKCE S256, every scope and the state", () => {
    const url = new URL(authorizationUrl(args));
    expect(`${url.origin}${url.pathname}`).toBe(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: "https://appflare.dev/deploy/callback",
      scope: "workers-scripts.write d1.write offline_access",
      state: "c3RhdGU",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
  });

  it("percent-encodes the redirect URI and joins scopes with %20", () => {
    const raw = authorizationUrl(args);
    expect(raw).toContain("redirect_uri=https%3A%2F%2Fappflare.dev%2Fdeploy%2Fcallback");
    expect(raw).toContain("scope=workers-scripts.write%20d1.write%20offline_access");
  });

  it("refuses an empty client id, no scopes, or a scope with a space", () => {
    expect(() => authorizationUrl({ ...args, clientId: "" })).toThrow(TypeError);
    expect(() => authorizationUrl({ ...args, scopes: [] })).toThrow(TypeError);
    expect(() => authorizationUrl({ ...args, scopes: ["d1.write zone.read"] })).toThrow(TypeError);
  });
});

describe("exchangeCode", () => {
  it("posts the code, verifier, redirect URI and client id as a form, with no secret header", async () => {
    const fake = makeFakeFetch({ envelope: tokenBody() });
    await exchangeCode({
      clientId: CLIENT_ID,
      code: CODE,
      codeVerifier: VERIFIER,
      redirectUri: APPFLARE_OAUTH_CALLBACK_URL,
      fetch: fake.fetch,
      now,
    });

    const call = fake.last();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(CLOUDFLARE_OAUTH_TOKEN_URL);
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.authorization).toBeNull();
    expect(await formOf(call.request)).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      redirect_uri: APPFLARE_OAUTH_CALLBACK_URL,
      client_id: CLIENT_ID,
      code_verifier: VERIFIER,
    });
  });

  it("returns the tokens, an absolute expiry and the granted scopes", async () => {
    const fake = makeFakeFetch({ envelope: tokenBody() });
    const tokens = await exchangeCode({
      clientId: CLIENT_ID,
      code: CODE,
      codeVerifier: VERIFIER,
      redirectUri: APPFLARE_OAUTH_CALLBACK_URL,
      fetch: fake.fetch,
      now,
    });
    expect(tokens).toEqual({
      accessToken: ACCESS,
      expiresAt: NOW + 3_600_000,
      scopes: ["workers-scripts.write", "d1.write", "offline_access"],
      refreshToken: ROTATED,
    });
  });

  it("says when no refresh token or scope came back", async () => {
    const fake = makeFakeFetch({
      envelope: { access_token: ACCESS, expires_in: 60, token_type: "bearer" },
    });
    const tokens = await exchangeCode({
      clientId: CLIENT_ID,
      code: CODE,
      codeVerifier: VERIFIER,
      redirectUri: APPFLARE_OAUTH_CALLBACK_URL,
      fetch: fake.fetch,
      now,
    });
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toBeNull();
    expect(tokens.expiresAt).toBe(NOW + 60_000);
  });
});

describe("refreshGrant", () => {
  it("posts the refresh token and client id as a form", async () => {
    const fake = makeFakeFetch({ envelope: tokenBody() });
    await refreshGrant({ clientId: CLIENT_ID, refreshToken: REFRESH, fetch: fake.fetch, now });

    const call = fake.last();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(CLOUDFLARE_OAUTH_TOKEN_URL);
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.authorization).toBeNull();
    expect(await formOf(call.request)).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: CLIENT_ID,
    });
  });

  it("returns the rotated refresh token", async () => {
    const fake = makeFakeFetch({ envelope: tokenBody() });
    const tokens = await refreshGrant({
      clientId: CLIENT_ID,
      refreshToken: REFRESH,
      fetch: fake.fetch,
      now,
    });
    expect(tokens.refreshToken).toBe(ROTATED);
    expect(tokens.accessToken).toBe(ACCESS);
    expect(tokens.expiresAt).toBe(NOW + 3_600_000);
  });

  it("keeps the refresh token it sent when the response has none", async () => {
    const fake = makeFakeFetch({ envelope: tokenBody({ refresh_token: undefined }) });
    const tokens = await refreshGrant({
      clientId: CLIENT_ID,
      refreshToken: REFRESH,
      fetch: fake.fetch,
      now,
    });
    expect(tokens.refreshToken).toBe(REFRESH);
  });

  it("counts the expiry from when the request was sent", async () => {
    let clock = NOW;
    const fake = makeFakeFetch(() => {
      clock += 5_000;
      return { envelope: tokenBody() };
    });
    const tokens = await refreshGrant({
      clientId: CLIENT_ID,
      refreshToken: REFRESH,
      fetch: fake.fetch,
      now: () => clock,
    });
    expect(tokens.expiresAt).toBe(NOW + 3_600_000);
  });
});

describe("revokeToken", () => {
  it("posts the refresh token with its type hint and the client id", async () => {
    const fake = makeFakeFetch({ text: "" });
    await revokeToken({ clientId: CLIENT_ID, token: REFRESH, fetch: fake.fetch });

    const call = fake.last();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(CLOUDFLARE_OAUTH_REVOKE_URL);
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.authorization).toBeNull();
    expect(await formOf(call.request)).toEqual({
      token: REFRESH,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    });
  });

  it("can revoke an access token", async () => {
    const fake = makeFakeFetch({ text: "" });
    await revokeToken({
      clientId: CLIENT_ID,
      token: ACCESS,
      tokenTypeHint: "access_token",
      fetch: fake.fetch,
    });
    expect((await formOf(fake.last().request)).token_type_hint).toBe("access_token");
  });

  it("throws the server's OAuth error", async () => {
    const fake = makeFakeFetch({ status: 401, envelope: { error: "invalid_client" } });
    const error = await failure(
      revokeToken({ clientId: CLIENT_ID, token: REFRESH, fetch: fake.fetch }),
    );
    expect(error.operation).toBe("revoke");
    expect(error.code).toBe("invalid_client");
    expectNoSecrets(error);
  });
});

describe("CloudflareOAuthError classification", () => {
  function refreshWith(fetch: ReturnType<typeof makeFakeFetch>["fetch"]) {
    return failure(refreshGrant({ clientId: CLIENT_ID, refreshToken: REFRESH, fetch, now }));
  }

  it("needs reconnecting on invalid_grant (revoked or expired grant)", async () => {
    const fake = makeFakeFetch({
      status: 400,
      envelope: {
        error: "invalid_grant",
        error_description: "The provided authorization grant is invalid, expired or revoked.",
      },
    });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe("invalid_grant");
    expect(error.status).toBe(400);
    expect(error.operation).toBe("refresh");
    expect(error.reconnectNeeded).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("invalid, expired or revoked");
  });

  it("is retryable, not revoked, when no response arrives", async () => {
    const fake = makeFakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe(OAUTH_NETWORK_ERROR);
    expect(error.status).toBeNull();
    expect(error.reconnectNeeded).toBe(false);
    expect(error.retryable).toBe(true);
  });

  it.each([500, 502, 503])("is retryable on HTTP %i with a gateway page", async (status) => {
    const fake = makeFakeFetch({ status, text: "<!DOCTYPE html><title>Bad gateway</title>" });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe(OAUTH_INVALID_RESPONSE);
    expect(error.status).toBe(status);
    expect(error.reconnectNeeded).toBe(false);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("DOCTYPE");
  });

  it("is retryable on HTTP 429, even with an OAuth error body", async () => {
    const fake = makeFakeFetch({ status: 429, envelope: { error: "rate_limited" } });
    const error = await refreshWith(fake.fetch);
    expect(error.status).toBe(429);
    expect(error.reconnectNeeded).toBe(false);
    expect(error.retryable).toBe(true);
  });

  it("is retryable on temporarily_unavailable", async () => {
    const fake = makeFakeFetch({ status: 400, envelope: { error: "temporarily_unavailable" } });
    const error = await refreshWith(fake.fetch);
    expect(error.retryable).toBe(true);
    expect(error.reconnectNeeded).toBe(false);
  });

  it("is neither for a refused client (a configuration problem, not the grant)", async () => {
    const fake = makeFakeFetch({ status: 401, envelope: { error: "invalid_client" } });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe("invalid_client");
    expect(error.reconnectNeeded).toBe(false);
    expect(error.retryable).toBe(false);
  });

  it("treats an OAuth error in a 200 body as that error", async () => {
    const fake = makeFakeFetch({ status: 200, envelope: { error: "invalid_grant" } });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe("invalid_grant");
    expect(error.reconnectNeeded).toBe(true);
  });

  it("names the missing fields of a malformed token response, not their values", async () => {
    const fake = makeFakeFetch({ envelope: { access_token: ACCESS, expires_in: "soon" } });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe(OAUTH_INVALID_RESPONSE);
    expect(error.status).toBe(200);
    expect(error.message).toContain("expires_in");
    expect(error.retryable).toBe(true);
    expectNoSecrets(error);
  });
});

describe("no credential in any error", () => {
  it("removes the code and verifier a server echoes back", async () => {
    const fake = makeFakeFetch({
      status: 400,
      envelope: {
        error: "invalid_request",
        error_description: `bad request: code=${CODE} code_verifier=${VERIFIER}`,
      },
    });
    const error = await failure(
      exchangeCode({
        clientId: CLIENT_ID,
        code: CODE,
        codeVerifier: VERIFIER,
        redirectUri: APPFLARE_OAUTH_CALLBACK_URL,
        fetch: fake.fetch,
        now,
      }),
    );
    expect(error.message).toContain("[redacted]");
    expectNoSecrets(error);
  });

  it("removes the refresh token a server echoes back", async () => {
    const fake = makeFakeFetch({
      status: 400,
      envelope: { error: "invalid_grant", error_description: `refresh_token=${REFRESH} is used` },
    });
    const error = await failure(
      refreshGrant({ clientId: CLIENT_ID, refreshToken: REFRESH, fetch: fake.fetch, now }),
    );
    expect(error.message).toContain("refresh_token=[redacted] is used");
    expectNoSecrets(error);
  });

  it("removes the request from a network error's message and keeps no cause", async () => {
    const fake = makeFakeFetch(() => {
      throw new Error(`socket closed while sending refresh_token=${REFRESH}`);
    });
    const error = await failure(
      refreshGrant({ clientId: CLIENT_ID, refreshToken: REFRESH, fetch: fake.fetch, now }),
    );
    expect(error.cause).toBeUndefined();
    expectNoSecrets(error);
  });

  it("removes the token from a revocation error", async () => {
    const fake = makeFakeFetch({
      status: 400,
      envelope: { error: "unsupported_token_type", error_description: `token ${ACCESS}` },
    });
    const error = await failure(
      revokeToken({ clientId: CLIENT_ID, token: ACCESS, fetch: fake.fetch }),
    );
    expectNoSecrets(error);
  });
});

describe("broken and hostile token endpoint responses", () => {
  function refreshWith(fetch: FetchLike, refreshToken = REFRESH) {
    return failure(refreshGrant({ clientId: CLIENT_ID, refreshToken, fetch, now }));
  }

  it("retries a response whose body breaks off after the headers", async () => {
    const fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`connection reset after refresh_token=${REFRESH}`));
          },
        }),
        { status: 200 },
      );
    const error = await refreshWith(fetch);
    expect(error.code).toBe(OAUTH_NETWORK_ERROR);
    expect(error.status).toBe(200);
    expect(error.retryable).toBe(true);
    expect(error.reconnectNeeded).toBe(false);
    expectNoSecrets(error);
  });

  it.each([null, 42, { text: "nested" }])(
    "still needs reconnecting on invalid_grant with an error_description of %j",
    async (description) => {
      const fake = makeFakeFetch({
        status: 400,
        envelope: { error: "invalid_grant", error_description: description },
      });
      const error = await refreshWith(fake.fetch);
      expect(error.code).toBe("invalid_grant");
      expect(error.reconnectNeeded).toBe(true);
      expect(error.retryable).toBe(false);
      expect(error.message).not.toContain("nested");
    },
  );

  it("never takes an error code that carries a credential", async () => {
    for (const leaked of formsOf(ODD_REFRESH)) {
      const fake = makeFakeFetch({ status: 400, envelope: { error: `bad ${leaked}` } });
      const error = await refreshWith(fake.fetch, ODD_REFRESH);
      expect(error.code).toBe(OAUTH_INVALID_RESPONSE);
      expectNoSecrets(error);
    }
    const plain = makeFakeFetch({ status: 400, envelope: { error: REFRESH } });
    const error = await refreshWith(plain.fetch);
    expect(error.code).toBe(OAUTH_INVALID_RESPONSE);
    expectNoSecrets(error);
  });

  it.each([
    ["empty", ""],
    ["a quote", 'invalid"grant'],
    ["a backslash", "invalid\\grant"],
    ["a newline", "invalid\ngrant"],
    ["non-ASCII", "invalid_gränt"],
    ["too long", "x".repeat(101)],
  ])("refuses an error code with %s", async (_name, code) => {
    const fake = makeFakeFetch({ status: 400, envelope: { error: code } });
    const error = await refreshWith(fake.fetch);
    expect(error.code).toBe(OAUTH_INVALID_RESPONSE);
    expect(error.reconnectNeeded).toBe(false);
  });

  it("removes the form-encoded and percent-encoded token from a description", async () => {
    const echoed = `got ${new URLSearchParams({ refresh_token: ODD_REFRESH })} and ${encodeURIComponent(ODD_REFRESH)} and ${ODD_REFRESH}`;
    const fake = makeFakeFetch({
      status: 400,
      envelope: { error: "invalid_grant", error_description: echoed },
    });
    const error = await refreshWith(fake.fetch, ODD_REFRESH);
    expect(error.reconnectNeeded).toBe(true);
    expect(error.message).toContain("refresh_token=[redacted]");
    expectNoSecrets(error);
  });

  it("removes the form-encoded token from a network error's message", async () => {
    const fetch: FetchLike = async (_url, init) => {
      throw new Error(`could not send ${String(init?.body)}`);
    };
    const error = await refreshWith(fetch, ODD_REFRESH);
    expect(error.code).toBe(OAUTH_NETWORK_ERROR);
    expect(error.message).toContain("refresh_token=[redacted]");
    expectNoSecrets(error);
  });
});

describe("OAuth state", () => {
  const NONCE = "bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm9u";

  function encodeRaw(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }

  it("encodes base64url JSON with v, n, k and o, in that order", () => {
    const value = encodeOAuthState({
      v: 1,
      n: NONCE,
      k: "reconnect",
      o: "https://apps.example.com",
    });
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(value, "base64url").toString()).toBe(
      `{"v":1,"n":"${NONCE}","k":"reconnect","o":"https://apps.example.com"}`,
    );
  });

  it("round-trips an install and a reconnect", () => {
    const install = createOAuthState("install");
    const reconnect = createOAuthState("reconnect", "http://localhost:5173");
    expect(decodeOAuthState(encodeOAuthState(install))).toEqual(install);
    expect(decodeOAuthState(encodeOAuthState(reconnect))).toEqual(reconnect);
    expect(install).toEqual({
      v: 1,
      n: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      k: "install",
    });
    expect(createOAuthState("install").n).not.toBe(install.n);
  });

  it("refuses to create a reconnect without an allowed origin", () => {
    expect(() => createOAuthState("reconnect", "http://apps.example.com")).toThrow(TypeError);
    expect(() => createOAuthState("reconnect", "")).toThrow(TypeError);
  });

  it("refuses to encode an invalid state", () => {
    expect(() =>
      encodeOAuthState({ v: 1, n: "short", k: "install" } as Parameters<
        typeof encodeOAuthState
      >[0]),
    ).toThrow(TypeError);
  });

  it.each([
    ["empty", ""],
    ["not base64url", "abc+/="],
    ["not JSON", Buffer.from("not json").toString("base64url")],
    ["not UTF-8", Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url")],
    ["too long", "a".repeat(1025)],
    ["another version", encodeRaw({ v: 2, n: NONCE, k: "install" })],
    ["an unknown kind", encodeRaw({ v: 1, n: NONCE, k: "login" })],
    ["an extra field", encodeRaw({ v: 1, n: NONCE, k: "install", x: 1 })],
    ["a short nonce", encodeRaw({ v: 1, n: "abc", k: "install" })],
    ["an install with an origin", encodeRaw({ v: 1, n: NONCE, k: "install", o: "https://a.dev" })],
    ["a reconnect without an origin", encodeRaw({ v: 1, n: NONCE, k: "reconnect" })],
    ["a reconnect to plain http", encodeRaw({ v: 1, n: NONCE, k: "reconnect", o: "http://a.dev" })],
    ["a reconnect to a path", encodeRaw({ v: 1, n: NONCE, k: "reconnect", o: "https://a.dev/x" })],
  ])("decodes %s as null", (_name, value) => {
    expect(decodeOAuthState(value)).toBeNull();
  });

  it.each([
    ["https://appflare.example.com", true],
    ["https://appflare.example.com:8443", true],
    ["http://localhost:3000", true],
    ["http://127.0.0.1:8787", true],
    ["http://localhost", true],
    ["http://example.com", false],
    ["http://localhost.example.com", false],
    ["https://appflare.example.com/", false],
    ["https://appflare.example.com/settings", false],
    ["https://user:pass@appflare.example.com", false],
    ["https://appflare.example.com?x=1", false],
    ["javascript:alert(1)", false],
    ["*", false],
    ["null", false],
  ])("relay origin %s allowed: %s", (origin, allowed) => {
    expect(isOAuthRelayOrigin(origin)).toBe(allowed);
  });
});

describe("manager scopes", () => {
  it("requests every mapped API scope once, then offline_access", () => {
    expect(MANAGER_OAUTH_SCOPES.at(-1)).toBe(OFFLINE_ACCESS_SCOPE);
    expect(MANAGER_OAUTH_SCOPES.slice(0, -1)).toEqual(MANAGER_OAUTH_API_SCOPES);
    expect(new Set(MANAGER_OAUTH_SCOPES).size).toBe(MANAGER_OAUTH_SCOPES.length);
    const mapped = Object.values(MANAGER_OAUTH_SCOPE_BY_GROUP).filter((s) => s !== null);
    expect([...MANAGER_OAUTH_API_SCOPES].sort()).toEqual([...new Set(mapped)].sort());
  });

  it("leaves Billing out: the OAuth catalog has no scope for it", () => {
    expect(MANAGER_OAUTH_SCOPE_BY_GROUP.billing).toBeNull();
    expect(MANAGER_OAUTH_SCOPES.some((s) => s.startsWith("billing"))).toBe(false);
  });

  it("uses dot-delimited catalog ids", () => {
    for (const scope of MANAGER_OAUTH_API_SCOPES) {
      expect(scope).toMatch(/^[a-z0-9-]+\.(read|write)$/);
    }
  });

  it("lists the API scopes a grant lacks", () => {
    expect(missingManagerScopes(MANAGER_OAUTH_SCOPES)).toEqual([]);
    expect(missingManagerScopes(MANAGER_OAUTH_API_SCOPES)).toEqual([]);
    const withoutDns = MANAGER_OAUTH_SCOPES.filter((s) => s !== "dns.write" && s !== "d1.write");
    expect(missingManagerScopes(withoutDns)).toEqual(["d1.write", "dns.write"]);
  });
});
