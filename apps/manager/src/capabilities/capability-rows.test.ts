import { describe, expect, it } from "vitest";
import { dashboardLinks } from "../cloudflare/dashboard-links";
import { type CapabilitiesView, capabilitiesView, type StoredCapabilities } from "./capabilities";
import {
  ANALYTICS_ENGINE_CAPABILITY_LINK,
  type CapabilityId,
  type CapabilityRow,
  type CapabilityRowsInput,
  type CapabilityState,
  type CatalogNeeds,
  capabilityAnchor,
  capabilityProgress,
  capabilityRows,
  catalogNeeds,
  installedNeeds,
  progressLabel,
  rowsNeedingAction,
} from "./capability-rows";

const ACC = "acc0000000000000000000000000000a";
const DASH = `https://dash.cloudflare.com/?to=/${ACC}`;
const CHECKED = "2026-09-24T10:00:00.000Z";
const NO_PERMISSION = { state: "unknown", reason: "no-permission", detail: "HTTP 403" } as const;
const FAILED = { state: "unknown", reason: "error", detail: "HTTP 503 from Cloudflare" } as const;

/** Everything a Workers Paid account can have, all found. */
const EVERYTHING: StoredCapabilities = {
  checkedAt: CHECKED,
  r2: { state: "enabled" },
  containers: { state: "available" },
  workersPlan: { state: "paid" },
  zone: { state: "available" },
  emailRouting: { state: "available" },
  workersDev: { state: "registered", subdomain: "acme" },
  zeroTrust: { state: "exists", teamDomain: "acme.cloudflareaccess.com" },
  analyticsEngine: { state: "enabled" },
};

/** A Workers Free account with R2 off and no Zero Trust organization. */
const FREE: StoredCapabilities = {
  ...EVERYTHING,
  r2: { state: "not-enabled" },
  containers: { state: "needs-workers-paid" },
  workersPlan: { state: "free" },
  zeroTrust: { state: "none" },
};

const NEEDS: CatalogNeeds = {
  total: 12,
  workersPaid: 3,
  r2: 4,
  analyticsEngine: 2,
  zone: 2,
  emailRouting: 1,
  access: 0,
  sandbox: 1,
};

const NOTHING_IN_USE: CatalogNeeds = {
  total: 0,
  workersPaid: 0,
  r2: 0,
  analyticsEngine: 0,
  zone: 0,
  emailRouting: 0,
  access: 0,
  sandbox: 0,
};

/** Apps in the account that need every optional thing. */
const ALL_IN_USE: CatalogNeeds = {
  total: 3,
  workersPaid: 1,
  r2: 1,
  analyticsEngine: 1,
  zone: 1,
  emailRouting: 1,
  access: 1,
  sandbox: 1,
};

function view(
  stored: StoredCapabilities | null,
  manual: string | null = null,
  accountId: string | null = ACC,
): CapabilitiesView {
  return capabilitiesView(manual, stored, accountId);
}

function rows(
  stored: StoredCapabilities | null,
  input: Partial<CapabilityRowsInput> & { manual?: string | null } = {},
): Record<CapabilityId, CapabilityRow> {
  const { manual = null, ...rest } = input;
  const list = capabilityRows({
    view: view(stored, manual),
    sandbox: "off",
    needs: NEEDS,
    ...rest,
  });
  return Object.fromEntries(list.map((r) => [r.id, r])) as Record<CapabilityId, CapabilityRow>;
}

function states(byId: Record<CapabilityId, CapabilityRow>): Record<CapabilityId, CapabilityState> {
  return Object.fromEntries(Object.values(byId).map((r) => [r.id, r.state])) as Record<
    CapabilityId,
    CapabilityState
  >;
}

