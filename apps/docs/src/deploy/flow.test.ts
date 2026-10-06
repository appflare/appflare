import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { describe, expect, it, vi } from "vitest";
import { fakeStore } from "../install/test-store.ts";
import type { OAuthSetup } from "./config.ts";
import {
  DeployFlow,
  type DeployView,
  EXPLAIN_WAIT_AFTER_MS,
  MIN_CHECK_MS,
  OFFER_WORKERS_DEV_AFTER_MS,
} from "./flow.ts";
import { installerApi, type StepAnswer } from "./installer-api.ts";
import { managerApi } from "./manager-api.ts";
import { AUTHORIZATION_KEY, deployStorage, GRANT_KEY, INSTALLATION_KEY } from "./storage.ts";
import {
  ACCOUNT_ID,
  CLIENT_ID,
  DEFAULT_STEPS,
  FakeWorld,
  ORIGIN,
  OTHER_ACCOUNT_ID,
} from "./test-fakes.ts";
import { TokenKeeper } from "./tokens.ts";

const START = 1_800_000_000_000;

interface Options {
  signedIn?: boolean;
  /** Milliseconds the first access token has left. */
  tokenLife?: number;
  setup?: OAuthSetup;
  /** Pauses for which this says true never end (a deploy that waits for good). */
  block?: (ms: number, count: number) => boolean;
  onPause?: (count: number) => void;
}

function harness(world = new FakeWorld(), options: Options = {}) {
  const session = fakeStore();
  const local = fakeStore();
  const storage = deployStorage(
    () => session,
    () => local,
  );
  let clock = START;
  const now = () => clock;
  if (options.signedIn !== false) {
    storage.grant.write({
      clientId: CLIENT_ID,
      accessToken: "access-1",
      expiresAt: START + (options.tokenLife ?? 3_600_000),
      refreshToken: "refresh-1",
      scopes: [...MANAGER_OAUTH_SCOPES],
    });
  }
  const tokens = new TokenKeeper({ slot: storage.grant, fetch: world.fetch, now });
  const navigations: string[] = [];
  let pauses = 0;
  const flow = new DeployFlow({
    setup: options.setup ?? {
      ok: true,
      clientId: CLIENT_ID,
      redirectUri: `${ORIGIN}/deploy/callback`,
    },
    storage,
    tokens,
    api: installerApi({ fetch: world.fetch, accessToken: () => tokens.accessToken() }),
    manager: managerApi(world.fetch),
    origin: ORIGIN,
    now,
    sleep: async (ms) => {
      clock += ms;
      pauses++;
      options.onPause?.(pauses);
      if (options.block?.(ms, pauses)) {
        await new Promise(() => {});
      }
    },
    navigate: (url) => navigations.push(url),
  });
  return { world, flow, storage, session, local, tokens, navigations, now };
}

function view<S extends DeployView["step"]>(
  flow: DeployFlow,
  step: S,
): Extract<DeployView, { step: S }> {
  const current = flow.state();
  expect(current.step).toBe(step);
  return current as Extract<DeployView, { step: S }>;
}

/** Every value that must never appear in a URL, a log or localStorage. */
function secretsOf(h: ReturnType<typeof harness>): string[] {
  const out = ["access-1", "access-2", "access-3", "refresh-1", "refresh-2", "refresh-3"];
  for (const i of h.world.installations.values()) out.push(i.key);
  const local = h.storage.installation.read();
  if (local !== null) out.push(local.handoffSecret);
  return out;
}

function expectCleanUrls(h: ReturnType<typeof harness>, extra: string[] = []) {
  const secrets = [...secretsOf(h), ...extra];
  for (const url of [...h.world.requests.map((r) => r.url), ...h.navigations]) {
    for (const secret of secrets) expect(url, url).not.toContain(secret);
  }
}

/** The installer never gets the refresh token, in any header or body. */
function expectNoRefreshTokenAtInstaller(h: ReturnType<typeof harness>) {
  for (const request of h.world.requests.filter((r) => r.url.startsWith("/api/install/"))) {
    const text = JSON.stringify(request);
    expect(text).not.toMatch(/refresh-\d/);
  }
}

