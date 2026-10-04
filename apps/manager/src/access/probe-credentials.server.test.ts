import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { probeHealth } from "../jobs/install/health";
import { FAKE_ACC, fakeAccessAccount } from "../test/fake-access-account";
import { recordProtectedInstall } from "../test/protected-install";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import {
  cachedZoneNames,
  forgetZoneNames,
  isAccountWorkersDevHost,
  isInAccountZone,
  isInstallAddress,
  type ProbeCredentialsDeps,
  probeCredentials,
  probeHost,
  ZONE_NAMES_CACHE_MS,
  zoneNamesVia,
} from "./probe-credentials.server";

const AUTH = "auth-secret-0123456789abcdef0123456789";
const SECRET = "client-secret-DO-NOT-LEAK";
const SUB = "appflare-dev";
const OTHER = "i2";

/** Install `i1` (Worker `cut`) with a custom domain and a wildcard domain; `i2` (Worker `notes`). */
async function seed() {
  await seedInstall({
    resources: [
      { kind: "domain", name: "cut.example.com" },
      { kind: "wildcard_domain", name: "tunnels.example.com" },
      { kind: "custom_hostname", name: "links.customer.net" },
    ],
  });
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, installed_at, updated_at)
     VALUES (?1, 'notes', 'notes', 'notes', '1.0.0', 'https://artifacts.test/n.zip', 'installed', 1, 1)`,
  )
    .bind(OTHER)
    .run();
  await writeSettings(createDb(env.DB), { [SETTING.accountSubdomain]: SUB });
}

function deps(zones: readonly string[] | null = ["example.com"]) {
  const asked: number[] = [];
  const d: ProbeCredentialsDeps = {
    db: env.DB,
    authSecret: AUTH,
    zoneNames: async () => {
      asked.push(1);
      return zones;
    },
  };
  return { deps: d, asked };
}

const HEADERS = {
  "CF-Access-Client-Id": `client-${INSTALL_ID}.access`,
  "CF-Access-Client-Secret": SECRET,
};

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  forgetZoneNames();
  await seed();
});

describe("the host rule", () => {
  it("takes https URLs on the default port without credentials only", () => {
    expect(probeHost("https://Cut.appflare-dev.workers.dev/api/health")).toBe(
      "cut.appflare-dev.workers.dev",
    );
    expect(probeHost("http://cut.appflare-dev.workers.dev/")).toBeNull();
    expect(probeHost("https://cut.appflare-dev.workers.dev:8443/")).toBeNull();
    expect(probeHost("https://user:pw@cut.appflare-dev.workers.dev/")).toBeNull();
    expect(probeHost("https://cut.appflare-dev.workers.dev./")).toBeNull();
    expect(probeHost("https://[::1]/")).toBeNull();
    expect(probeHost("not a url")).toBeNull();
  });

  it("accepts names under the account's own workers.dev subdomain only", () => {
    expect(isAccountWorkersDevHost("cut.appflare-dev.workers.dev", SUB)).toBe(true);
    expect(isAccountWorkersDevHost("0123abcd-cut.appflare-dev.workers.dev", SUB)).toBe(true);
    expect(isAccountWorkersDevHost("appflare-dev.workers.dev", SUB)).toBe(false);
    expect(isAccountWorkersDevHost("cut.other.workers.dev", SUB)).toBe(false);
    expect(isAccountWorkersDevHost("cut.evilappflare-dev.workers.dev", SUB)).toBe(false);
    expect(isAccountWorkersDevHost("cut.appflare-dev.workers.dev.evil.com", SUB)).toBe(false);
    expect(isAccountWorkersDevHost("cut.appflare-dev.workers.dev", null)).toBe(false);
  });

  it("accepts a zone of the account and names under it, nothing that only looks alike", () => {
    const zones = ["example.com", "Other.org"];
    expect(isInAccountZone("example.com", zones)).toBe(true);
    expect(isInAccountZone("app.example.com", zones)).toBe(true);
    expect(isInAccountZone("a.b.other.org", zones)).toBe(true);
    expect(isInAccountZone("badexample.com", zones)).toBe(false);
    expect(isInAccountZone("example.com.evil.net", zones)).toBe(false);
    expect(isInAccountZone("anything.com", ["com"])).toBe(false);
  });

  it("accepts only the install's own names: its Worker, its previews, its domains", () => {
    const cut = {
      workerName: "cut",
      versionPrefixes: ["0123abcd"],
      domains: ["cut.example.com"],
      wildcardBases: ["tunnels.example.com"],
    };
    expect(isInstallAddress("cut.appflare-dev.workers.dev", SUB, cut)).toBe(true);
    expect(isInstallAddress("0123abcd-cut.appflare-dev.workers.dev", SUB, cut)).toBe(true);
    expect(isInstallAddress("cut.example.com", SUB, cut)).toBe(true);
    expect(isInstallAddress("tunnels.example.com", SUB, cut)).toBe(true);
    expect(isInstallAddress("x.tunnels.example.com", SUB, cut)).toBe(true);
    expect(isInstallAddress("notes.appflare-dev.workers.dev", SUB, cut)).toBe(false);
    expect(isInstallAddress("x-cut.appflare-dev.workers.dev", SUB, cut)).toBe(false);
    expect(isInstallAddress("0123abcd-cut2.appflare-dev.workers.dev", SUB, cut)).toBe(false);
    // A preview of a version the install never recorded.
    expect(isInstallAddress("deadbeef-cut.appflare-dev.workers.dev", SUB, cut)).toBe(false);
    expect(isInstallAddress("other.example.com", SUB, cut)).toBe(false);
  });
});

describe("probeCredentials", () => {
  it("gives nothing, and asks for no zones, while the install is not protected", async () => {
    const { deps: d, asked } = deps();
    const live = "https://cut.appflare-dev.workers.dev/";
    expect(await probeCredentials(d, INSTALL_ID, live)).toBeUndefined();
    // A token made, but no Access application recorded yet.
    await recordProtectedInstall({
      installId: INSTALL_ID,
      authSecret: AUTH,
      secret: SECRET,
      accessAppId: null,
    });
    expect(await probeCredentials(d, INSTALL_ID, live)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("gives the install's own token for its workers.dev and recorded preview addresses without reading zones", async () => {
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: SECRET });
    const { deps: d, asked } = deps();
    expect(
      await probeCredentials(d, INSTALL_ID, "https://cut.appflare-dev.workers.dev/api/health"),
    ).toEqual(HEADERS);
    // The serving version's preview.
    expect(
      await probeCredentials(d, INSTALL_ID, "https://99999999-cut.appflare-dev.workers.dev/"),
    ).toEqual(HEADERS);
    // A version no running job of the install uploaded: nothing, until one did.
    const preview = "https://0123abcd-cut.appflare-dev.workers.dev/";
    expect(await probeCredentials(d, INSTALL_ID, preview)).toBeUndefined();
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, worker_version_id, started_by)
       VALUES ('j-up', ?1, 'update', 'running', '0123abcd-0000-4000-8000-000000000000', 'admin')`,
    )
      .bind(INSTALL_ID)
      .run();
    expect(await probeCredentials(d, INSTALL_ID, preview)).toEqual(HEADERS);
    expect(asked).toEqual([]);
  });

  it("gives it for the install's custom and wildcard domains while their zone is the account's", async () => {
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: SECRET });
    const own = deps(["example.com"]).deps;
    expect(await probeCredentials(own, INSTALL_ID, "https://cut.example.com/")).toEqual(HEADERS);
    expect(await probeCredentials(own, INSTALL_ID, "https://t1.tunnels.example.com/")).toEqual(
      HEADERS,
    );
    // The zone left the account: nothing, though the domain is still recorded.
    const gone = deps(["other.org"]).deps;
    expect(await probeCredentials(gone, INSTALL_ID, "https://cut.example.com/")).toBeUndefined();
  });

  it("never gives one install's token for another install, an external domain, http or a port", async () => {
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: SECRET });
    await recordProtectedInstall({ installId: OTHER, authSecret: AUTH, secret: "other-secret" });
    const { deps: d } = deps(["example.com", "customer.net"]);
    for (const url of [
      "https://notes.appflare-dev.workers.dev/",
      "https://links.customer.net/",
      "https://other.example.com/",
      "https://cut.someone-else.workers.dev/",
      "http://cut.appflare-dev.workers.dev/",
      "https://cut.appflare-dev.workers.dev:8443/",
    ]) {
      expect(await probeCredentials(d, INSTALL_ID, url), url).toBeUndefined();
    }
    // The other install's own address gets the other install's own token.
    expect(await probeCredentials(d, OTHER, "https://notes.appflare-dev.workers.dev/")).toEqual({
      "CF-Access-Client-Id": `client-${OTHER}.access`,
      "CF-Access-Client-Secret": "other-secret",
    });
    expect(
      await probeCredentials(d, OTHER, "https://cut.appflare-dev.workers.dev/"),
    ).toBeUndefined();
  });

  it("gives nothing when the zones cannot be read or the secret no longer opens", async () => {
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: SECRET });
    expect(
      await probeCredentials(deps(null).deps, INSTALL_ID, "https://cut.example.com/"),
    ).toBeUndefined();
    const failing: ProbeCredentialsDeps = {
      ...deps().deps,
      zoneNames: async () => {
        throw new Error("boom");
      },
    };
    expect(await probeCredentials(failing, INSTALL_ID, "https://cut.example.com/")).toBeUndefined();
    const rotated = { ...deps().deps, authSecret: "another-auth-secret-0123456789" };
    expect(
      await probeCredentials(rotated, INSTALL_ID, "https://cut.appflare-dev.workers.dev/"),
    ).toBeUndefined();
  });
});

