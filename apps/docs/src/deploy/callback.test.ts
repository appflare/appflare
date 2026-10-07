import {
  createOAuthState,
  encodeOAuthState,
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPES,
} from "@appflare/cf-api/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStore } from "../install/test-store.ts";
import type { CallbackParams } from "./arrival.ts";
import { decideCallback } from "./authorize.ts";
import { type FormDocument, returnForm, runCallback, submitReturn } from "./callback.ts";
import {
  AUTHORIZATION_KEY,
  deployStorage,
  GRANT_KEY,
  type PendingAuthorization,
} from "./storage.ts";
import { CLIENT_ID, ORIGIN } from "./test-fakes.ts";
import { TokenKeeper } from "./tokens.ts";

const MANAGER = "https://appflare.example.com";
const CODE = "code-DO-NOT-LEAK-123";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function installState(): { state: string; pending: PendingAuthorization } {
  const state = createOAuthState("install");
  return {
    state: encodeOAuthState(state),
    pending: {
      nonce: state.n,
      verifier: "v".repeat(43),
      clientId: CLIENT_ID,
      redirectUri: `${ORIGIN}/deploy/callback`,
      startedAt: 0,
    },
  };
}

function reconnectState(origin = MANAGER): string {
  return encodeOAuthState(createOAuthState("reconnect", origin));
}

function params(over: Partial<CallbackParams>): CallbackParams {
  return { code: null, state: null, error: null, ...over };
}

describe("decideCallback: a manager's reconnect", () => {
  it("asks to confirm returning the code to exactly the state's origin", () => {
    const state = reconnectState();
    expect(decideCallback(params({ code: CODE, state }), null)).toEqual({
      kind: "confirm-return",
      origin: MANAGER,
      fields: { code: CODE, state },
    });
  });

  it("returns a refusal as its OAuth error code only", () => {
    const state = reconnectState();
    expect(decideCallback(params({ error: "access_denied", state }), null)).toEqual({
      kind: "confirm-return",
      origin: MANAGER,
      fields: { error: "access_denied", state },
    });
  });

  it("allows http only on localhost", () => {
    const local = reconnectState("http://localhost:5173");
    expect(decideCallback(params({ code: CODE, state: local }), null)).toMatchObject({
      kind: "confirm-return",
      origin: "http://localhost:5173",
    });
  });

  it.each([
    ["an http origin", { v: 1, n: "n".repeat(43), k: "reconnect", o: "http://evil.example" }],
    ["an origin with a path", { v: 1, n: "n".repeat(43), k: "reconnect", o: `${MANAGER}/x` }],
    ["a javascript: origin", { v: 1, n: "n".repeat(43), k: "reconnect", o: "javascript:alert(1)" }],
    ["a wildcard", { v: 1, n: "n".repeat(43), k: "reconnect", o: "*" }],
    ["no origin", { v: 1, n: "n".repeat(43), k: "reconnect" }],
    ["an extra field", { v: 1, n: "n".repeat(43), k: "reconnect", o: MANAGER, x: 1 }],
    ["a short nonce", { v: 1, n: "short", k: "reconnect", o: MANAGER }],
    ["another version", { v: 2, n: "n".repeat(43), k: "reconnect", o: MANAGER }],
  ])("returns nothing for a state with %s", (_name, raw) => {
    const decision = decideCallback(params({ code: CODE, state: base64urlJson(raw) }), null);
    expect(decision).toEqual({ kind: "problem", problem: "invalid-state" });
  });

  it("returns nothing for a missing or garbled state", () => {
    expect(decideCallback(params({ code: CODE }), null).kind).toBe("problem");
    expect(decideCallback(params({ code: CODE, state: "%%%" }), null).kind).toBe("problem");
  });

  it("does not pass on an error that is not an OAuth error code", () => {
    const state = reconnectState();
    expect(decideCallback(params({ error: 'bad"value', state }), null)).toEqual({
      kind: "problem",
      problem: "missing-code",
    });
  });
});