describe("capabilityRows", () => {
  it("lists one row per capability, in order, each with a name and one sentence on why", () => {
    const list = capabilityRows({ view: view(EVERYTHING), sandbox: "off", needs: NEEDS });
    expect(list.map((r) => r.id)).toEqual([
      "workers-plan",
      "workers-dev",
      "r2",
      "zone",
      "email-routing",
      "analytics-engine",
      "zero-trust",
      "sandbox",
      "token-permissions",
    ]);
    expect(list.map((r) => r.name)).toEqual([
      "Workers plan",
      "workers.dev address",
      "R2 storage",
      "A domain",
      "Email Routing",
      "Analytics Engine",
      "Zero Trust",
      "Sandbox builds",
      "Token permissions",
    ]);
    for (const row of list) {
      // One plain sentence, no probe or permission names.
      expect(row.why).toMatch(/^[A-Z].*\.$/);
      expect(row.why).not.toMatch(/probe|HTTP|permission group/i);
    }
  });

  it("shows everything ready, with nothing to do, on an account that has it all", () => {
    const byId = rows(EVERYTHING, { sandbox: "enabled" });
    for (const row of Object.values(byId)) {
      expect(row.state).toBe("ready");
      expect(row.action).toBeNull();
      expect(row.details.checkedAt).toBe(CHECKED);
      expect(row.details.problem).toBeNull();
    }
    expect(byId["workers-plan"].details).toMatchObject({
      found: "Workers Paid",
      source: "detected",
    });
    expect(byId["workers-dev"].details.found).toBe("acme.workers.dev");
    expect(byId["zero-trust"].details.found).toContain("acme.cloudflareaccess.com");
    expect(byId.sandbox.details.found).toBe("On");
    expect(byId["token-permissions"].details).toMatchObject({
      found: "Has what Appflare needs",
      note: null,
    });
  });

  it("on a fresh Workers Free account: R2 and Zero Trust not set up, sandbox builds paid only", () => {
    const byId = rows(FREE, { inUse: NOTHING_IN_USE });
    expect(states(byId)).toEqual({
      "workers-plan": "ready",
      "workers-dev": "ready",
      r2: "not-set-up",
      zone: "ready",
      "email-routing": "ready",
      "analytics-engine": "ready",
      "zero-trust": "not-set-up",
      sandbox: "paid-only",
      "token-permissions": "ready",
    });
    // Nothing shouts: no row needs action while no app needs what is off.
    expect(rowsNeedingAction(Object.values(byId))).toEqual([]);
    expect(byId["workers-plan"].details).toMatchObject({
      found: "Workers Free",
      source: "detected",
    });
    // A detected plan needs no choice.
    expect(byId["workers-plan"].action).toBeNull();
    expect(byId.r2.action).toEqual({
      kind: "turn-on",
      label: "Turn on in Cloudflare",
      href: `${DASH}/r2/overview`,
    });
    expect(byId["zero-trust"].action).toEqual({
      kind: "turn-on",
      label: "Turn on in Cloudflare",
      href: `https://one.dash.cloudflare.com/?to=/${ACC}/home`,
    });
    expect(byId.sandbox.action).toEqual({
      kind: "set-up",
      label: "Set up",
      href: "/settings/building#sandbox",
    });
    expect(byId.sandbox.details.problem).toBe(
      "Builds run in Cloudflare Containers, which only Workers Paid includes.",
    );
  });

  it("needs action only for what an app in the account needs", () => {
    const byId = rows(FREE, { inUse: { ...NOTHING_IN_USE, total: 1, r2: 1 } });
    expect(byId.r2.state).toBe("needs-action");
    expect(byId["zero-trust"].state).toBe("not-set-up");
    expect(rowsNeedingAction(Object.values(byId)).map((r) => r.id)).toEqual(["r2"]);
    // Left out, nothing counts as needed.
    expect(rows(FREE).r2.state).toBe("not-set-up");
  });

  it("says Could not check, with the probe's error, when a check failed", () => {
    const byId = rows({ ...EVERYTHING, r2: FAILED, zone: FAILED, emailRouting: FAILED });
    expect(byId.r2.state).toBe("could-not-check");
    expect(byId.r2.details.problem).toBe("The check failed: HTTP 503 from Cloudflare");
    expect(byId.r2.details.found).toBeNull();
    // No button: Check again is the way on.
    expect(byId.r2.action).toBeNull();
    expect(byId.zone.state).toBe("could-not-check");
    // Email Routing is read on a domain; without the domains it cannot say.
    expect(byId["email-routing"].state).toBe("could-not-check");
    expect(byId["email-routing"].details.problem).toBe(
      "Appflare checks Email Routing on a domain of the account, and could not list the domains.",
    );
  });

  it("says Could not check before the probes ever ran, and Not checked yet in the details", () => {
    const byId = rows(null);
    for (const row of Object.values(byId)) {
      if (row.id === "sandbox") continue;
      expect(row.state).toBe("could-not-check");
      expect(row.details.problem).toBe("Not checked yet.");
      expect(row.details.checkedAt).toBeNull();
    }
    // Only an undetected plan offers something: the admin states it.
    for (const row of Object.values(byId)) {
      if (row.id !== "workers-plan" && row.id !== "sandbox") expect(row.action).toBeNull();
    }
    expect(byId["workers-plan"].action).toEqual({ kind: "choose-plan", label: "Choose plan" });
    expect(byId["workers-plan"].details.found).toBe("Not known, treated as Workers Free");
  });

  it("reads a stored row from before the newer probes as not checked for those rows", () => {
    const { workersDev: _w, zeroTrust: _z, analyticsEngine: _a, ...older } = EVERYTHING;
    const byId = rows(older);
    expect(byId["workers-dev"].state).toBe("could-not-check");
    expect(byId["zero-trust"].details.problem).toBe("Not checked yet.");
    expect(byId.r2.state).toBe("ready");
  });

  describe("Workers plan", () => {
    it("offers Choose plan while the plan is not detected, and needs it when the token cannot read it", () => {
      const byId = rows({
        ...FREE,
        workersPlan: NO_PERMISSION,
        containers: NO_PERMISSION,
      });
      const plan = byId["workers-plan"];
      expect(plan.state).toBe("needs-action");
      expect(plan.action).toEqual({ kind: "choose-plan", label: "Choose plan" });
      expect(plan.details.problem).toContain("Billing: Read");
      expect(plan.details.source).toBeNull();
    });

    it("is ready once an admin chose it, still offering the choice, marked set by you", () => {
      const plan = rows(
        { ...FREE, workersPlan: NO_PERMISSION, containers: NO_PERMISSION },
        {
          manual: "paid",
        },
      )["workers-plan"];
      expect(plan.state).toBe("ready");
      expect(plan.action?.kind).toBe("choose-plan");
      expect(plan.details).toMatchObject({ found: "Workers Paid", source: "set-by-you" });
      // Why it is not detected stays in the details, as a note.
      expect(plan.details.note).toContain("Billing: Read");
    });

    it("could not check when the plan check failed outright", () => {
      const plan = rows({ ...FREE, workersPlan: FAILED, containers: FAILED })["workers-plan"];
      expect(plan.state).toBe("could-not-check");
      expect(plan.action?.kind).toBe("choose-plan");
      expect(plan.details.problem).toBe("The check failed: HTTP 503 from Cloudflare");
    });

    it("never offers Choose plan once the plan is detected", () => {
      for (const stored of [EVERYTHING, FREE]) {
        expect(rows(stored, { manual: "free" })["workers-plan"].action).toBeNull();
      }
    });
  });

  describe("workers.dev address", () => {
    it("needs action without one, linking to the registration page of the account", () => {
      const row = rows({ ...EVERYTHING, workersDev: { state: "not-registered" } })["workers-dev"];
      expect(row.state).toBe("needs-action");
      expect(row.details.found).toBe("No address registered");
      expect(row.action).toMatchObject({ href: `${DASH}/workers/onboarding` });
    });

    it("links to Workers & Pages while the account is not known", () => {
      const list = capabilityRows({
        view: view({ ...EVERYTHING, workersDev: { state: "not-registered" } }, null, null),
        sandbox: "off",
        needs: null,
      });
      const row = list.find((r) => r.id === "workers-dev");
      expect(row?.action).toMatchObject({
        href: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
      });
    });

    it("could not check when the token cannot read it", () => {
      const row = rows({ ...EVERYTHING, workersDev: NO_PERMISSION })["workers-dev"];
      expect(row.state).toBe("could-not-check");
      expect(row.details.problem).toContain("Workers Scripts");
    });
  });

  describe("R2, a domain, Email Routing, Analytics Engine, Zero Trust", () => {
    const lacking: StoredCapabilities = {
      ...EVERYTHING,
      r2: { state: "not-enabled" },
      zone: { state: "none" },
      emailRouting: { state: "no-zone" },
      analyticsEngine: { state: "not-enabled" },
      zeroTrust: { state: "none" },
    };

    it("needs action for each thing the account lacks and its apps need, with its dashboard page", () => {
      const byId = rows(lacking, { inUse: ALL_IN_USE });
      expect(byId.r2).toMatchObject({
        state: "needs-action",
        action: { href: `${DASH}/r2/overview` },
      });
      expect(byId.zone).toMatchObject({
        state: "needs-action",
        action: { href: `${DASH}/domains/overview` },
      });
      // Without a domain, adding one comes first.
      expect(byId["email-routing"]).toMatchObject({
        state: "needs-action",
        action: { href: `${DASH}/domains/overview` },
        details: { found: "Needs a domain first" },
      });
      expect(byId["analytics-engine"]).toMatchObject({
        state: "needs-action",
        action: { href: `${DASH}/workers/analytics-engine` },
      });
      expect(byId["analytics-engine"].details.problem).toContain("opened once");
      expect(byId["zero-trust"]).toMatchObject({
        state: "needs-action",
        action: { href: `https://one.dash.cloudflare.com/?to=/${ACC}/home` },
      });
    });

    it("says Not set up, keeping the dashboard page, when no app in the account needs them", () => {
      const byId = rows(lacking, { inUse: NOTHING_IN_USE });
      for (const id of ["r2", "zone", "email-routing", "analytics-engine", "zero-trust"] as const) {
        expect(byId[id].state).toBe("not-set-up");
        expect(byId[id].action?.kind).toBe("turn-on");
      }
    });

    it("could not check Email Routing without a button when the token cannot read it", () => {
      const row = rows({ ...EVERYTHING, emailRouting: NO_PERMISSION })["email-routing"];
      expect(row.state).toBe("could-not-check");
      expect(row.action).toBeNull();
      expect(row.details.problem).toContain("Zone Settings");
    });

    it("could not check each of them when the token cannot read it", () => {
      const byId = rows({
        ...EVERYTHING,
        r2: NO_PERMISSION,
        zone: NO_PERMISSION,
        analyticsEngine: NO_PERMISSION,
        zeroTrust: NO_PERMISSION,
      });
      for (const id of ["r2", "zone", "analytics-engine", "zero-trust"] as const) {
        expect(byId[id].state).toBe("could-not-check");
        expect(byId[id].action).toBeNull();
        expect(byId[id].details.problem).not.toBeNull();
      }
      expect(byId.r2.details.problem).toContain("Workers R2 Storage");
      expect(byId["zero-trust"].details.problem).toContain("Access: Organizations");
    });
  });

  describe("Sandbox builds", () => {
    const paid = { ...EVERYTHING };

    it("is ready on Workers Paid before it is on: it turns on when an app needs it", () => {
      const row = rows(paid).sandbox;
      expect(row.state).toBe("ready");
      expect(row.details.found).toContain("first time an app needs them");
      expect(row.details.note).toBeNull();
      expect(row.action).toEqual({
        kind: "set-up",
        label: "Set up",
        href: "/settings/building#sandbox",
      });
    });

    it("notes that Containers and R2 are not confirmed yet when a probe could not tell", () => {
      const row = rows({ ...paid, r2: FAILED }).sandbox;
      expect(row.state).toBe("ready");
      expect(row.details.note).toContain("not confirmed");
    });

    it("is ready while being turned on, with the job's progress and no button", () => {
      const row = rows(paid, {
        sandboxJobs: { activeEnable: { id: "job-1" }, lastFailure: null },
      }).sandbox;
      expect(row.state).toBe("ready");
      expect(row.action).toBeNull();
      expect(row.details.job).toEqual({ href: "/jobs/job-1", label: "View progress" });
    });

    it("needs action after a failed try, with the job's log", () => {
      const row = rows(paid, {
        sandboxJobs: {
          activeEnable: null,
          lastFailure: { id: "job-2", kind: "sandbox_enable", message: "The image did not start." },
        },
      }).sandbox;
      expect(row.state).toBe("needs-action");
      expect(row.details.problem).toContain("The image did not start.");
      expect(row.details.job).toEqual({ href: "/jobs/job-2", label: "View log" });
    });

    it("needs action when R2 is off or the token lacks Containers and an app is built this way", () => {
      const inUse = { ...NOTHING_IN_USE, total: 1, sandbox: 1 };
      expect(rows({ ...paid, r2: { state: "not-enabled" } }, { inUse }).sandbox).toMatchObject({
        state: "needs-action",
        details: { found: "Needs R2 storage turned on" },
      });
      const permission = rows({ ...paid, containers: NO_PERMISSION }, { inUse }).sandbox;
      expect(permission.state).toBe("needs-action");
      expect(permission.details.problem).toContain("Containers: Edit");
    });

    it("is not set up when R2 is off and no app in the account is built this way", () => {
      const row = rows(
        { ...paid, r2: { state: "not-enabled" } },
        { inUse: NOTHING_IN_USE },
      ).sandbox;
      expect(row.state).toBe("not-set-up");
      expect(row.action?.kind).toBe("set-up");
    });

    it("is paid plan only on Workers Free, and says how to tell when the token cannot", () => {
      expect(rows(FREE).sandbox.state).toBe("paid-only");
      const unknown = rows({
        ...FREE,
        workersPlan: NO_PERMISSION,
        containers: NO_PERMISSION,
      }).sandbox;
      expect(unknown.state).toBe("paid-only");
      expect(unknown.details.note).toContain("Containers: Edit");
    });

    it("has nothing to do once it is on", () => {
      const row = rows(paid, { sandbox: "enabled" }).sandbox;
      expect(row).toMatchObject({ state: "ready", action: null });
    });
  });

  describe("Token permissions", () => {
    it("needs action when Cloudflare refused a read Appflare cannot work without", () => {
      const row = rows({ ...EVERYTHING, r2: NO_PERMISSION, workersDev: NO_PERMISSION })[
        "token-permissions"
      ];
      expect(row.state).toBe("needs-action");
      expect(row.details.problem).toContain("Workers Scripts and Workers R2 Storage");
      expect(row.action).toEqual({
        kind: "edit-token",
        label: "Edit token in Cloudflare",
        href: `${DASH}/api-tokens`,
      });
    });

    it("could not check, with no button, when its checks failed or never ran", () => {
      for (const stored of [
        { ...EVERYTHING, r2: FAILED, workersDev: FAILED },
        (({ workersDev: _w, ...rest }) => ({ ...rest, r2: FAILED }))(EVERYTHING),
      ]) {
        expect(rows(stored)["token-permissions"]).toMatchObject({
          state: "could-not-check",
          action: null,
        });
      }
      // One answer is enough to tell.
      expect(rows({ ...EVERYTHING, r2: FAILED })["token-permissions"].state).toBe("ready");
    });

    it("is ready without the optional permissions, naming them in the details", () => {
      const row = rows({
        ...FREE,
        workersPlan: NO_PERMISSION,
        zeroTrust: NO_PERMISSION,
      })["token-permissions"];
      expect(row.state).toBe("ready");
      expect(row.action).toBeNull();
      expect(row.details.note).toBe(
        "Optional permissions the token does not have: Billing (to detect the Workers plan) and Access: Organizations (for Zero Trust).",
      );
    });

    it("could not check before the probes ran", () => {
      expect(rows(null)["token-permissions"]).toMatchObject({
        state: "could-not-check",
        details: { problem: "Not checked yet." },
      });
    });
  });

  it("counts the catalog apps that use each thing in the details", () => {
    const byId = rows(EVERYTHING);
    expect(byId.r2.details.usedBy).toBe("4 catalog apps use it.");
    expect(byId["email-routing"].details.usedBy).toBe("1 catalog app uses it.");
    expect(byId["zero-trust"].details.usedBy).toBe("No catalog app uses it yet.");
    expect(byId["workers-dev"].details.usedBy).toBe("12 catalog apps use it.");
    expect(rows(EVERYTHING, { needs: null }).r2.details.usedBy).toBeNull();
  });

  it("opens the account Appflare runs in from every dashboard link", () => {
    const byId = rows({
      ...FREE,
      workersDev: { state: "not-registered" },
      zone: { state: "none" },
      analyticsEngine: { state: "not-enabled" },
    });
    for (const row of Object.values(byId)) {
      if (row.action?.kind === "turn-on") expect(row.action.href).toContain(`/?to=/${ACC}/`);
    }
    for (const href of Object.values(dashboardLinks(ACC))) expect(href).toContain(`/?to=/${ACC}/`);
    for (const href of Object.values(dashboardLinks(null)))
      expect(href).toContain("/?to=/:account/");
  });

  it("offers only the four actions, and none on a ready row but a stated plan", () => {
    const labels = new Set<string>();
    const refused = { ...FREE, workersDev: NO_PERMISSION };
    for (const stored of [EVERYTHING, FREE, refused, null]) {
      for (const row of Object.values(rows(stored))) {
        if (row.action !== null) labels.add(row.action.label);
        if (row.state === "ready" && row.id !== "sandbox") expect(row.action).toBeNull();
      }
    }
    expect([...labels].sort()).toEqual([
      "Choose plan",
      "Edit token in Cloudflare",
      "Set up",
      "Turn on in Cloudflare",
    ]);
  });
});

