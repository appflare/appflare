import { describe, expect, it } from "vitest";
import {
  type AccountAttentionRow,
  type AttentionApp,
  type AttentionInput,
  type AttentionItem,
  accountRowKey,
  appSignals,
  attentionBadge,
  attentionItems,
  type FailedJob,
  SEVERITY_ORDER,
  updateAllTargets,
} from "./attention";
import { attentionCopy, failedJobTitle } from "./attention-copy";

const app = (over: Partial<AttentionApp> & { id: string }): AttentionApp => ({
  label: over.id,
  status: "installed",
  version: "1.0.0",
  latestVersion: "1.0.0",
  updateAvailable: false,
  updateNeeds: null,
  healthStatus: "verified",
  healthAccess: false,
  healthCheckedAt: "2026-09-27T10:00:00.000Z",
  ...over,
});

const job = (over: Partial<FailedJob> & { id: string; installId: string }): FailedJob => ({
  kind: "update",
  restore: false,
  deleteRetained: false,
  version: "1.1.0",
  finishedAt: "2026-09-27T09:00:00.000Z",
  ...over,
});

const CLEANUP = {
  workerName: "appflare",
  workerSettingsUrl: "https://dash.cloudflare.com/x",
  repositorySearchUrl: "https://github.com/search?q=appflare",
};

const R2_ROW: AccountAttentionRow = {
  id: "r2",
  name: "R2 storage",
  found: "Not turned on",
  why: "Object storage.",
  dismissible: true,
  neededBy: ["a"],
};
const DEV_ROW: AccountAttentionRow = {
  id: "workers-dev",
  name: "workers.dev address",
  found: null,
  why: "Addresses.",
  dismissible: true,
  neededBy: ["a"],
};

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    isAdmin: true,
    apps: [],
    failedJobs: [],
    accountRows: [],
    dismissedAccountRows: new Set(),
    deployCopy: null,
    downgrade: null,
    ...over,
  };
}

/** Every kind of row at once, given in the reverse of their order. */
const EVERYTHING = input({
  apps: [
    app({ id: "links", label: "Links", latestVersion: "1.1.0", updateAvailable: true }),
    app({ id: "share", label: "Share", accessRequired: true }),
    app({ id: "stats", label: "Stats", healthStatus: "unhealthy" }),
    app({ id: "chat", label: "Chat" }),
  ],
  failedJobs: [job({ id: "j1", installId: "chat" })],
  accountRows: [R2_ROW],
  deployCopy: CLEANUP,
  downgrade: { version: "0.5.0", deployButton: false },
});

const kinds = (items: readonly AttentionItem[]) => items.map((i) => i.kind);

