import { Toasty } from "@cloudflare/kumo";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";

import type { CatalogView } from "../catalog/catalogs.functions";
import type { ManagerUpdateState } from "../catalog/manager-releases.functions";
import type { GatewayView } from "../gateway/gateway.server";
import type { RemovedAppRow } from "../installs/removed-apps.functions";
import type { ManagerVersionsState } from "../jobs/self-update/rollback.functions";
import type { ChannelView } from "../notifications/channels";
import type { ChecklistData } from "../onboarding/checklist.server";
import { NO_SANDBOX_JOBS } from "../sandbox/readiness";
import type { AccessStatus } from "../server/access.functions";
import type { PasskeyRow } from "../server/passkeys.functions";
import type { PasswordRecoverySettings } from "../server/recovery.functions";
import type { SandboxCardState } from "../server/sandbox.functions";
import type { TokenStatus } from "../server/token.functions";
import type { UserRow } from "../server/users.functions";
import {
  AccountSettingsView,
  AppflareUpdatesSettingsView,
  CatalogsSettingsView,
  DomainsSettingsView,
  GeneralSettingsView,
  NotificationsSettingsView,
  RemovedAppsSettingsView,
  UsageDataSettingsView,
  UsersSettingsView,
} from "./settings-pages";

// The pages' actions call server functions, which only exist under the Start
// Vite plugin. Rendering never calls them; they stand in as functions that fail.
vi.mock("@tanstack/react-start", () => {
  const notHere = async () => {
    throw new Error("server functions do not run in this test");
  };
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    middleware: () => chain,
    handler: () => notHere,
  };
  return { createServerFn: () => chain };
});
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://appflare.example.com/"),
  getCookie: () => undefined,
  setCookie: () => {},
  deleteCookie: () => {},
  getRequestHeader: () => undefined,
}));

/** Kumo's card surface; a settings page has one per section and none inside another. */
const CARD = "bg-kumo-base shadow-xs ring ring-kumo-line";