/** localStorage holds the unfinished installation and nothing else, and never a token. */
function expectLocalStorageRules(h: ReturnType<typeof harness>) {
  for (const [key, value] of h.local.data) {
    expect(key).toBe(INSTALLATION_KEY);
    expect(Object.keys(JSON.parse(value)).sort()).toEqual([
      "accountId",
      "handoffSecret",
      "installationId",
      "key",
    ]);
    expect(value).not.toMatch(/access-\d|refresh-\d/);
  }
}

async function toReview(h: ReturnType<typeof harness>) {
  await h.flow.loadAccounts();
  view(h.flow, "name");
  await h.flow.submitName();
  view(h.flow, "address");
  await h.flow.submitAddress();
  return view(h.flow, "review");
}

describe("arrival", () => {
  it("says the page cannot sign in at an address Cloudflare does not return to", () => {
    const h = harness(undefined, { setup: { ok: false, reason: "unregistered-origin" } });
    h.flow.start();
    expect(view(h.flow, "unavailable").reason).toBe("unregistered-origin");
  });

  it("asks to connect Cloudflare first, and mentions an unfinished installation", () => {
    const h = harness(undefined, { signedIn: false });
    h.flow.start();
    expect(view(h.flow, "welcome").unfinished).toBe(false);
    h.storage.installation.write({
      installationId: "00000000-0000-4000-8000-000000000009",
      key: "k".repeat(43),
      handoffSecret: "s".repeat(43),
      accountId: ACCOUNT_ID,
    });
    h.flow.start();
    expect(view(h.flow, "welcome").unfinished).toBe(true);
  });

  it("sends Connect Cloudflare to Cloudflare with PKCE, keeping the verifier in this tab only", async () => {
    const h = harness(undefined, { signedIn: false });
    h.flow.start();
    await h.flow.connect();
    const [target] = h.navigations;
    const url = new URL(target ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/deploy/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...MANAGER_OAUTH_SCOPES]);
    const pending = JSON.parse(h.session.data.get(AUTHORIZATION_KEY) ?? "{}");
    expect(target).not.toContain(pending.verifier);
    expect(h.local.data.size).toBe(0);
  });

  it("explains a browser that keeps nothing, instead of leaving for Cloudflare", async () => {
    const world = new FakeWorld();
    const storage = deployStorage(
      () => fakeStore({}, true),
      () => fakeStore({}, true),
    );
    const navigations: string[] = [];
    const flow = new DeployFlow({
      setup: { ok: true, clientId: CLIENT_ID, redirectUri: `${ORIGIN}/deploy/callback` },
      storage,
      tokens: new TokenKeeper({ slot: storage.grant }),
      api: installerApi({ fetch: world.fetch, accessToken: async () => "x" }),
      manager: managerApi(world.fetch),
      origin: ORIGIN,
      now: () => START,
      sleep: async () => {},
      navigate: (url) => navigations.push(url),
    });
    flow.start();
    await flow.connect();
    expect(navigations).toEqual([]);
    expect(view(flow, "welcome").error).toMatch(/does not let the page keep anything/);
  });
});