describe("attentionItems", () => {
  it("orders rows by severity: failures, not responding, updates, account, then notices", () => {
    const items = attentionItems(EVERYTHING);
    expect(kinds(items)).toEqual([...SEVERITY_ORDER]);
    expect(SEVERITY_ORDER).toEqual([
      "failed-job",
      "not-responding",
      "access-required",
      "update",
      "account",
      "deploy-copy",
      "downgrade",
    ]);
  });

  it("lists an installed app whose entry now requires Cloudflare Access while it is not protected", () => {
    const items = attentionItems(
      input({
        isAdmin: false,
        apps: [
          app({ id: "share", label: "Share", accessRequired: true }),
          app({ id: "busy", label: "Busy", accessRequired: true, status: "updating" }),
          app({ id: "fine", label: "Fine", accessRequired: false }),
        ],
      }),
    );
    expect(items).toEqual([
      { kind: "access-required", key: "access:share", installId: "share", label: "Share" },
    ]);
    const [item] = items;
    if (item === undefined) throw new Error("no row");
    expect(attentionCopy(item)).toEqual({
      title: "Share must run behind Cloudflare Access",
      description:
        "The catalog now says this app must run behind Cloudflare Access. Appflare never protects it on its own, and holds its updates until it is protected.",
    });
  });

  it("is empty when nothing needs attention", () => {
    const items = attentionItems(input({ apps: [app({ id: "a" }), app({ id: "b" })] }));
    expect(items).toEqual([]);
    expect(attentionBadge(items)).toEqual({ count: 0, label: "0 things need your attention" });
  });

  it("lists a failed job of a listed app with its log, and not while the app has a job running", () => {
    const failed = job({ id: "j9", installId: "a", kind: "install", version: null });
    const items = attentionItems(
      input({ apps: [app({ id: "a", label: "Links", status: "failed" })], failedJobs: [failed] }),
    );
    expect(items).toEqual([
      { kind: "failed-job", key: "job:j9", installId: "a", label: "Links", job: failed },
    ]);
    for (const status of ["installing", "updating"]) {
      expect(
        attentionItems(input({ apps: [app({ id: "a", status })], failedJobs: [failed] })),
      ).toEqual([]);
    }
    // An app that is no longer listed (uninstalled) has no row.
    expect(attentionItems(input({ failedJobs: [failed] }))).toEqual([]);
  });

  it("lists an installed app that did not answer or answered with an error", () => {
    const items = attentionItems(
      input({
        apps: [
          app({ id: "a", label: "B", healthStatus: "unverified" }),
          app({ id: "b", label: "A", healthStatus: "unhealthy" }),
          app({ id: "c", healthStatus: null }),
          app({ id: "d", healthStatus: "unhealthy", status: "updating" }),
        ],
      }),
    );
    expect(items.map((i) => (i.kind === "not-responding" ? [i.label, i.health] : null))).toEqual([
      ["A", "unhealthy"],
      ["B", "unverified"],
    ]);
  });

  it("does not list an app whose last check Cloudflare Access answered, and gives it no dot", () => {
    const items = attentionItems(
      input({
        apps: [
          app({ id: "a", label: "Behind", healthStatus: "unverified", healthAccess: true }),
          app({ id: "b", label: "Down", healthStatus: "unverified" }),
        ],
      }),
    );
    expect(items.map((i) => ("installId" in i ? i.installId : null))).toEqual(["b"]);
    expect(appSignals(items).has("a")).toBe(false);
  });

  it("lists updates, with why an update waits for the admin (Review)", () => {
    const items = attentionItems(
      input({
        apps: [
          app({ id: "a", label: "Links", latestVersion: "1.1.0", updateAvailable: true }),
          app({
            id: "b",
            label: "Builds",
            latestVersion: "2.0.0",
            updateAvailable: true,
            updateNeeds: "It is built in your account.",
          }),
          app({ id: "c", label: "Chat", latestVersion: "1.1.0", updateAvailable: true }),
          app({ id: "d", latestVersion: null, updateAvailable: true }),
          app({ id: "e", latestVersion: "1.1.0", updateAvailable: true, status: "updating" }),
        ],
        leftForAdmin: new Map([["c", "It needs a value for API_KEY."]]),
      }),
    );
    expect(
      items.map((i) => (i.kind === "update" ? [i.label, i.latestVersion, i.needs] : null)),
    ).toEqual([
      ["Builds", "2.0.0", "It is built in your account."],
      ["Chat", "1.1.0", "It needs a value for API_KEY."],
      ["Links", "1.1.0", null],
    ]);
    // "Update all" starts only the ones that need nothing.
    expect(updateAllTargets(items).map((i) => i.installId)).toEqual(["a"]);
  });

  it("lists account rows for admins only, without the ones put away with Not needed", () => {
    const rows = [R2_ROW, DEV_ROW];
    const admin = attentionItems(input({ accountRows: rows }));
    expect(admin.map((i) => i.key)).toEqual(["account:r2", "account:workers-dev"]);

    const dismissed = attentionItems(
      input({ accountRows: rows, dismissedAccountRows: new Set([accountRowKey(R2_ROW)]) }),
    );
    expect(dismissed.map((i) => i.key)).toEqual(["account:workers-dev"]);

    expect(attentionItems(input({ isAdmin: false, accountRows: rows }))).toEqual([]);
  });

  it("brings a put-away row back when another app needs it", () => {
    const key = accountRowKey(R2_ROW);
    const later = { ...R2_ROW, neededBy: ["a", "b"] };
    expect(accountRowKey(later)).not.toBe(key);
    const items = attentionItems(
      input({ accountRows: [later], dismissedAccountRows: new Set([key]) }),
    );
    expect(items.map((i) => i.key)).toEqual(["account:r2"]);
  });

  it("never hides a row every app needs, such as the token's permissions", () => {
    const token = {
      id: "token-permissions" as const,
      name: "Token permissions",
      found: "Missing permissions Appflare needs",
      why: "Appflare works through this token.",
      dismissible: false,
      neededBy: [],
    };
    const items = attentionItems(
      input({ accountRows: [token], dismissedAccountRows: new Set([accountRowKey(token)]) }),
    );
    expect(items.map((i) => i.key)).toEqual(["account:token-permissions"]);
  });

  it("ends with the deploy-copy cleanup and the downgrade notice", () => {
    const items = attentionItems(
      input({ deployCopy: CLEANUP, downgrade: { version: "0.5.0", deployButton: true } }),
    );
    expect(items).toEqual([
      { kind: "deploy-copy", key: "deploy-copy", cleanup: CLEANUP },
      { kind: "downgrade", key: "downgrade", downgrade: { version: "0.5.0", deployButton: true } },
    ]);
  });
});