function render(element: ReactElement): string {
  // Dialog triggers read the toast manager; the app provides it at its root.
  return renderToStaticMarkup(createElement(Toasty, null, element));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** The ids of the page's sections, in order. */
function sectionIds(html: string): string[] {
  return [...html.matchAll(/<section id="([^"]+)" aria-labelledby=/g)].map((m) => m[1] ?? "");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The page has one card per section, no breadcrumbs, and the actions named. */
function expectPattern(html: string, ids: string[], actions: string[]) {
  expect(sectionIds(html)).toEqual(ids);
  expect(count(html, CARD)).toBe(ids.length);
  expect(html).not.toContain('aria-label="breadcrumb"');
  expect(html).not.toMatch(/>Settings<\/a>/);
  for (const action of actions) expect(text(html)).toContain(action);
}

const ISO = "2026-09-25T10:00:00.000Z";
const autoUpdate = { apps: true, manager: false, devBuild: false };

const tokenStatus: TokenStatus = {
  configured: true,
  accountId: "0123456789abcdef",
  accountName: "Acme",
  workerName: "appflare",
  verifiedAt: ISO,
  hasSecret: true,
};

const capabilities = capabilitiesView(undefined, {
  checkedAt: ISO,
  r2: { state: "enabled" },
  containers: { state: "available" },
  workersPlan: { state: "paid" },
  zone: { state: "available" },
  emailRouting: { state: "available" },
  workersDev: { state: "registered", subdomain: "acme" },
  zeroTrust: { state: "none" },
});

const checklist: ChecklistData = {
  view: capabilities,
  sandbox: "off",
  needs: null,
  accountId: null,
  sandboxJobs: NO_SANDBOX_JOBS,
};

const sandboxStatus: SandboxCardState = {
  connected: false,
  info: null,
  problem: null,
  workerExists: false,
  pinnedVersion: "0.1.3",
  updateAvailable: false,
  activeJob: null,
  lastFailure: null,
  inUseBy: [],
  readiness: { state: "ready-auto", missing: null, confirmed: true },
};

describe("GeneralSettingsView", () => {
  it("shows automatic updates, then the danger zone last with both actions", () => {
    const html = render(
      createElement(GeneralSettingsView, {
        autoUpdate,
        danger: { authSecretRotatedAt: null },
        viewer: { role: "admin", isOwner: true },
      }),
    );
    expectPattern(
      html,
      ["automatic-updates", "danger-zone"],
      ["Automatically update apps", "Rotate auth secret", "Remove Appflare"],
    );
    expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
  });
});

describe("AccountSettingsView", () => {
  it("keeps the connection, checklist, capabilities, sandbox builds and GitHub access", () => {
    const html = render(
      createElement(AccountSettingsView, {
        tokenStatus,
        capabilities,
        sandboxStatus,
        checklist,
        isAdmin: true,
      }),
    );
    expectPattern(
      html,
      ["connection", "checklist", "capabilities", "sandbox", "github-access"],
      ["Rotate token", "Re-check", "Enable sandbox builds", "Loading the tokens"],
    );
    expect(text(html)).toContain("Acme");
    expect(count(html, ">Re-check<")).toBe(2);
  });

  it("offers members no action", () => {
    const html = render(
      createElement(AccountSettingsView, {
        tokenStatus,
        capabilities,
        sandboxStatus,
        checklist,
        isAdmin: false,
      }),
    );
    // GitHub access is for admins only.
    expect(sectionIds(html)).toEqual(["connection", "checklist", "capabilities", "sandbox"]);
    expect(text(html)).not.toContain("Rotate token");
    expect(count(html, ">Re-check<")).toBe(0);
  });
});

describe("UsersSettingsView", () => {
  const users: UserRow[] = [
    {
      id: "u1",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      isOwner: true,
      createdAt: ISO,
    },
    {
      id: "u2",
      email: "member@example.com",
      name: "Member",
      role: "member",
      isOwner: false,
      createdAt: ISO,
    },
  ];
  const passkeys: PasskeyRow[] = [
    { id: "p1", name: "Laptop", provider: "1Password", synced: true, createdAt: ISO },
  ];
  const accessStatus: AccessStatus = {
    enabled: false,
    domain: null,
    teamDomain: null,
    enabledAt: null,
    adminEmails: ["owner@example.com"],
    currentHostname: "appflare.example.com",
  };

  const recovery: PasswordRecoverySettings = {
    email: { bound: false, sender: null, enabled: false },
    viewerIsOwner: true,
    lastRecovery: null,
  };

  it("keeps users, forgotten passwords, your passkeys and Cloudflare Access with their actions", () => {
    const html = render(
      createElement(UsersSettingsView, {
        users,
        recovery,
        passkeys,
        accessStatus,
        viewer: { id: "u1", email: "owner@example.com", role: "admin" },
      }),
    );
    expectPattern(
      html,
      ["users", "forgotten-passwords", "passkeys", "access"],
      [
        "Add user",
        "member@example.com",
        "Password reset emails",
        "Turn on",
        "Laptop",
        "Remove",
        "Protect with Cloudflare Access",
      ],
    );
  });

  it("tells members they cannot see the users", () => {
    const html = render(
      createElement(UsersSettingsView, {
        users: null,
        recovery: null,
        passkeys: [],
        accessStatus,
        viewer: { id: "u2", email: "member@example.com", role: "member" },
      }),
    );
    expectPattern(html, ["users", "passkeys", "access"], ["Only admins can view and add users."]);
    expect(text(html)).not.toContain("Add user");
    expect(text(html)).toContain("No passkeys yet");
  });
});

describe("UsageDataSettingsView", () => {
  it("keeps the switch and the preview", () => {
    const html = render(
      createElement(UsageDataSettingsView, {
        telemetry: { state: "on", lockedBy: null, devBuild: false },
        isAdmin: true,
      }),
    );
    expectPattern(html, ["usage-data"], ["Preview"]);
    expect(html).toContain('role="switch"');
  });
});

describe("DomainsSettingsView", () => {
  it("keeps the gateway, or says why it cannot be read", () => {
    const view: GatewayView = {
      gateway: null,
      zones: [{ id: "z1", name: "example.com" }],
      accountId: "0123456789abcdef",
    };
    const html = render(createElement(DomainsSettingsView, { view, isAdmin: true }));
    expectPattern(html, ["external-domains"], ["Not set up", "Set up gateway"]);

    const failed = render(
      createElement(DomainsSettingsView, {
        view: { error: "Cloudflare did not answer." },
        isAdmin: true,
      }),
    );
    expectPattern(failed, ["external-domains"], ["Cloudflare did not answer."]);
  });
});

describe("NotificationsSettingsView", () => {
  const channel: ChannelView = {
    id: "c1",
    kind: "slack",
    label: "Team",
    target: "Slack",
    events: ["update_available"],
    failureCount: 0,
    lastError: null,
    lastFailureAt: null,
    lastSuccessAt: ISO,
    pending: 0,
    readable: true,
    createdAt: ISO,
  };

  it("lists channels as rows of one card, with Add channel in the header", () => {
    const html = render(
      createElement(NotificationsSettingsView, {
        channels: [channel, { ...channel, id: "c2", label: "Ops" }],
      }),
    );
    expectPattern(html, ["channels"], ["Add channel", "Team", "Ops", "Send test", "Edit"]);
    expect(html).toContain('id="channel-c2"');
  });

  it("offers Add channel from the empty state, and tells members it is for admins", () => {
    const empty = render(createElement(NotificationsSettingsView, { channels: [] }));
    expectPattern(empty, ["channels"], ["No notification channels", "Add channel"]);
    const member = render(createElement(NotificationsSettingsView, { channels: null }));
    expectPattern(member, ["channels"], ["Only admins"]);
    expect(text(member)).not.toContain("Add channel");
  });
});

describe("CatalogsSettingsView", () => {
  const official: CatalogView = {
    id: "official",
    label: "Appflare",
    colour: "orange",
    official: true,
    indexUrl: "https://catalog.example.com/index.json",
    enabled: true,
    keys: [],
    addedAt: null,
    refreshedAt: ISO,
    refreshError: null,
    apps: 12,
    installs: 2,
  };

  it("lists the catalogs as rows of one card, with Add a catalog in the header", () => {
    const html = render(
      createElement(CatalogsSettingsView, {
        catalogs: [
          official,
          { ...official, id: "mine", label: "Mine", official: false, addedAt: ISO },
        ],
        isAdmin: true,
      }),
    );
    expectPattern(html, ["catalogs"], ["Add a catalog", "Mine", "Remove"]);
    expect(count(html, 'role="switch"')).toBe(2);
  });
});

describe("RemovedAppsSettingsView", () => {
  const row: RemovedAppRow = {
    id: "i1",
    slug: "cut",
    label: "Cut",
    name: "Cut",
    workerName: "cut-1",
    uninstalledAt: ISO,
    retained: [{ id: "r1", kind: "d1", binding: "DB", name: "cut-db", cfId: null }],
    activeJobId: null,
    lastFailure: {
      jobId: "j1",
      error: "It stopped; see [the domains settings](/settings/domains#external-domains).",
    },
  };

  it("lists what each app kept, with its actions and its last failure's links", () => {
    const html = render(createElement(RemovedAppsSettingsView, { rows: [row], isAdmin: true }));
    expectPattern(html, ["removed-apps"], ["Cut", "cut-db", "Delete", "Forget", "View log"]);
    expect(html).toContain('href="/settings/domains#external-domains"');
  });

  it("shows the empty state when nothing is kept", () => {
    const html = render(createElement(RemovedAppsSettingsView, { rows: [], isAdmin: true }));
    expectPattern(html, ["removed-apps"], ["No removed apps"]);
  });
});

describe("AppflareUpdatesSettingsView", () => {
  const managerUpdate: ManagerUpdateState = {
    current: "0.4.0",
    latest: { version: "0.5.0", tag: "manager@0.5.0", publishedAt: ISO },
    updateAvailable: true,
    checkedAt: ISO,
    activeJobId: null,
  };
  const versions: ManagerVersionsState = {
    ok: true,
    servingVersionId: "v2",
    versions: [
      {
        id: "v2aaaaaaaa",
        number: 2,
        createdOn: ISO,
        appflareVersion: "0.4.0",
        trigger: "upload",
        message: null,
        serving: true,
        older: false,
      },
      {
        id: "v1aaaaaaaa",
        number: 1,
        createdOn: ISO,
        appflareVersion: "0.3.0",
        trigger: "upload",
        message: null,
        serving: false,
        older: true,
      },
    ],
  };

  it("keeps the version, the update, automatic updates and the versions with Roll back", () => {
    const html = render(
      createElement(AppflareUpdatesSettingsView, {
        managerUpdate,
        autoUpdate,
        versions,
        isAdmin: true,
      }),
    );
    expectPattern(
      html,
      ["appflare", "versions"],
      ["Update Appflare to 0.5.0", "Check now", "Automatically update Appflare", "Roll back"],
    );
  });

  it("shows why the versions cannot be listed", () => {
    const html = render(
      createElement(AppflareUpdatesSettingsView, {
        managerUpdate: { ...managerUpdate, updateAvailable: false },
        autoUpdate,
        versions: { ok: false, error: "The token cannot read Workers." },
        isAdmin: true,
      }),
    );
    expectPattern(html, ["appflare", "versions"], ["Check now", "The token cannot read Workers."]);
    expect(text(html)).not.toContain("Update Appflare to");
  });
});
