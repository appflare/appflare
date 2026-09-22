import { describe, expect, it } from "vitest";
import { appGate, type GateState, setupGate } from "./gate";

const state = (over: Partial<GateState>): GateState => ({
  hasUser: true,
  signedIn: true,
  isAdmin: true,
  tokenConfigured: true,
  ...over,
});

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

  it("sends everyone to /setup before the first admin exists", () => {
    expect(appGate(state({ hasUser: false, signedIn: false, tokenConfigured: false }))).toEqual({
      redirect: "/setup",
    });
  });

  it("lets signed-in users through once configured", () => {
    expect(appGate(state({}))).toEqual({ allow: true });
    expect(appGate(state({ isAdmin: false }))).toEqual({ allow: true });
  });
});

describe("setupGate (/setup)", () => {
  it("creates the first admin before any user exists", () => {
    expect(setupGate(state({ hasUser: false, signedIn: false, tokenConfigured: false }))).toEqual({
      step: "create-admin",
    });
  });

  it("requires a session once a user exists", () => {
    expect(setupGate(state({ signedIn: false, tokenConfigured: false }))).toEqual({
      redirect: "/login",
    });
  });

  it("shows admins the token step while unconfigured", () => {
    expect(setupGate(state({ tokenConfigured: false }))).toEqual({ step: "cloudflare-token" });
  });

  it("tells members to wait for an admin instead of looping", () => {
    expect(setupGate(state({ isAdmin: false, tokenConfigured: false }))).toEqual({
      step: "wait-for-admin",
    });
  });

  it("redirects to / once configured", () => {
    expect(setupGate(state({}))).toEqual({ redirect: "/" });
  });
});