describe("decideCallback: a deploy sign-in", () => {
  it("exchanges the code when the nonce is the one this tab kept", () => {
    const { state, pending } = installState();
    expect(decideCallback(params({ code: CODE, state }), pending)).toEqual({
      kind: "exchange",
      code: CODE,
      pending,
    });
  });

  it("refuses a sign-in this tab did not start, or one already used", () => {
    const { state } = installState();
    const other = installState().pending;
    expect(decideCallback(params({ code: CODE, state }), other)).toEqual({
      kind: "problem",
      problem: "unknown-session",
    });
    expect(decideCallback(params({ code: CODE, state }), null)).toEqual({
      kind: "problem",
      problem: "unknown-session",
    });
  });

  it("reports consent refused at Cloudflare", () => {
    const { state, pending } = installState();
    expect(decideCallback(params({ error: "access_denied", state }), pending)).toEqual({
      kind: "declined",
      error: "access_denied",
    });
  });
});

function tokenFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return Response.json(body, { status });
  };
  return { fetch, calls };
}

describe("runCallback", () => {
  function setup(pending: PendingAuthorization | null) {
    const session = fakeStore();
    const local = fakeStore();
    const storage = deployStorage(
      () => session,
      () => local,
    );
    if (pending !== null) storage.authorization.write(pending);
    const navigations: string[] = [];
    return {
      session,
      local,
      navigations,
      deps: {
        storage,
        tokens: new TokenKeeper({ slot: storage.grant }),
        navigate: (url: string) => navigations.push(url),
        now: () => 1_000,
      },
    };
  }

  it("exchanges the code in the browser, keeps the grant in this tab and goes back to /deploy/", async () => {
    const { state, pending } = installState();
    const s = setup(pending);
    const token = tokenFetch({
      access_token: "access-x",
      expires_in: 3600,
      refresh_token: "refresh-x",
      scope: MANAGER_OAUTH_SCOPES.join(" "),
    });
    const view = await runCallback({
      ...s.deps,
      params: params({ code: CODE, state }),
      fetch: token.fetch,
    });
    expect(view).toEqual({ step: "done" });
    expect(s.navigations).toEqual(["/deploy/"]);
    expect(token.calls[0]?.url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(new URLSearchParams(token.calls[0]?.body).get("code_verifier")).toBe(pending.verifier);
    expect(JSON.parse(s.session.data.get(GRANT_KEY) ?? "{}")).toMatchObject({
      accessToken: "access-x",
      refreshToken: "refresh-x",
      expiresAt: 1_000 + 3_600_000,
    });
    // Used once: the pending sign-in is gone, and nothing reached localStorage.
    expect(s.session.data.has(AUTHORIZATION_KEY)).toBe(false);
    expect(s.local.data.size).toBe(0);
    expect(s.navigations.join()).not.toContain(CODE);
  });

  it("refuses a grant without every permission Appflare needs, keeping nothing", async () => {
    const { state, pending } = installState();
    const s = setup(pending);
    const token = tokenFetch({
      access_token: "access-x",
      expires_in: 3600,
      refresh_token: "refresh-x",
      scope: MANAGER_OAUTH_API_SCOPES.slice(1).join(" "),
    });
    const view = await runCallback({
      ...s.deps,
      params: params({ code: CODE, state }),
      fetch: token.fetch,
    });
    expect(view).toEqual({
      step: "problem",
      problem: { kind: "missing-scopes", missing: [MANAGER_OAUTH_API_SCOPES[0]] },
    });
    expect(s.session.data.has(GRANT_KEY)).toBe(false);
    expect(s.navigations).toEqual([]);
  });

  it("refuses a grant without a refresh token", async () => {
    const { state, pending } = installState();
    const s = setup(pending);
    const token = tokenFetch({ access_token: "access-x", expires_in: 3600 });
    const view = await runCallback({
      ...s.deps,
      params: params({ code: CODE, state }),
      fetch: token.fetch,
    });
    expect(view).toEqual({ step: "problem", problem: { kind: "no-refresh-token" } });
  });

  it("says when Cloudflare refuses the code, without repeating it", async () => {
    const { state, pending } = installState();
    const s = setup(pending);
    const token = tokenFetch({ error: "invalid_grant" }, 400);
    const view = await runCallback({
      ...s.deps,
      params: params({ code: CODE, state }),
      fetch: token.fetch,
    });
    expect(view).toEqual({
      step: "problem",
      problem: { kind: "refused", retryable: false, code: "invalid_grant" },
    });
    expect(JSON.stringify(view)).not.toContain(CODE);
    expect(s.session.data.has(AUTHORIZATION_KEY)).toBe(false);
  });

  it("asks before returning a reconnect, exchanging and sending nothing by itself", async () => {
    const s = setup(null);
    const state = reconnectState();
    const token = tokenFetch({});
    const view = await runCallback({
      ...s.deps,
      params: params({ code: CODE, state }),
      fetch: token.fetch,
    });
    expect(view).toEqual({
      step: "confirm-return",
      origin: MANAGER,
      fields: { code: CODE, state },
    });
    expect(token.calls).toEqual([]);
    expect(s.navigations).toEqual([]);
    expect(s.session.data.size).toBe(0);
  });

  it("keeps a deploy sign-in in progress when a reconnect lands in the same tab", async () => {
    const { pending } = installState();
    const s = setup(pending);
    await runCallback({ ...s.deps, params: params({ code: CODE, state: reconnectState() }) });
    expect(s.session.data.has(AUTHORIZATION_KEY)).toBe(true);
  });
});

describe("returning a reconnect to the manager", () => {
  it("posts code and state, or error and state, to the manager's return route", () => {
    expect(returnForm(MANAGER, { code: CODE, state: "s" })).toEqual({
      action: "https://appflare.example.com/api/cloudflare/oauth-return",
      fields: [
        ["code", CODE],
        ["state", "s"],
      ],
    });
    expect(returnForm(MANAGER, { error: "access_denied", state: "s" }).fields).toEqual([
      ["error", "access_denied"],
      ["state", "s"],
    ]);
  });

  it("builds the form only when asked, as a url-encoded POST, and submits it", () => {
    const made: Array<Record<string, unknown>> = [];
    const appended: unknown[] = [];
    let submitted = false;
    const element = (tag: string) => {
      const node: Record<string, unknown> = {
        tag,
        children: [] as unknown[],
        append(child: unknown) {
          (node.children as unknown[]).push(child);
        },
        submit() {
          submitted = true;
        },
      };
      made.push(node);
      return node;
    };
    const doc = {
      createElement: element,
      body: { append: (node: unknown) => appended.push(node) },
    } as unknown as FormDocument;
    submitReturn(doc, MANAGER, { code: CODE, state: "s" });
    const [form, ...inputs] = made;
    expect(form).toMatchObject({
      tag: "form",
      method: "post",
      action: "https://appflare.example.com/api/cloudflare/oauth-return",
      enctype: "application/x-www-form-urlencoded",
    });
    expect(inputs.map((i) => [i.type, i.name, i.value])).toEqual([
      ["hidden", "code", CODE],
      ["hidden", "state", "s"],
    ]);
    expect(String(form?.action)).not.toContain(CODE);
    expect(appended).toEqual([form]);
    expect(submitted).toBe(true);
  });
});

describe("arrival", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function browserAt(url: string) {
    const location = new URL(url);
    const replaced: string[] = [];
    vi.stubGlobal("window", {
      location,
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, next: string) => {
          replaced.push(next);
          const target = new URL(next, location.origin);
          location.search = target.search;
          location.hash = target.hash;
        },
      },
    });
    return replaced;
  }

  it("takes code and state out of the address bar before anything else, keeping them in memory", async () => {
    const replaced = browserAt(`${ORIGIN}/deploy/callback?code=${CODE}&state=abc`);
    const arrival = await import("./arrival.ts");
    expect(replaced).toEqual(["/deploy/callback"]);
    expect(arrival.arrivedCallbackParams()).toEqual({ code: CODE, state: "abc", error: null });
    expect(arrival.openedAt).toBe("/deploy/callback");
    arrival.forgetCallbackParams();
    expect(arrival.arrivedCallbackParams()).toBeNull();
  });

  it("leaves every other page's address alone", async () => {
    const replaced = browserAt(`${ORIGIN}/install/?repo=a/b&code=1`);
    const arrival = await import("./arrival.ts");
    expect(replaced).toEqual([]);
    expect(arrival.arrivedCallbackParams()).toBeNull();
  });

  it("takes a parameter given twice as missing", async () => {
    const { readCallbackParams } = await import("./arrival.ts");
    expect(readCallbackParams("?code=a&code=b&state=s")).toEqual({
      code: null,
      state: "s",
      error: null,
    });
  });
});
