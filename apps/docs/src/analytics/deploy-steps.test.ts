import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_CALLBACK_VIEWS, SAMPLE_VIEWS } from "../components/deploy/sample-views.ts";
import {
  DeployFlow,
  type DeployView,
  NO_ACCOUNT_ERROR,
  STORAGE_REFUSED_ERROR,
} from "../deploy/flow.ts";
import { installerApi } from "../deploy/installer-api.ts";
import { managerApi } from "../deploy/manager-api.ts";
import { deployStorage, STEPS_KEY } from "../deploy/storage.ts";
import { ACCOUNT_ID, CLIENT_ID, FakeWorld, ORIGIN } from "../deploy/test-fakes.ts";
import { TokenKeeper } from "../deploy/tokens.ts";
import { openMemory } from "../install/memory.ts";
import { fakeStore } from "../install/test-store.ts";
import { POSTHOG_KEY } from "./analytics.ts";
import {
  browserStepCounter,
  CAPTURE_URL,
  callbackStepOf,
  captureBody,
  deployStepOf,
  NO_IP,
  type StepEvent,
  stepCounter,
} from "./deploy-steps.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sample(name: string): DeployView {
  const view = SAMPLE_VIEWS[name];
  if (view === undefined) throw new Error(`no sample ${name}`);
  return view;
}

const welcome = {
  step: "welcome",
  unfinished: false,
  notice: null,
  busy: false,
  error: null,
} as const;

describe("deployStepOf", () => {
  it("follows the journey: intro, consent, account, deploying, deployed", () => {
    expect(deployStepOf(welcome)).toEqual({ step: "intro" });
    expect(deployStepOf({ ...welcome, unfinished: true })).toEqual({ step: "intro" });
    expect(deployStepOf({ ...welcome, busy: true })).toEqual({ step: "consent" });
    for (const name of ["account", "unfinished", "name", "address-domain", "review"]) {
      expect(deployStepOf(sample(name)), name).toEqual({ step: "account" });
    }
    expect(deployStepOf(sample("deploying"))).toEqual({ step: "deploying" });
    expect(deployStepOf(sample("deploying-address"))).toEqual({ step: "deploying" });
    for (const name of ["opening", "opening-notice", "set-up", "set-up-then-app"]) {
      expect(deployStepOf(sample(name)), name).toEqual({ step: "deployed" });
    }
  });

  it("counts nothing for the page starting, waits between steps, or removing an installation", () => {
    for (const name of [
      "loading",
      "working",
      "handing-off",
      "confirm-remove",
      "removing",
      "removed",
    ]) {
      expect(deployStepOf(sample(name)), name).toBeNull();
    }
  });

  it("names an error by its kind, never by its message", () => {
    const kind = (view: DeployView) => deployStepOf(view)?.error_kind;
    expect(kind(sample("unavailable"))).toBe("unavailable");
    expect(kind({ ...welcome, error: STORAGE_REFUSED_ERROR })).toBe("storage-refused");
    expect(kind({ ...welcome, error: "Something went wrong. Try again." })).toBe("connect");
    expect(kind({ ...welcome, notice: "reconnect" })).toBe("reconnect");
    expect(kind({ step: "error", message: "x", retry: "accounts" })).toBe("accounts");
    expect(kind({ step: "error", message: NO_ACCOUNT_ERROR, retry: null })).toBe("no-account");
    expect(kind({ step: "error", message: "The installer no longer has it.", retry: null })).toBe(
      "stopped",
    );
    expect(kind(sample("deploy-failed"))).toMatch(/^deploy-failed:[a-z-]+$/);
    expect(kind({ ...(sample("deploy-failed") as object), progress: null } as DeployView)).toBe(
      "deploy-failed",
    );
    expect(kind(sample("handoff-failed"))).toMatch(/^handoff-[a-z-]+$/);
    expect(kind(sample("opening-not-yet"))).toBe("not-answering");
  });

  it("drops an installer step id that is not a plain word", () => {
    const failed = sample("deploy-failed");
    if (failed.step !== "deploy-failed" || failed.progress === null) throw new Error("sample");
    const odd = {
      ...failed,
      progress: { ...failed.progress, step: { id: "appflare.acme.example", label: "x" } },
    };
    expect(deployStepOf(odd)?.error_kind).toBe("deploy-failed");
  });

  it("never carries anything from the view but the step and a fixed kind", () => {
    const leaks = [
      "0123456789abcdef0123456789abcdef",
      "Acme",
      "acme",
      "appflare.acme.example",
      "https://",
      "key0123",
      "sec0123",
      "claim0123",
    ];
    for (const [name, view] of Object.entries(SAMPLE_VIEWS)) {
      const event = deployStepOf(view);
      if (event === null) continue;
      expect(Object.keys(event).sort(), name).toEqual(
        event.step === "error" ? ["error_kind", "step"] : ["step"],
      );
      const text = JSON.stringify(event);
      for (const leak of leaks) expect(text, name).not.toContain(leak);
    }
  });
});

