import { describe, expect, it } from "vitest";
import { appGate, type GateState, setupGate } from "./gate";

const state = (over: Partial<GateState>): GateState => ({
  hasUser: true,
  signedIn: true,
  isAdmin: true,
  tokenConfigured: true,
  setupClaimed: false,
  authReady: true,
  ...over,
});

const fresh = (over: Partial<GateState> = {}) =>
  state({ hasUser: false, signedIn: false, isAdmin: false, tokenConfigured: false, ...over });

describe("appGate (every signed-in page)", () => {
  it("sends visitors without a session to /login", () => {
    expect(appGate(state({ signedIn: false, isAdmin: false }))).toEqual({ redirect: "/login" });
  });

  it("sends an admin to /setup until the token is configured", () => {
    expect(appGate(state({ tokenConfigured: false }))).toEqual({ redirect: "/setup" });
  });

  it("sends members to /setup too until the token is configured", () => {
    expect(appGate(state({ isAdmin: false, tokenConfigured: false }))).toEqual({
      redirect: "/setup",
    });
  });

  it("sends everyone to /setup before the owner exists, even once the token is stored", () => {
    expect(appGate(fresh())).toEqual({ redirect: "/setup" });
    expect(appGate(fresh({ tokenConfigured: true, setupClaimed: true }))).toEqual({
      redirect: "/setup",
    });
  });

  it("lets signed-in users through once configured", () => {
    expect(appGate(state({}))).toEqual({ allow: true });
    expect(appGate(state({ isAdmin: false }))).toEqual({ allow: true });
  });
});

describe("setupGate (/setup)", () => {
  it("starts with the Cloudflare token on a fresh manager", () => {
    expect(setupGate(fresh())).toEqual({ step: "connect" });
  });

  it("creates the owner only in the browser that connected Cloudflare", () => {
    expect(setupGate(fresh({ tokenConfigured: true, setupClaimed: true }))).toEqual({
      step: "create-owner",
    });
    // Another visitor, or the same one after the claim expired, sees only the token step.
    expect(setupGate(fresh({ tokenConfigured: true, setupClaimed: false }))).toEqual({
      step: "connect",
    });
    // A claim without a stored token (cleared settings) is not enough.
    expect(setupGate(fresh({ setupClaimed: true }))).toEqual({ step: "connect" });
  });

  it("waits for the version with the new auth secret before creating the owner", () => {
    // A manager deployed without secrets: connecting Cloudflare wrote one, and
    // the request still runs on the version without it.
    expect(
      setupGate(fresh({ tokenConfigured: true, setupClaimed: true, authReady: false })),
    ).toEqual({ step: "redeploying" });
    // Other visitors still see only the token step.
    expect(setupGate(fresh({ tokenConfigured: true, authReady: false }))).toEqual({
      step: "connect",
    });
    expect(setupGate(fresh({ authReady: false }))).toEqual({ step: "connect" });
  });

  it("sends everyone else to sign in once the owner exists", () => {
    expect(setupGate(state({ signedIn: false, isAdmin: false }))).toEqual({ redirect: "/login" });
    expect(setupGate(state({ signedIn: false, isAdmin: false }), { checklist: true })).toEqual({
      redirect: "/login",
    });
  });

  it("shows the checklist to a signed-in admin who asks for it, else goes home", () => {
    expect(setupGate(state({}), { checklist: true })).toEqual({ step: "checklist" });
    expect(setupGate(state({}))).toEqual({ redirect: "/" });
    expect(setupGate(state({ isAdmin: false }), { checklist: true })).toEqual({ redirect: "/" });
  });

  it("keeps the token step for a manager whose admin was created before its token", () => {
    expect(setupGate(state({ tokenConfigured: false }))).toEqual({ step: "cloudflare-token" });
    expect(setupGate(state({ isAdmin: false, tokenConfigured: false }))).toEqual({
      step: "wait-for-admin",
    });
  });
});
