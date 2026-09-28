import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../auth/guards";
import { type Auth, createAuth } from "../auth/server";
import { manifestCacheKey } from "../catalog/app-manifest.server";
import { readCatalogEntry } from "../catalog/catalog-entry.server";
import { CATALOG_INDEX_KEY, forgetParsedIndexes } from "../catalog/index.server";
import { invalidateScriptsCache } from "../cloudflare/scripts-cache.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { readLayoutData } from "../home/layout-data.server";
import { readInstallDetail, readInstallPageSettings } from "../installs/install-detail.server";
import { listSnapshotsCore } from "../installs/versions.server";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import { ACC } from "../test/fake-account";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { probeRoundTrips, type RoundTrips } from "../test/round-trips";
import { cacheIndex, INSTALL_ID, seedInstall } from "../test/seed-install";
import { readGate } from "./gate.server";

/**
 * How many D1 statements, KV reads and sequential round trips ("waves") the
 * signed-in pages cost on the server, with a real Better Auth session. Each
 * number is an upper bound the page must stay within.
 */

const BASE = "https://appflare.appflare-dev.workers.dev";
const SECRET = "test-only-better-auth-secret-0000000000000";
const PASSWORD = "correct horse battery staple";

let auth: Auth;
let headers: Headers;
let fixture: ArtifactFixture;
let probe: RoundTrips | null = null;
const mutableEnv = env as unknown as Record<string, unknown>;
/** Lists every operation with its depth (run with `--silent=false` to see the lines). */
const DETAIL = false;

async function signIn(): Promise<Headers> {
  await auth.api.createUser({
    body: { email: "owner@example.com", name: "Owner", password: PASSWORD, role: "admin" },
  });
  const { headers: setCookies } = await auth.api.signInEmail({
    body: { email: "owner@example.com", password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = setCookies
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie, origin: BASE });
}

function report(name: string, p: RoundTrips) {
  console.log(
    `[round trips] ${name}: ${p.waves()} waves, ${p.d1Statements()} D1 statements in ${p.d1RoundTrips()} round trips, ${p.kvOps()} KV operations, ${p.ops.filter((o) => o.kind === "fetch").length} fetches`,
  );
  if (DETAIL) for (const o of p.ops) console.log(`  ${o.depth} ${o.kind} ${o.label.slice(0, 100)}`);
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  auth = createAuth({ db: createDb(env.DB), secret: SECRET, baseURL: BASE });
  headers = await signIn();
  fixture = await buildArtifactFixture();
  await seedInstall({ manifestJson: new TextDecoder().decode(fixture.manifestBytes) });
  await writeSettings(createDb(env.DB), { [SETTING.cfTokenConfigured]: "1" });
  await cacheIndex(fixture);
  await env.KV.put(
    manifestCacheKey(fixture.digest),
    new TextDecoder().decode(fixture.manifestBytes),
  );
  mutableEnv.CF_API_TOKEN = "cf-test-token";
  invalidateScriptsCache();
  forgetParsedIndexes();
  const cf = fakeCloudflare({ [`GET /accounts/${ACC}/workers/scripts`]: { result: [] } });
  vi.stubGlobal("fetch", cf.fetch);
});

afterEach(() => {
  probe?.restore();
  probe = null;
  delete mutableEnv.CF_API_TOKEN;
  vi.unstubAllGlobals();
});

function start(): RoundTrips {
  probe = probeRoundTrips();
  return probe;
}

/** A session check as page reads make it: from the cookie's copy, or from D1 without it. */
function sessionLoader(cookie: "copy" | "token only") {
  const sent =
    cookie === "copy"
      ? headers
      : new Headers({
          cookie: (headers.get("cookie") ?? "")
            .split("; ")
            .filter((c) => !c.includes("session_data"))
            .join("; "),
        });
  return async (): Promise<AuthSession> => {
    const session = await auth.api.getSession({ headers: sent });
    if (session === null) throw new Error("no session");
    return session;
  };
}