describe("callbackStepOf", () => {
  it("counts a sign-in that stops at the callback", () => {
    const of = (name: string) => {
      const view = SAMPLE_CALLBACK_VIEWS[name];
      if (view === undefined) throw new Error(`no sample ${name}`);
      return callbackStepOf(view);
    };
    expect(of("callback-declined")).toEqual({ step: "error", error_kind: "declined" });
    expect(of("callback-unknown-session")).toEqual({
      step: "error",
      error_kind: "callback-unknown-session",
    });
    expect(of("callback-missing-scopes")).toEqual({
      step: "error",
      error_kind: "callback-missing-scopes",
    });
    expect(
      callbackStepOf({ step: "problem", problem: { kind: "refused", retryable: true, code: "x" } }),
    ).toEqual({ step: "error", error_kind: "callback-refused" });
  });

  it("counts nothing of a manager's Reconnect Cloudflare, or a sign-in that went on", () => {
    for (const name of [
      "callback-working",
      "callback-confirm-return",
      "callback-returning",
      "callback-cancelled",
    ]) {
      const view = SAMPLE_CALLBACK_VIEWS[name];
      if (view === undefined) throw new Error(`no sample ${name}`);
      expect(callbackStepOf(view), name).toBeNull();
    }
    expect(callbackStepOf({ step: "done" })).toBeNull();
    // Either kind of sign-in can end like this, so neither is counted.
    expect(callbackStepOf({ step: "problem", problem: "invalid-state" })).toBeNull();
    expect(callbackStepOf({ step: "problem", problem: "missing-code" })).toBeNull();
  });
});

describe("captureBody", () => {
  const ID = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

  it("is the step, the attempt's id, and PostHog's switches, and nothing else", () => {
    expect(JSON.parse(captureBody({ step: "consent" }, ID))).toEqual({
      api_key: POSTHOG_KEY,
      event: "deploy_step",
      distinct_id: ID,
      properties: {
        step: "consent",
        $process_person_profile: false,
        $ip: NO_IP,
        $geoip_disable: true,
      },
    });
    expect(
      JSON.parse(captureBody({ step: "error", error_kind: "deploy-failed:worker" }, ID)).properties,
    ).toEqual({
      step: "error",
      error_kind: "deploy-failed:worker",
      $process_person_profile: false,
      $ip: NO_IP,
      $geoip_disable: true,
    });
  });

  it("goes to PostHog's EU endpoint for single events", () => {
    expect(CAPTURE_URL).toBe("https://eu.i.posthog.com/i/v0/e/");
  });
});

describe("stepCounter", () => {
  function counter(session = fakeStore()) {
    const sent: Array<{ distinct_id: string; properties: Record<string, unknown> }> = [];
    const ids = ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"];
    const count = stepCounter({
      slot: deployStorage(
        () => session,
        () => fakeStore(),
      ).steps,
      send: (body) => sent.push(JSON.parse(body)),
      newId: () => ids.shift() ?? "00000000-0000-4000-8000-0000000000ff",
    });
    const steps = () => sent.map((e) => [e.properties.step, e.properties.error_kind ?? null]);
    return { count, sent, session, steps };
  }

  it("counts each step once, an error once per kind, under one id across the trip to Cloudflare", () => {
    const page = counter();
    for (const event of [
      { step: "intro" },
      { step: "intro" },
      { step: "consent" },
      null,
    ] as Array<StepEvent | null>) {
      page.count(event);
    }
    // Back from Cloudflare: a new page in the same tab.
    const back = counter(page.session);
    for (const event of [
      { step: "account" },
      { step: "account" },
      { step: "deploying" },
      { step: "error", error_kind: "deploy-failed:worker" },
      { step: "error", error_kind: "deploy-failed:worker" },
      { step: "deploying" },
      { step: "error", error_kind: "handoff-busy" },
      { step: "deployed" },
    ] as StepEvent[]) {
      back.count(event);
    }
    expect(page.steps()).toEqual([
      ["intro", null],
      ["consent", null],
    ]);
    expect(back.steps()).toEqual([
      ["account", null],
      ["deploying", null],
      ["error", "deploy-failed:worker"],
      ["error", "handoff-busy"],
      ["deployed", null],
    ]);
    const ids = new Set([...page.sent, ...back.sent].map((e) => e.distinct_id));
    expect(ids).toEqual(new Set(["00000000-0000-4000-8000-00000000000a"]));
  });

  it("starts a new attempt at the first screen once one is deployed", () => {
    const page = counter();
    page.count({ step: "intro" });
    page.count({ step: "deployed" });
    page.count({ step: "deployed" });
    page.count({ step: "error", error_kind: "not-answering" });
    page.count({ step: "intro" });
    expect(page.steps()).toEqual([
      ["intro", null],
      ["deployed", null],
      ["error", "not-answering"],
      ["intro", null],
    ]);
    expect(page.sent.map((e) => e.distinct_id)).toEqual([
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
    ]);
  });

  it("keeps the attempt for the page alone in a browser that keeps nothing", () => {
    const page = counter(fakeStore({}, true));
    page.count({ step: "intro" });
    page.count({ step: "intro" });
    page.count({ step: "consent" });
    expect(page.steps()).toEqual([
      ["intro", null],
      ["consent", null],
    ]);
    expect(new Set(page.sent.map((e) => e.distinct_id)).size).toBe(1);
  });

  it("keeps only the id and the steps in this tab", () => {
    const page = counter();
    page.count({ step: "intro" });
    expect(JSON.parse(page.session.data.get(STEPS_KEY) ?? "{}")).toEqual({
      id: "00000000-0000-4000-8000-00000000000a",
      sent: ["intro"],
    });
  });
});