describe("the whole journey", () => {
  it("deploys, checks the proof, hands the grant to Appflare and opens owner setup", async () => {
    const h = harness();
    const review = await toReview(h);
    expect(review.plan).toMatchObject({
      workerName: "appflare",
      hostname: "appflare.example.com",
      address: "https://appflare.example.com",
    });
    expect(review.release).toBe("0.4.2");

    await h.flow.deploy();

    expect(h.navigations).toEqual([
      "https://appflare.example.com/setup#claim=claim0123456789abcdef",
    ]);
    const [installation] = h.world.installations.values();
    const manager = h.world.managers.get("https://appflare.example.com");
    expect(manager?.received).toEqual({
      secret: h.storage.installation.read()?.handoffSecret,
      grant: { refreshToken: "refresh-1", clientId: CLIENT_ID, scopes: [...MANAGER_OAUTH_SCOPES] },
      accountId: ACCOUNT_ID,
      installer: { url: ORIGIN, installationId: installation?.id, key: installation?.key },
    });
    // The proof came first, then the only POST.
    const managerCalls = h.world.requests.filter((r) =>
      r.url.startsWith("https://appflare.example.com"),
    );
    expect(managerCalls.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(managerCalls[0]?.url).toMatch(/\/api\/handoff\?challenge=[A-Za-z0-9_-]{32}$/);
    // The tab forgets the grant once Appflare has it.
    expect(h.tokens.grant()).toBeNull();
    expect(h.session.data.has(GRANT_KEY)).toBe(false);
    expect(view(h.flow, "opening").address).toBe("https://appflare.example.com");
    expectNoRefreshTokenAtInstaller(h);
    expectLocalStorageRules(h);
    expectCleanUrls(h);
  });

  it("sends the access token, never the refresh token, to the installer", async () => {
    const h = harness();
    await toReview(h);
    await h.flow.deploy();
    const installerCalls = h.world.requests.filter((r) => r.url.startsWith("/api/install/"));
    expect(installerCalls.length).toBeGreaterThan(5);
    for (const call of installerCalls) expect(call.headers.authorization).toBe("Bearer access-1");
    expectNoRefreshTokenAtInstaller(h);
  });

  it("offers an account choice only when the sign-in reaches several", async () => {
    const world = new FakeWorld();
    world.accounts.push({ id: OTHER_ACCOUNT_ID, name: "Side account", workersDevSubdomain: null });
    const h = harness(world);
    await h.flow.loadAccounts();
    expect(view(h.flow, "account").accounts.map((a) => a.name)).toEqual([
      "Main account",
      "Side account",
    ]);
    await h.flow.chooseAccount(OTHER_ACCOUNT_ID);
    expect(view(h.flow, "name").account.name).toBe("Side account");
    expect(h.flow.canGoBack()).toBe(true);
    await h.flow.back();
    view(h.flow, "account");
  });

  it("refuses a name in use and a malformed one, in plain words", async () => {
    const world = new FakeWorld();
    world.takenNames.add("appflare");
    const h = harness(world);
    await h.flow.loadAccounts();
    await h.flow.submitName();
    expect(view(h.flow, "name").error).toMatch(/already uses the name "appflare"/);
    h.flow.editName("Not A Name!");
    await h.flow.submitName();
    expect(view(h.flow, "name").error).toMatch(/lowercase letters/);
    h.flow.editName("team-appflare");
    await h.flow.submitName();
    expect(view(h.flow, "address").workerName).toBe("team-appflare");
  });

  it("proposes appflare.<domain>, takes another subdomain, and shows a conflict", async () => {
    const world = new FakeWorld();
    world.takenHosts.set("appflare.example.com", "appflare.example.com already has a DNS record.");
    const h = harness(world);
    await h.flow.loadAccounts();
    await h.flow.submitName();
    expect(view(h.flow, "address").choice).toEqual({
      kind: "domain",
      zone: "example.com",
      subdomain: "appflare",
    });
    await h.flow.submitAddress();
    expect(view(h.flow, "address").error).toBe("appflare.example.com already has a DNS record.");
    h.flow.chooseAddress({ kind: "domain", zone: "example.com", subdomain: "Apps.Team" });
    await h.flow.submitAddress();
    expect(view(h.flow, "review").plan.address).toBe("https://apps.team.example.com");
    await h.flow.back();
    expect(view(h.flow, "address").choice).toEqual({
      kind: "domain",
      zone: "example.com",
      subdomain: "Apps.Team",
    });
  });

  it("uses the workers.dev address when the account has no domain", async () => {
    const world = new FakeWorld();
    world.zones = {};
    const h = harness(world);
    await h.flow.loadAccounts();
    await h.flow.submitName();
    expect(view(h.flow, "address").choice).toEqual({ kind: "workers-dev" });
    await h.flow.submitAddress();
    expect(view(h.flow, "review").plan).toMatchObject({
      hostname: null,
      address: "https://appflare.main-sub.workers.dev",
    });
  });

  it("has nothing to offer an account without a domain or workers.dev, until it gets one", async () => {
    const world = new FakeWorld();
    world.zones = {};
    world.accounts[0] = { id: ACCOUNT_ID, name: "Main account", workersDevSubdomain: null };
    const h = harness(world);
    await h.flow.loadAccounts();
    await h.flow.submitName();
    expect(view(h.flow, "address").choice).toBeNull();
    world.accounts[0] = { id: ACCOUNT_ID, name: "Main account", workersDevSubdomain: "new-sub" };
    await h.flow.refreshAddress();
    expect(view(h.flow, "address").choice).toEqual({ kind: "workers-dev" });
  });
});

describe("tokens during a long deploy", () => {
  it("renews the access token in the browser before it expires and hands over the newest refresh token", async () => {
    const world = new FakeWorld();
    const waiting: StepAnswer = {
      status: "waiting",
      step: { id: "proof", label: "Wait for Appflare to answer" },
      done: 3,
      total: 4,
      retryAfterMs: 60_000,
    };
    world.steps = [waiting, waiting, waiting, ...world.steps];
    const h = harness(world, { tokenLife: 6 * 60_000 });
    await toReview(h);
    await h.flow.deploy();
    expect(world.refreshCount).toBe(1);
    const auths = world.requests
      .filter((r) => r.url.startsWith("/api/install/"))
      .map((r) => r.headers.authorization);
    expect(auths.at(0)).toBe("Bearer access-1");
    expect(auths.at(-1)).toBe("Bearer access-2");
    const manager = world.managers.get("https://appflare.example.com");
    expect(manager?.received?.grant).toMatchObject({ refreshToken: "refresh-2" });
    expect(h.session.data.has(GRANT_KEY)).toBe(false);
    expectLocalStorageRules(h);
    expectNoRefreshTokenAtInstaller(h);
    expectCleanUrls(h);
  });

  it("asks to connect again when Cloudflare stops accepting the token, keeping the installation", async () => {
    const world = new FakeWorld();
    const waiting: StepAnswer = {
      status: "waiting",
      step: { id: "worker", label: "Upload Appflare" },
      done: 2,
      total: 4,
      retryAfterMs: 1_000,
    };
    world.steps = [waiting, waiting, ...world.steps];
    const h = harness(world, {
      onPause: (count) => {
        if (count !== 1) return;
        world.validAccess.clear();
        world.validRefresh.clear();
      },
    });
    await toReview(h);
    await h.flow.deploy();
    const welcome = view(h.flow, "welcome");
    expect(welcome).toMatchObject({ notice: "reconnect", unfinished: true });
    expect(h.tokens.grant()).toBeNull();
    expect(h.navigations).toEqual([]);

    // A fresh authorization, then resume.
    world.validAccess.add("access-9");
    h.tokens.keep({
      clientId: CLIENT_ID,
      accessToken: "access-9",
      expiresAt: START + 3_600_000,
      refreshToken: "refresh-9",
      scopes: [...MANAGER_OAUTH_SCOPES],
    });
    await h.flow.loadAccounts();
    const unfinished = view(h.flow, "unfinished");
    expect(unfinished.mine?.address).toBe("https://appflare.example.com");
    expect(unfinished.others).toEqual([]);
    await h.flow.continueMine();
    expect(h.navigations).toEqual([
      "https://appflare.example.com/setup#claim=claim0123456789abcdef",
    ]);
    const manager = world.managers.get("https://appflare.example.com");
    expect(manager?.received?.grant).toMatchObject({ refreshToken: "refresh-9" });
    expectLocalStorageRules(h);
    expectCleanUrls(h, ["access-9", "refresh-9"]);
  });
});

describe("a domain that keeps Appflare waiting", () => {
  it("explains, offers the workers.dev address after a while, and opens there only when asked", async () => {
    const world = new FakeWorld();
    world.steps = [
      {
        status: "waiting",
        step: { id: "proof", label: "Wait for Appflare to answer" },
        done: 3,
        total: 4,
        retryAfterMs: 10_000,
        message: "The address does not answer yet.",
      },
    ];
    // Waits of the deploy end after eight; the short one before opening owner setup does not.
    const h = harness(world, { block: (ms, count) => ms >= 10_000 && count > 8 });
    const seen: Array<{ at: number; offer: boolean; wait: string | null }> = [];
    h.flow.subscribe(() => {
      const current = h.flow.state();
      if (current.step === "deploying" && current.progress !== null) {
        seen.push({ at: h.now(), offer: current.offerWorkersDev, wait: current.wait });
      }
    });
    await toReview(h);
    void h.flow.deploy();
    await vi.waitFor(() => {
      const current = view(h.flow, "deploying");
      expect(current.offerWorkersDev).toBe(true);
    });
    const deploying = view(h.flow, "deploying");
    expect(deploying.active.workersDevAddress).toBe("https://appflare.main-sub.workers.dev");
    expect(deploying.progress?.status).toBe("waiting");
    expect(deploying.wait).toBe("address");
    expect(h.now() - START).toBeGreaterThanOrEqual(OFFER_WORKERS_DEV_AFTER_MS);
    // Explained from the first answer, but no way around it before 70 seconds.
    expect(seen.every((s) => s.wait === "address")).toBe(true);
    const firstWait = seen[0]?.at ?? START;
    for (const s of seen) expect(s.offer).toBe(s.at - firstWait >= OFFER_WORKERS_DEV_AFTER_MS);
    expect(seen.some((s) => !s.offer && s.at - firstWait >= 60_000)).toBe(true);
    // Nothing went to either address yet but the installer's own checks.
    expect(world.requests.some((r) => r.url.includes("workers.dev"))).toBe(false);

    await h.flow.openAtWorkersDev();
    expect(h.navigations).toEqual([
      "https://appflare.main-sub.workers.dev/setup#claim=claim0123456789abcdef",
    ]);
    expect(world.managers.get("https://appflare.example.com")?.received).toBeNull();
  });
});

const proofWait: StepAnswer = {
  status: "waiting",
  step: { id: "proof", label: "Wait for Appflare to answer" },
  done: 3,
  total: 4,
  retryAfterMs: 10_000,
  message: "The address does not answer yet.",
};

/** The answer while another request (an earlier tab) holds the installation. */
function held(retryAfterMs: number): StepAnswer {
  return {
    status: "waiting",
    step: { id: "worker", label: "Upload Appflare" },
    done: 2,
    total: 4,
    retryAfterMs,
    message: "Another window is working on this installation.",
  };
}

/** Every deploying view the flow shows, in order. */
function deployingViews(h: ReturnType<typeof harness>) {
  const views: Array<Extract<DeployView, { step: "deploying" }>> = [];
  h.flow.subscribe(() => {
    const current = h.flow.state();
    if (current.step === "deploying") views.push(current);
  });
  return views;
}

describe("feedback while deploying", () => {
  it("turns the progress into reconnecting while the installer does not answer, then carries on", async () => {
    const world = new FakeWorld();
    const h = harness(world);
    const views = deployingViews(h);
    await toReview(h);
    world.stepsUnanswered = 2;
    await h.flow.deploy();
    const reconnecting = views.filter((v) => v.reconnecting);
    expect(reconnecting).toHaveLength(2);
    expect(reconnecting.every((v) => v.wait === null)).toBe(true);
    // It never stopped: the deploy finished and owner setup opened.
    expect(h.navigations).toHaveLength(1);
    expect(views.at(-1)?.reconnecting).toBe(false);
  });

  it("waits quietly while another tab holds the installation, then runs on", async () => {
    const world = new FakeWorld();
    world.steps = [held(2_000), held(2_000), held(2_000), ...DEFAULT_STEPS];
    const h = harness(world);
    const views = deployingViews(h);
    await toReview(h);
    await h.flow.deploy();
    const waits = views.filter((v) => v.progress?.status === "waiting");
    expect(waits).toHaveLength(3);
    expect(waits.every((v) => v.wait === "quiet" && !v.reconnecting)).toBe(true);
    expect(h.navigations).toHaveLength(1);
  });

  it("explains a hold in one line only once it lasts well past the installer's lease", async () => {
    const world = new FakeWorld();
    world.steps = [held(30_000)];
    const h = harness(world, { block: (ms, count) => ms >= 30_000 && count > 4 });
    const seen: Array<{ at: number; wait: string | null }> = [];
    h.flow.subscribe(() => {
      const current = h.flow.state();
      if (current.step === "deploying" && current.progress !== null) {
        seen.push({ at: h.now(), wait: current.wait });
      }
    });
    await toReview(h);
    void h.flow.deploy();
    await vi.waitFor(() => expect(view(h.flow, "deploying").wait).toBe("long"));
    const firstHold = seen[0]?.at ?? START;
    for (const s of seen) {
      expect(s.wait).toBe(s.at - firstHold >= EXPLAIN_WAIT_AFTER_MS ? "long" : "quiet");
    }
    expect(seen.filter((s) => s.wait === "quiet").length).toBeGreaterThan(2);
  });

  it("shows Check now as checking at once, asks right away, and says what it found", async () => {
    const world = new FakeWorld();
    world.steps = [proofWait];
    let blocked = 0;
    const h = harness(world, {
      block: (ms) => {
        if (ms < 10_000) return false;
        blocked++;
        return true;
      },
    });
    const views = deployingViews(h);
    await toReview(h);
    void h.flow.deploy();
    await vi.waitFor(() => expect(blocked).toBe(1));
    const [installation] = world.installations.values();
    const before = installation?.stepCalls ?? 0;
    const pressedAt = h.now();
    h.flow.checkNow();
    expect(view(h.flow, "deploying").checking).toBe(true);
    // A second press while it checks does nothing more.
    h.flow.checkNow();
    await vi.waitFor(() => expect(blocked).toBe(2));
    const after = view(h.flow, "deploying");
    expect(installation?.stepCalls).toBe(before + 1);
    expect(after.checking).toBe(false);
    expect(after.checkedAt).toBeGreaterThanOrEqual(pressedAt + MIN_CHECK_MS);
    // Checking stayed visible until the answer was in.
    const checkingViews = views.filter((v) => v.checking);
    expect(checkingViews.length).toBeGreaterThan(0);
  });

  it("keeps what each finished step said, and shows only the current step's own message", async () => {
    const world = new FakeWorld();
    world.steps = [
      {
        status: "running",
        step: { id: "worker", label: "Upload Appflare" },
        done: 2,
        total: 4,
        completed: {
          step: { id: "database", label: "Create the database" },
          message: 'Created the D1 database "appflare".',
        },
      },
      ...DEFAULT_STEPS.slice(1),
    ];
    const h = harness(world);
    const views = deployingViews(h);
    await toReview(h);
    await h.flow.deploy();
    const last = views.at(-1);
    expect(last?.notes).toEqual([
      {
        id: "database",
        label: "Create the database",
        message: 'Created the D1 database "appflare".',
      },
    ]);
  });
});

describe("warnings from finished steps", () => {
  it("keeps the schedules warning through the handoff to owner setup, and nothing routine", async () => {
    const world = new FakeWorld();
    const cron =
      "This account already uses every scheduled trigger its Workers plan allows, so Appflare's regular checks do not run on their own.";
    world.steps = [
      {
        status: "running",
        step: { id: "worker", label: "Upload Appflare" },
        done: 2,
        total: 4,
        completed: {
          step: { id: "database", label: "Create the database" },
          message: 'Created the D1 database "appflare".',
        },
      },
      {
        status: "running",
        step: { id: "secret", label: "Store the setup key" },
        done: 3,
        total: 4,
        completed: { step: { id: "schedules", label: "Schedule regular checks" }, message: cron },
      },
      ...DEFAULT_STEPS.slice(2),
    ];
    const h = harness(world);
    const handingOff: Array<Extract<DeployView, { step: "handing-off" }>> = [];
    h.flow.subscribe(() => {
      const current = h.flow.state();
      if (current.step === "handing-off") handingOff.push(current);
    });
    await toReview(h);
    await h.flow.deploy();
    const notice = { id: "schedules", label: "Schedule regular checks", message: cron };
    expect(handingOff[0]?.active.notices).toEqual([notice]);
    expect(view(h.flow, "opening").notices).toEqual([notice]);
  });
});

describe("the handoff", () => {
  it("sends nothing to an address that does not prove it is this installation", async () => {
    const world = new FakeWorld();
    const h = harness(world);
    await toReview(h);
    // The address answers, but with another installation's proof.
    const original = world.addManager.bind(world);
    world.addManager = (address, hash) => {
      const created = original(address, hash);
      created.impostor = address === "https://appflare.example.com";
      return created;
    };
    await h.flow.deploy();
    expect(view(h.flow, "handoff-failed").problem).toBe("unverified");
    const posts = world.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/api/handoff"),
    );
    expect(posts).toEqual([]);
    expect(h.tokens.grant()).not.toBeNull();
  });

  it("does not send the grant to an Appflare that already has its owner", async () => {
    const world = new FakeWorld();
    const original = world.addManager.bind(world);
    world.addManager = (address, hash) => {
      const created = original(address, hash);
      created.state = "done";
      return created;
    };
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    expect(view(h.flow, "set-up").address).toBe("https://appflare.example.com");
    expect(
      world.requests.filter((r) => r.method === "POST" && r.url.endsWith("/api/handoff")),
    ).toEqual([]);
    expect(h.storage.installation.read()).toBeNull();
  });

  it("connects Cloudflare again when Appflare used up the grant without keeping it, then hands over the new one", async () => {
    const world = new FakeWorld();
    const original = world.addManager.bind(world);
    world.addManager = (address, hash) => {
      const created = original(address, hash);
      created.postAnswers = [{ status: 401, body: { error: "authorize_again", message: "…" } }];
      return created;
    };
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    expect(view(h.flow, "welcome")).toMatchObject({ notice: "reconnect", unfinished: true });
    expect(h.tokens.grant()).toBeNull();
    expect(h.navigations).toEqual([]);

    world.validAccess.add("access-9");
    h.tokens.keep({
      clientId: CLIENT_ID,
      accessToken: "access-9",
      expiresAt: START + 3_600_000,
      refreshToken: "refresh-9",
      scopes: [...MANAGER_OAUTH_SCOPES],
    });
    await h.flow.loadAccounts();
    await h.flow.continueMine();
    expect(h.navigations).toEqual([
      "https://appflare.example.com/setup#claim=claim0123456789abcdef",
    ]);
    const manager = world.managers.get("https://appflare.example.com");
    expect(manager?.received?.grant).toMatchObject({ refreshToken: "refresh-9" });
  });

  it("goes straight to connecting Cloudflare again when Appflare declines the connection", async () => {
    const world = new FakeWorld();
    const original = world.addManager.bind(world);
    world.addManager = (address, hash) => {
      const created = original(address, hash);
      created.postAnswers = [{ status: 400, body: { error: "refused", message: "…" } }];
      return created;
    };
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    expect(view(h.flow, "handoff-failed").problem).toBe("declined");
    // The installation stays; the grant that was declined does not.
    await h.flow.reconnect();
    expect(h.tokens.grant()).toBeNull();
    expect(h.storage.installation.read()).not.toBeNull();
    const [target] = h.navigations;
    expect(new URL(target ?? "").pathname).toBe("/oauth2/auth");
  });

  it("says plainly that another browser is finishing setup, after sending", async () => {
    const world = new FakeWorld();
    const original = world.addManager.bind(world);
    world.addManager = (address, hash) => {
      const created = original(address, hash);
      created.postAnswers = [
        { status: 409, body: { error: "setup_elsewhere", message: "…", minutes: 7 } },
        { status: 503, body: { error: "busy", message: "…" } },
      ];
      return created;
    };
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    expect(view(h.flow, "handoff-failed")).toMatchObject({ problem: "elsewhere", minutes: 7 });
    // An installation is not forgotten: it is not set up yet.
    expect(h.storage.installation.read()).not.toBeNull();
    await h.flow.retry();
    expect(view(h.flow, "handoff-failed").problem).toBe("busy");
    await h.flow.retry();
    expect(h.navigations).toHaveLength(1);
  });

  it("says when the address does not answer yet, and tries again", async () => {
    const world = new FakeWorld();
    const h = harness(world);
    await toReview(h);
    const original = world.addManager.bind(world);
    world.addManager = (address, hash) => {
      const created = original(address, hash);
      created.unreachable = true;
      return created;
    };
    await h.flow.deploy();
    expect(view(h.flow, "handoff-failed").problem).toBe("unreachable");
    const manager = world.managers.get("https://appflare.example.com");
    if (manager) manager.unreachable = false;
    await h.flow.retry();
    expect(h.navigations).toHaveLength(1);
  });
});