describe("round trips of the signed-in pages", () => {
  it("the gate: one D1 batch beside the session check", async () => {
    const p = start();
    const gate = await readGate({
      db: env.DB,
      loadSession: sessionLoader("copy"),
      setupClaimed: async () => false,
      authReady: true,
    });
    expect(gate.viewer?.role).toBe("admin");
    expect(gate.state.tokenConfigured).toBe(true);
    expect(gate.accountId).toBe(ACC);
    report("gate", p);
    expect(p.waves()).toBe(1);
    expect(p.d1RoundTrips()).toBe(1);
    expect(p.d1Statements()).toBe(2);
    p.clear();
    await readGate({
      db: env.DB,
      loadSession: sessionLoader("token only"),
      setupClaimed: async () => false,
      authReady: true,
    });
    report("gate, session from D1", p);
    expect(p.waves()).toBeLessThanOrEqual(2);
  });

  it("the layout: one round after the session check", async () => {
    const session = await sessionLoader("copy")();
    const p = start();
    const data = await readLayoutData(session);
    expect(data.apps).toHaveLength(1);
    expect(data.apps[0]?.latestVersion).toBe(fixture.index.version);
    report("layout", p);
    expect(p.waves()).toBeLessThanOrEqual(2);
    expect(p.ops.filter((o) => o.kind === "fetch")).toEqual([]);
  });

  it("an app's catalog page: two rounds, and the account's Workers listed once a minute", async () => {
    const p = start();
    const entry = await readCatalogEntry("cut", sessionLoader("copy"));
    expect(entry.app?.slug).toBe("cut");
    expect(entry.error).toBeNull();
    expect(entry.suggestedWorkerName).not.toBeNull();
    report("catalog entry", p);
    expect(p.waves()).toBeLessThanOrEqual(2);
    // The index is read once.
    expect(p.ops.filter((o) => o.label === `get ${CATALOG_INDEX_KEY}`)).toHaveLength(1);
    expect(p.ops.filter((o) => o.kind === "fetch")).toHaveLength(1);
    p.clear();
    await readCatalogEntry("cut", sessionLoader("copy"));
    report("catalog entry, viewed again", p);
    expect(p.ops.filter((o) => o.kind === "fetch")).toEqual([]);
    expect(p.waves()).toBeLessThanOrEqual(2);
  });

  it("an app's catalog page with nothing cached fetches the catalog only for a signed-in viewer", async () => {
    await env.KV.delete(CATALOG_INDEX_KEY);
    const p = start();
    const signedOut = async (): Promise<AuthSession> => {
      throw new Error("sign in");
    };
    await expect(readCatalogEntry("cut", signedOut)).rejects.toThrow("sign in");
    expect(p.ops.filter((o) => o.kind === "fetch")).toEqual([]);
    expect(p.ops.filter((o) => o.label.startsWith("put "))).toEqual([]);
    p.clear();
    await readCatalogEntry("cut", sessionLoader("copy"));
    // Signed in: the catalog is fetched once, after the session is known.
    const fetches = p.ops.filter((o) => o.kind === "fetch" && !o.label.includes("/workers/"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.depth).toBeGreaterThan(1);
  });

  it("an install's page: one request, one session check", async () => {
    const p = start();
    const session = await sessionLoader("copy")();
    const [install, snapshots, settings] = await Promise.all([
      readInstallDetail(INSTALL_ID),
      listSnapshotsCore(env.DB, INSTALL_ID, { withBookmarks: session.user.role === "admin" }),
      readInstallPageSettings(INSTALL_ID),
    ]);
    expect(install?.id).toBe(INSTALL_ID);
    expect(snapshots).toEqual([]);
    expect(settings?.slug).toBe("cut");
    report("install page", p);
    expect(p.waves()).toBeLessThanOrEqual(3);
  });
});