describe("the sidebar's count and dots", () => {
  it("counts every row on Home", () => {
    const items = attentionItems(EVERYTHING);
    expect(attentionBadge(items)).toEqual({ count: 7, label: "7 things need your attention" });
    expect(attentionBadge(items.slice(0, 1))).toEqual({
      count: 1,
      label: "1 thing needs your attention",
    });
  });

  it("follows Not needed", () => {
    const before = attentionBadge(attentionItems(EVERYTHING)).count;
    const after = attentionBadge(
      attentionItems({ ...EVERYTHING, dismissedAccountRows: new Set([accountRowKey(R2_ROW)]) }),
    ).count;
    expect(after).toBe(before - 1);
  });

  it("gives each app the dot of its most severe row, and none to apps without one", () => {
    const items = attentionItems(
      input({
        apps: [
          app({
            id: "a",
            latestVersion: "2.0.0",
            updateAvailable: true,
            healthStatus: "unhealthy",
          }),
          app({ id: "b", latestVersion: "2.0.0", updateAvailable: true }),
          app({ id: "c", latestVersion: "2.0.0", updateAvailable: true }),
          app({ id: "d" }),
        ],
        failedJobs: [job({ id: "j1", installId: "c" })],
      }),
    );
    expect(Object.fromEntries(appSignals(items))).toEqual({
      a: "not-responding",
      b: "update",
      c: "failed",
    });
  });
});

describe("the rows' words", () => {
  it("says what did not finish, by job", () => {
    const at = (over: Partial<FailedJob>) =>
      failedJobTitle(job({ id: "j", installId: "a", ...over }), "Links");
    expect(at({ kind: "install" })).toBe("Installing Links did not finish");
    expect(at({ kind: "update" })).toBe("Updating Links to 1.1.0 did not finish");
    expect(at({ kind: "update", version: null })).toBe("Updating Links did not finish");
    expect(at({ kind: "uninstall" })).toBe("Removing Links did not finish");
    expect(at({ kind: "uninstall", deleteRetained: true })).toBe(
      "Deleting the kept data of Links did not finish",
    );
    expect(at({ kind: "rollback" })).toBe("Rolling back Links did not finish");
    expect(at({ kind: "rollback", restore: true })).toBe(
      "Restoring the database of Links did not finish",
    );
    expect(at({ kind: "reconfigure" })).toBe("Saving the settings of Links did not finish");
  });

  it("names no Worker, and gives every row a title and a line", () => {
    for (const item of attentionItems(EVERYTHING)) {
      const { title, description } = attentionCopy(item);
      expect(title).not.toBe("");
      expect(description).not.toBe("");
      expect(`${title} ${description}`).not.toContain(CLEANUP.workerName);
    }
  });
});
