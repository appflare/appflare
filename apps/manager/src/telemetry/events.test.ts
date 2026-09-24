import { describe, expect, it } from "vitest";
import {
  type HeartbeatInput,
  heartbeatProperties,
  type JobRow,
  jobEvents,
  jobKind,
  officialSlug,
  utcDay,
  uuidV5,
} from "./events";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

describe("uuidV5", () => {
  it("follows RFC 9562 (the DNS namespace example)", async () => {
    expect(await uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });
  it("is stable for a name and differs between names", async () => {
    expect(await uuidV5("a")).toBe(await uuidV5("a"));
    expect(await uuidV5("a")).not.toBe(await uuidV5("b"));
  });
});

describe("utcDay", () => {
  it("is the UTC date", () => {
    expect(utcDay(Date.parse("2026-09-24T23:59:59.999Z"))).toBe("2026-09-24");
    expect(utcDay(Date.parse("2026-09-25T00:00:00.000Z"))).toBe("2026-09-25");
  });
});

function heartbeat(overrides: Partial<HeartbeatInput> = {}): HeartbeatInput {
  return {
    now: NOW,
    managerVersion: "0.5.0",
    schemaVersion: 10,
    accountPlan: undefined,
    officialCatalog: true,
    noticeAt: NOW - 3.5 * DAY,
    users: 3,
    admins: 1,
    passkeys: 2,
    passkeyUsers: 1,
    accessEnabled: false,
    sandboxConnected: true,
    managerBehindLatest: false,
    installs: [
      {
        slug: "cut",
        status: "installed",
        buildKind: "artifact",
        version: "1.0.0",
        updatedAt: NOW - 10 * DAY,
      },
      { slug: "cut", status: "installed", buildKind: "artifact", version: "1.1.0", updatedAt: NOW },
      {
        slug: "open-seo",
        status: "updating",
        buildKind: "self-deploying",
        version: "2.0.0",
        updatedAt: NOW - 100 * DAY,
      },
      { slug: "private", status: "failed", buildKind: "sandbox", version: "0.1.0", updatedAt: NOW },
    ],
    catalogVersions: new Map([
      ["cut", "1.1.0"],
      ["open-seo", "2.1.0"],
    ]),
    installsWithDomain: 1,
    installsWithEmailRouting: 0,
    installsWithCrons: 2,
    removedWithRetained: 1,
    notificationChannels: { telegram: 1, slack: 0, discord: 2, webhook: 0 },
    ...overrides,
  };
}

describe("heartbeatProperties", () => {
  it("counts installs by status, tier and version age, and lists official slugs only", () => {
    expect(heartbeatProperties(heartbeat())).toEqual({
      schema_version: 10,
      account_plan: "unset",
      catalog: "official",
      days_since_setup: 3,
      users: 3,
      admins: 1,
      passkeys_enabled: true,
      passkey_users: 1,
      access_enabled: false,
      sandbox_connected: true,
      manager_behind_latest: false,
      manager_self_update_auto: null,
      auto_update_default: null,
      installs_auto_update: null,
      notification_channels: { telegram: 1, slack: 0, discord: 2, webhook: 0 },
      installs_total: 4,
      installs_by_status: { installed: 2, failed: 1, installing: 0, updating: 1, uninstalling: 0 },
      installs_by_tier: { artifact: 2, sandbox: 1, self_deploying: 1 },
      installs_by_version_age: {
        current: 2,
        behind_lt_7d: 0,
        behind_7_30d: 1,
        behind_30_90d: 0,
        behind_gt_90d: 1,
      },
      installs_with_domain: 1,
      installs_with_email_routing: 0,
      installs_with_crons: 2,
      removed_with_retained: 1,
      apps: ["cut", "open-seo"],
    });
  });

  it("sends no slugs for a custom catalog", () => {
    const props = heartbeatProperties(heartbeat({ officialCatalog: false, accountPlan: "paid" }));
    expect(props.apps).toEqual([]);
    expect(props.catalog).toBe("custom");
    expect(props.account_plan).toBe("paid");
  });
});

describe("officialSlug", () => {
  it("keeps a slug only from the official catalog, and only one the index lists", () => {
    const versions = new Map([["cut", "1.0.0"]]);
    expect(officialSlug("cut", true, versions)).toBe("cut");
    expect(officialSlug("mine", true, versions)).toBeNull();
    expect(officialSlug("cut", false, versions)).toBeNull();
    expect(officialSlug("cut", true, null)).toBe("cut");
  });
});

function job(overrides: Partial<JobRow>): JobRow {
  return {
    id: "01J",
    kind: "install",
    status: "succeeded",
    inputJson: JSON.stringify({
      slug: "cut",
      version: "1.1.0",
      workerName: "my-links",
      vars: { A: "b" },
    }),
    error: null,
    startedAt: NOW - 120_000,
    finishedAt: NOW - 60_000,
    appSlug: "cut",
    installVersion: "1.1.0",
    buildKind: "artifact",
    snapshotTargetVersion: null,
    ...overrides,
  };
}

describe("jobEvents", () => {
  const window = { from: NOW - DAY, to: NOW };
  const versions = new Map([["cut", "1.1.0"]]);

  it("reports a start and an end at the job's own times", async () => {
    const events = await jobEvents([job({})], window, { source: "manager" }, "id", true, versions);
    expect(events.map((e) => [e.event, e.timestamp])).toEqual([
      ["job started", new Date(NOW - 120_000).toISOString()],
      ["job finished", new Date(NOW - 60_000).toISOString()],
    ]);
    expect(events[1]?.properties).toEqual({
      source: "manager",
      kind: "install",
      slug: "cut",
      catalog_version: "1.1.0",
      from_version: null,
      tier: "artifact",
      trigger: "manual",
      outcome: "succeeded",
      duration_s: 60,
      error_category: null,
      failed_phase: null,
      cf_status: null,
      cf_code: null,
    });
    expect(JSON.stringify(events)).not.toContain("my-links");
  });

  it("reports only the moments inside the window", async () => {
    const started = job({ startedAt: NOW - 2 * DAY, finishedAt: NOW - 1000 });
    const running = job({ id: "02", status: "running", finishedAt: null });
    const events = await jobEvents([started, running], window, {}, "id", true, versions);
    expect(events.map((e) => e.event)).toEqual(["job finished", "job started"]);
  });

  it("classifies a failure and never sends its text", async () => {
    const error =
      "set secret STRIPE_KEY: Cloudflare API request failed: PUT /accounts/acc-1/workers/scripts/my-links/secrets -> 403: [10000] Authentication error";
    const [, finished] = await jobEvents(
      [
        job({
          status: "failed",
          error,
          kind: "update",
          inputJson: JSON.stringify({ fromVersion: "1.0.0", version: "1.1.0" }),
        }),
      ],
      window,
      {},
      "id",
      true,
      versions,
    );
    expect(finished?.properties).toMatchObject({
      kind: "update",
      from_version: "1.0.0",
      catalog_version: "1.1.0",
      outcome: "failed",
      error_category: "cloudflare_permission",
      failed_phase: "secrets",
      cf_status: 403,
      cf_code: 10000,
    });
    const text = JSON.stringify(finished);
    for (const secret of ["STRIPE_KEY", "acc-1", "my-links", "Authentication"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("names self-updates, rollbacks, restores and custom apps", async () => {
    const rows = [
      job({
        id: "s",
        kind: "self_update",
        appSlug: null,
        buildKind: null,
        inputJson: JSON.stringify({ version: "0.6.0", fromVersion: "0.5.0", tag: "manager@0.6.0" }),
      }),
      job({
        id: "r",
        kind: "rollback",
        inputJson: JSON.stringify({ toVersion: "1.0.0", snapshotId: "x" }),
        snapshotTargetVersion: "1.1.0",
      }),
      job({
        id: "d",
        kind: "rollback",
        inputJson: JSON.stringify({ restore: true, databaseName: "notes" }),
      }),
      job({ id: "c", kind: "install", appSlug: "private-app" }),
    ];
    const finished = (await jobEvents(rows, window, {}, "id", true, versions)).filter(
      (e) => e.event === "job finished",
    );
    expect(
      finished.map((e) => [
        e.properties.kind,
        e.properties.slug,
        e.properties.catalog_version,
        e.properties.from_version,
        e.properties.tier,
      ]),
    ).toEqual([
      ["self_update", "appflare", "0.6.0", "0.5.0", null],
      ["rollback", "cut", "1.0.0", "1.1.0", "artifact"],
      ["restore", "cut", "1.1.0", null, "artifact"],
      ["install", "custom", null, null, "artifact"],
    ]);
    expect(JSON.stringify(finished)).not.toContain("notes");
    expect(JSON.stringify(finished)).not.toContain("private-app");
  });

  it("gives each event a stable uuid", async () => {
    const a = await jobEvents([job({})], window, {}, "id", true, versions);
    const b = await jobEvents([job({})], window, {}, "id", true, versions);
    expect(a.map((e) => e.uuid)).toEqual(b.map((e) => e.uuid));
  });
});

describe("jobKind", () => {
  it("tells a database restore and deleting retained data apart", () => {
    expect(jobKind({ kind: "rollback", inputJson: '{"restore":true}' })).toBe("restore");
    expect(jobKind({ kind: "uninstall", inputJson: '{"deleteRetained":true}' })).toBe(
      "delete_retained",
    );
    expect(jobKind({ kind: "uninstall", inputJson: "not json" })).toBe("uninstall");
  });
});
