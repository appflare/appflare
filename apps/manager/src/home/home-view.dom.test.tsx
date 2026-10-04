import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartUpdateHandle } from "../components/update-banner";
import { installLabel } from "../installs/display-name";
import { type AccountAttentionRow, type AttentionInput, attentionItems } from "./attention";
import type { HomeApp } from "./layout-data";

// Actions reach the server and the router; these tests only look and click.
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));
vi.mock("../installs/health.functions", () => ({ checkInstallHealth: vi.fn() }));
vi.mock("../installs/update-all.functions", () => ({ startAllUpdates: vi.fn() }));
vi.mock("../deploy-button/deploy-copy.functions", () => ({ dismissDeployCopy: vi.fn() }));

const { HomeView } = await import("./home-view");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function app(over: Partial<HomeApp> & { id: string; name: string }): HomeApp {
  const worker = `${over.name.toLowerCase()}-worker`;
  return {
    slug: over.name.toLowerCase(),
    catalogSource: null,
    origin: "catalog",
    icon: null,
    displayName: null,
    label: worker,
    workerName: worker,
    status: "installed",
    version: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    reinstallNeeded: false,
    address: `https://${worker}.acme.workers.dev`,
    updatedAt: "2026-09-24T12:00:00.000Z",
    uninstalledAt: null,
    healthStatus: "verified",
    healthAccess: false,
    healthCheckedAt: null,
    updateNeeds: null,
    ...over,
  };
}

const update: StartUpdateHandle = { start: vi.fn(), pendingId: null, error: null, dialog: null };

const FULL: HomeApp[] = [
  app({ id: "a", name: "Chat" }),
  app({ id: "b", name: "Stats", healthStatus: "unhealthy" }),
  app({
    id: "c",
    name: "Cut",
    displayName: "Short links",
    latestVersion: "1.1.0",
    updateAvailable: true,
  }),
  app({ id: "d", name: "Feed", latestVersion: "2.0.0", updateAvailable: true }),
  app({
    id: "e",
    name: "Builds",
    latestVersion: "3.0.0",
    updateAvailable: true,
    updateNeeds: "It is built in your account.",
    address: null,
  }),
];

function items(apps: HomeApp[], over: Partial<AttentionInput> = {}) {
  return attentionItems({
    isAdmin: true,
    apps: apps.map((a) => ({ ...a, label: installLabel(a) })),
    failedJobs: [],
    accountRows: [],
    dismissedAccountRows: new Set(),
    deployCopy: null,
    downgrade: null,
    ...over,
  });
}

const FULL_INPUT: Partial<AttentionInput> = {
  failedJobs: [
    {
      id: "job1",
      installId: "a",
      kind: "update",
      restore: false,
      deleteRetained: false,
      version: "1.1.0",
      finishedAt: null,
    },
  ],
  accountRows: [
    {
      id: "r2",
      name: "R2 storage",
      found: "Not turned on",
      why: "Object storage.",
      dismissible: true,
      neededBy: ["c"],
    },
    {
      id: "token-permissions",
      name: "Token permissions",
      found: "Missing permissions Appflare needs",
      why: "Appflare works through this token.",
      dismissible: false,
      neededBy: [],
    },
  ],
  deployCopy: {
    workerName: "appflare",
    workerSettingsUrl: "https://dash",
    repositorySearchUrl: "https://gh",
  },
  downgrade: { version: "0.5.0", deployButton: false },
};

function render(
  apps: HomeApp[],
  opts: {
    isAdmin?: boolean;
    input?: Partial<AttentionInput>;
    onDismiss?: (row: AccountAttentionRow) => void;
  } = {},
) {
  const isAdmin = opts.isAdmin ?? true;
  act(() =>
    root.render(
      <Toasty>
        <HomeView
          apps={apps}
          items={items(apps, { isAdmin, ...opts.input })}
          isAdmin={isAdmin}
          update={update}
          onDismissAccountRow={opts.onDismiss ?? (() => {})}
          onUpdateAllOutcome={() => {}}
          now={new Date("2026-09-27T12:00:00.000Z")}
        />
      </Toasty>,
    ),
  );
}

const section = () => container.querySelector("#needs-attention");
const buttons = (scope: Element | null) =>
  [...(scope?.querySelectorAll("button, a") ?? [])].map((b) => b.textContent?.trim());
const cards = () => [...container.querySelectorAll("[data-app-card]")];