describe("browserStepCounter", () => {
  const slot = () =>
    deployStorage(
      () => fakeStore(),
      () => fakeStore(),
    ).steps;

  function browserAt(hostname: string) {
    const fetch = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("window", { location: { hostname } });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("sends nothing from a local server or a preview", () => {
    const fetch = browserAt("localhost");
    browserStepCounter(slot())({ step: "intro" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends one plain-text request without cookies or a referrer from the public address", () => {
    const fetch = browserAt("appflare.dev");
    browserStepCounter(slot())({ step: "intro" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CAPTURE_URL);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.parse(String(init.body)).properties.step).toBe("intro");
  });

  it("never falls back to sendBeacon, which would send cookies", () => {
    const fetch = browserAt("appflare.dev");
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal("Request", class {});
    browserStepCounter(slot())({ step: "intro" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe("a whole install, counted", () => {
  /** The deploy page's flow over a fake Cloudflare, installer and Appflare, with its steps counted. */
  function page(session: ReturnType<typeof fakeStore>, signedIn: boolean) {
    const world = new FakeWorld();
    const local = fakeStore();
    const storage = deployStorage(
      () => session,
      () => local,
    );
    let clock = 1_800_000_000_000;
    if (signedIn) {
      storage.grant.write({
        clientId: CLIENT_ID,
        accessToken: "access-1",
        expiresAt: clock + 3_600_000,
        refreshToken: "refresh-1",
        scopes: [...MANAGER_OAUTH_SCOPES],
      });
    }
    const tokens = new TokenKeeper({ slot: storage.grant, fetch: world.fetch, now: () => clock });
    const flow = new DeployFlow({
      setup: { ok: true, clientId: CLIENT_ID, redirectUri: `${ORIGIN}/deploy/callback` },
      storage,
      tokens,
      api: installerApi({ fetch: world.fetch, accessToken: () => tokens.accessToken() }),
      manager: managerApi(world.fetch),
      origin: ORIGIN,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      navigate: () => {},
      search: "?app=glance",
      memory: openMemory(() => local),
    });
    const bodies: string[] = [];
    const count = stepCounter({
      slot: storage.steps,
      send: (body) => bodies.push(body),
      newId: () => "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    });
    flow.subscribe(() => count(deployStepOf(flow.state())));
    return { flow, bodies, world, storage };
  }

  it("sends intro, consent, account, deploying and deployed, and nothing about the visitor", async () => {
    const session = fakeStore();
    const before = page(session, false);
    before.flow.start();
    await before.flow.connect();
    // Cloudflare sends the tab back signed in: a new page, the same tab.
    const after = page(session, true);
    after.flow.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await after.flow.submitName();
    await after.flow.submitAddress();
    await after.flow.deploy();
    expect(after.flow.state().step).toBe("opening");

    const bodies = [...before.bodies, ...after.bodies];
    const sent = bodies.map((body) => JSON.parse(body));
    expect(sent.map((e) => e.properties.step)).toEqual([
      "intro",
      "consent",
      "account",
      "deploying",
      "deployed",
    ]);
    expect(new Set(sent.map((e) => e.distinct_id)).size).toBe(1);
    const installation = [...after.world.installations.values()][0];
    const secrets = [
      ACCOUNT_ID,
      "appflare.example.com",
      "glance",
      "access-1",
      "refresh-1",
      CLIENT_ID,
      installation?.key ?? "missing",
      installation?.id ?? "missing",
      after.storage.installation.read()?.handoffSecret ?? "no-secret-kept",
    ];
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret);
    }
  });
});