describe("capabilityProgress", () => {
  it("counts ready rows over the rows that can be ready on this plan", () => {
    const free = capabilityRows({ view: view(FREE), sandbox: "off", needs: null });
    // Nine rows; sandbox builds are paid only; R2 and Zero Trust are not set up.
    expect(capabilityProgress(free)).toEqual({ ready: 6, total: 8 });
    expect(progressLabel(capabilityProgress(free))).toBe("6 of 8 ready");
    const all = capabilityRows({ view: view(EVERYTHING), sandbox: "enabled", needs: null });
    expect(capabilityProgress(all)).toEqual({ ready: 9, total: 9 });
  });
});

describe("anchors", () => {
  it("gives every row the anchor capability-<id>, and links refused installs to them", () => {
    expect(capabilityAnchor("token-permissions")).toBe("capability-token-permissions");
    expect(ANALYTICS_ENGINE_CAPABILITY_LINK).toEqual({
      href: "/settings/account#capability-analytics-engine",
      label: "Analytics Engine in Your account",
    });
  });
});

describe("installedNeeds", () => {
  it("counts what the account's installs need, from the catalog entries they came from", () => {
    const entries: Record<string, Parameters<typeof catalogNeeds>[0][number]> = {
      cut: { services: ["r2"], requires: [], plan: "free", tier: "artifact" },
      "team:inbox": { services: ["email-routing"], requires: [], plan: "free", tier: "artifact" },
    };
    const needs = installedNeeds(
      [
        { appSlug: "cut", catalogId: null, origin: "catalog" },
        { appSlug: "inbox", catalogId: "team", origin: "catalog" },
        // No cached catalog lists it any more: nothing known.
        { appSlug: "gone", catalogId: null, origin: "catalog" },
        // Built from a repository: in the sandbox.
        { appSlug: "mine", catalogId: null, origin: "repository" },
      ],
      (i) => entries[i.catalogId === null ? i.appSlug : `${i.catalogId}:${i.appSlug}`],
    );
    expect(needs).toMatchObject({ total: 3, r2: 1, emailRouting: 1, zone: 1, sandbox: 1 });
  });
});

describe("catalogNeeds", () => {
  it("counts from the index's services, plans and tiers", () => {
    expect(
      catalogNeeds([
        { services: ["kv", "r2"], requires: [], plan: "free", tier: "artifact" },
        {
          services: ["email-routing", "zone", "future-thing"],
          requires: [],
          plan: "free",
          tier: "artifact",
        },
        {
          services: ["access", "containers", "analytics-engine"],
          requires: [],
          plan: "paid",
          tier: "sandbox",
        },
        // An older row without services: its `requires` stand in.
        { requires: ["r2", "zone", "analytics-engine"], plan: "paid", tier: "self-deploying" },
      ]),
    ).toEqual({
      total: 4,
      workersPaid: 2,
      r2: 2,
      analyticsEngine: 2,
      zone: 2,
      emailRouting: 1,
      access: 1,
      sandbox: 2,
    });
  });
});