describe("the account's zone names", () => {
  it("lists this account's active zones once per isolate for a while", async () => {
    const cf = fakeAccessAccount();
    cf.zones.push(
      { id: "z1", name: "Example.com", status: "active", account: { id: FAKE_ACC } },
      { id: "z2", name: "elsewhere.org", status: "active", account: { id: "other-account" } },
    );
    const names = zoneNamesVia(async () => cf.client);
    expect(await names()).toEqual(["example.com"]);
    expect(await names()).toEqual(["example.com"]);
    expect(cf.keys()).toEqual(["GET /zones"]);
  });

  it("reloads after the cache time, and reads a failure as unknown", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return ["example.com"];
    };
    await cachedZoneNames("acc", load, 1_000);
    await cachedZoneNames("acc", load, 1_000 + ZONE_NAMES_CACHE_MS - 1);
    expect(loads).toBe(1);
    await cachedZoneNames("acc", load, 1_000 + ZONE_NAMES_CACHE_MS);
    expect(loads).toBe(2);
    const broken = zoneNamesVia(async () => {
      throw new Error("no token");
    });
    expect(await broken()).toBeNull();
  });
});

describe("probeHealth with the credentials", () => {
  it("sends them to the URL only, keeps its own user agent, and never follows a redirect", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    await probeHealth(
      async (url, init) => {
        seen.push({ url, init });
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.net/" } });
      },
      "https://cut.appflare-dev.workers.dev/",
      { headers: HEADERS },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.init?.redirect).toBe("manual");
    expect(seen[0]?.init?.headers).toEqual({ ...HEADERS, "user-agent": "Appflare health check" });
  });
});