describe("the address the grant goes to", () => {
  it("stops when the installer answers with another address than the one reviewed", async () => {
    const world = new FakeWorld();
    world.addressOverride = "https://evil.example";
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    const failed = view(h.flow, "deploy-failed");
    expect(failed.active.address).toBe("https://appflare.example.com");
    expect(failed.message).toContain("https://evil.example");
    expect(failed.message).toContain("Remove this installation");
    expect(world.requests.some((r) => !r.url.startsWith("/api/install/"))).toBe(false);
    // It can still be removed from here.
    expect(h.storage.installation.read()).not.toBeNull();
  });

  it("does not continue an installation whose recorded address is not its own", async () => {
    const world = new FakeWorld();
    world.steps = [
      { status: "failed", step: { id: "worker", label: "Upload Appflare" }, done: 2, total: 4 },
    ];
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    for (const record of world.installations.values()) record.address = "https://evil.example";
    await h.flow.loadAccounts();
    await h.flow.continueMine();
    const unfinished = view(h.flow, "unfinished");
    expect(unfinished.error).toContain("https://evil.example");
    expect(world.requests.some((r) => r.url.includes("evil.example"))).toBe(false);
  });
});

describe("unfinished installations", () => {
  async function startedThenLeft() {
    const world = new FakeWorld();
    world.steps = [
      {
        status: "failed",
        step: { id: "worker", label: "Upload Appflare" },
        done: 2,
        total: 4,
        message: "Cloudflare could not upload Appflare. Try again.",
      },
    ];
    const h = harness(world);
    await toReview(h);
    await h.flow.deploy();
    expect(view(h.flow, "deploy-failed").message).toBe(
      "Cloudflare could not upload Appflare. Try again.",
    );
    return h;
  }

  it("removes one this browser started, saying what goes, then forgets it", async () => {
    const h = await startedThenLeft();
    await h.flow.loadAccounts();
    const unfinished = view(h.flow, "unfinished");
    const id = unfinished.mine?.id ?? "";
    h.flow.requestRemove(id);
    expect(view(h.flow, "confirm-remove").target).toMatchObject({
      id,
      workerName: "appflare",
      hostname: "appflare.example.com",
    });
    expect(view(h.flow, "confirm-remove").target.key).toMatch(/^k/);
    await h.flow.back();
    view(h.flow, "unfinished");
    h.flow.requestRemove(id);
    await h.flow.confirmRemove();
    view(h.flow, "removed");
    expect(h.storage.installation.read()).toBeNull();
    expect(h.world.installations.size).toBe(0);
    const cleanups = h.world.requests.filter((r) => r.url.endsWith("/cleanup"));
    expect(cleanups.every((r) => JSON.parse(r.body).key !== undefined)).toBe(true);
    await h.flow.afterRemoval();
    view(h.flow, "name");
  });

  it("can only remove one started in another browser, without its key", async () => {
    const h = await startedThenLeft();
    h.storage.installation.clear();
    await h.flow.loadAccounts();
    const unfinished = view(h.flow, "unfinished");
    expect(unfinished.mine).toBeNull();
    expect(unfinished.others).toHaveLength(1);
    await h.flow.continueMine();
    view(h.flow, "unfinished");
    h.flow.requestRemove(unfinished.others[0]?.id ?? "");
    expect(view(h.flow, "confirm-remove").target.key).toBeNull();
    await h.flow.confirmRemove();
    view(h.flow, "removed");
    const cleanups = h.world.requests.filter((r) => r.url.endsWith("/cleanup"));
    expect(cleanups.map((r) => r.body)).toEqual(["{}", "{}"]);
  });

  it("drops a remembered installation the installer no longer has", async () => {
    const h = await startedThenLeft();
    h.world.installations.clear();
    await h.flow.loadAccounts();
    expect(view(h.flow, "name")).toBeTruthy();
    expect(h.storage.installation.read()).toBeNull();
  });

  it("says when the sign-in does not reach the remembered installation's account", async () => {
    const h = await startedThenLeft();
    h.world.accounts = [{ id: OTHER_ACCOUNT_ID, name: "Side account", workersDevSubdomain: null }];
    await h.flow.loadAccounts();
    expect(view(h.flow, "account").notice).toBe("account-unreachable");
  });
});