describe("Home", () => {
  it("lists what needs attention, most urgent first, with one action each", () => {
    const dismissed: string[] = [];
    render(FULL, { input: FULL_INPUT, onDismiss: (row) => dismissed.push(row.id) });
    const text = section()?.textContent ?? "";
    const order = [
      "Updating Chat to 1.1.0 did not finish",
      "Stats is not responding",
      "Builds 3.0.0 is available",
      "Feed 2.0.0 is available",
      "Short links 1.1.0 is available",
      "R2 storage",
      "Token permissions",
      "Clean up the deploy copy",
      "This Appflare (0.5.0) is older than its database",
    ];
    const at = order.map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);

    expect(buttons(section())).toEqual([
      "Update all",
      "View log",
      "Check again",
      "Review",
      "Update",
      "Update",
      "Not needed",
      "Go to Your account",
      // The token's permissions: no "Not needed", every app needs them.
      "Go to Your account",
      "Done",
      "Show the steps",
      "Update Appflare",
    ]);
    expect(section()?.querySelector("a[href='/jobs/job1']")).not.toBeNull();
    expect(section()?.querySelector("a[href='/apps/e']")?.textContent).toBe("Review");
    expect(section()?.querySelector("a[href='/settings/account#capability-r2']")).not.toBeNull();

    const notNeeded = [...(section()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Not needed",
    );
    act(() => notNeeded?.click());
    expect(dismissed).toEqual(["r2"]);
  });

  it("shows the apps as cards by name, Open only with an address, and no Worker names", () => {
    render(FULL, { input: FULL_INPUT });
    expect(cards().map((c) => c.getAttribute("data-app-name"))).toEqual([
      "Builds",
      "Chat",
      "Feed",
      "Short links",
      "Stats",
    ]);
    const builds = cards()[0];
    expect(buttons(builds ?? null)).toEqual(["Manage"]);
    expect(buttons(cards()[1] ?? null)).toEqual(["Open", "Manage"]);
    expect(builds?.querySelector("a[href='/apps/e']")).not.toBeNull();
    expect(cards()[1]?.textContent).toContain("Last change did not finish");
    expect(cards()[4]?.textContent).toContain("Not responding");
    expect(cards()[2]?.textContent).toContain("Update available");
    expect(container.textContent).not.toContain("-worker");
  });

  it("lays out Your apps as one section card, its tiles split by hairlines, not cards", () => {
    render(FULL, { input: FULL_INPUT });
    const yours = container.querySelector("section#your-apps");
    expect(yours?.querySelector("h2")?.textContent).toBe("Your apps");
    const layered = '[class*="bg-kumo-elevated text-base ring ring-kumo-hairline"]';
    expect(yours?.querySelectorAll(layered).length).toBe(1);
    const surface = '[class*="bg-kumo-base shadow-xs ring ring-kumo-line"]';
    expect(yours?.querySelectorAll(surface).length).toBe(0);
    for (const tile of cards()) {
      expect(yours?.contains(tile)).toBe(true);
      expect(tile.className).toContain("border-kumo-hairline");
    }
  });

  it("hides Needs attention when nothing needs it", () => {
    const calm = [app({ id: "a", name: "Chat" }), app({ id: "b", name: "Stats" })];
    render(calm);
    expect(section()).toBeNull();
    expect(cards()).toHaveLength(2);
    expect(cards()[0]?.textContent).toContain("Running · 1.0.0 · updated 3 days ago");
  });

  it("offers the catalog when nothing is installed", () => {
    render([]);
    expect(section()).toBeNull();
    expect(cards()).toHaveLength(0);
    expect(container.textContent).toContain("No apps installed yet");
    const browse = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Browse the catalog",
    );
    expect(browse?.getAttribute("href")).toBe("/catalog");
  });

  it("asks to turn on Cloudflare Access for an app whose entry now requires it", () => {
    const share = app({ id: "s", name: "Share", accessRequired: true });
    render([share]);
    expect(section()?.textContent).toContain("Share must run behind Cloudflare Access");
    expect(buttons(section())).toEqual(["Turn on"]);
    expect(section()?.querySelector("a[href='/apps/s#access']")?.textContent).toBe("Turn on");
    render([share], { isAdmin: false });
    expect(buttons(section())).toEqual(["Manage"]);
  });

  it("gives members the list without the admin actions", () => {
    render(FULL, { isAdmin: false, input: { ...FULL_INPUT, deployCopy: null } });
    expect(buttons(section())).toEqual([
      "View log",
      "Manage",
      "Manage",
      "Manage",
      "Manage",
      "Update Appflare",
    ]);
  });

  it("offers Update all only while two updates can start at once", () => {
    render([FULL[2] as HomeApp, FULL[4] as HomeApp]);
    // One update that can start, and one to review: no "Update all".
    expect(buttons(section())).toEqual(["Review", "Update"]);
  });
});
