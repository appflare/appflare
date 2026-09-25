import { describe, expect, it } from "vitest";
import { type CapabilitiesView, capabilitiesView } from "../capabilities/capabilities";
import { NO_CONTAINERS_PERMISSION_REASON } from "../sandbox/preflight";
import {
  buildChecklist,
  type CatalogNeeds,
  type ChecklistInput,
  type ChecklistRow,
  type ChecklistRowId,
  catalogNeeds,
  checklistProgress,
  DASHBOARD_LINKS,
  groupChecklist,
  MAX_ROW_VALUE_LENGTH,
  needsYouCount,
  rowHelp,
} from "./checklist";

const ACC = "acc0000000000000000000000000000a";
const NO_PERMISSION = { state: "unknown", reason: "no-permission", detail: "HTTP 403" } as const;

/** A free account with R2 on, a zone, Email Routing readable, no Zero Trust organization. */
function view(over: Partial<CapabilitiesView> = {}): CapabilitiesView {
  const base = capabilitiesView(undefined, {
    checkedAt: "2026-09-24T10:00:00.000Z",
    r2: { state: "enabled" },
    containers: { state: "needs-workers-paid" },
    workersPlan: { state: "free" },
    zone: { state: "available" },
    emailRouting: { state: "available" },
    workersDev: { state: "registered", subdomain: "acme" },
    zeroTrust: { state: "none" },
  });
  return { ...base, ...over };
}

/** The same account on Workers Paid. */
const paidView = () =>
  view({
    workersPlan: { state: "paid" },
    containers: { state: "available" },
    plan: { plan: "paid", source: "detected" },
  });

const NEEDS: CatalogNeeds = {
  total: 12,
  workersPaid: 3,
  r2: 4,
  zone: 2,
  emailRouting: 1,
  access: 0,
  sandbox: 2,
};

function rows(input: Partial<ChecklistInput> = {}): Record<ChecklistRowId, ChecklistRow> {
  const list = buildChecklist({
    view: view(),
    sandbox: "off",
    needs: NEEDS,
    accountId: ACC,
    ...input,
  });
  return Object.fromEntries(list.map((r) => [r.id, r])) as Record<ChecklistRowId, ChecklistRow>;
}

describe("buildChecklist", () => {
  it("lists the seven rows in order", () => {
    expect(
      buildChecklist({ view: view(), sandbox: "off", needs: NEEDS, accountId: ACC }).map(
        (r) => r.id,
      ),
    ).toEqual([
      "workers-dev",
      "workers-plan",
      "r2",
      "zone",
      "email-routing",
      "zero-trust",
      "sandbox",
    ]);
  });

  it("marks what the account has as Done", () => {
    const r = rows({ view: paidView(), sandbox: "enabled" });
    expect(r["workers-dev"]).toMatchObject({ status: "done", value: "acme.workers.dev" });
    expect(r["workers-plan"]).toMatchObject({ status: "done" });
    expect(r.r2.status).toBe("done");
    expect(r.zone.status).toBe("done");
    expect(r["email-routing"].status).toBe("done");
    expect(r.sandbox).toMatchObject({ status: "done", value: "Enabled", link: null, action: null });
  });

  it("needs the admin for a missing workers.dev subdomain, linking to registration", () => {
    const r = rows({ view: view({ workersDev: { state: "not-registered" } }) });
    expect(r["workers-dev"]).toMatchObject({
      status: "needs-you",
      value: "None registered",
      link: { href: DASHBOARD_LINKS.workersOnboarding(ACC), external: true },
    });
    // Without the account id the link falls back to Workers & Pages.
    const unknownAccount = rows({
      view: view({ workersDev: { state: "not-registered" } }),
      accountId: null,
    });
    expect(unknownAccount["workers-dev"].link?.href).toBe(DASHBOARD_LINKS.workersAndPages);
  });

  it("needs the admin for R2 only while catalog apps use it", () => {
    const off = view({ r2: { state: "not-enabled" } });
    expect(rows({ view: off }).r2).toMatchObject({ status: "needs-you", value: "Not enabled" });
    expect(rows({ view: off, needs: { ...NEEDS, r2: 0 } }).r2.status).toBe("optional");
    // Unknown catalog: assume some app needs it.
    expect(rows({ view: off, needs: null }).r2.status).toBe("needs-you");
  });

  it("keeps plan, domains, Email Routing, Zero Trust and sandbox builds optional", () => {
    const r = rows({
      view: view({
        zone: { state: "none" },
        emailRouting: { state: "no-zone" },
        zeroTrust: { state: "none" },
      }),
    });
    expect(r["workers-plan"]).toMatchObject({ status: "optional", value: "Workers Free" });
    expect(r.zone).toMatchObject({ status: "optional", value: "No active zone" });
    expect(r["email-routing"]).toMatchObject({
      status: "optional",
      value: "Needs an active zone first",
    });
    expect(r["zero-trust"]).toMatchObject({ status: "optional", value: "None yet" });
    expect(needsYouCount(Object.values(r))).toBe(0);
  });

  it("shows sandbox builds as ready on Workers Paid with the Containers permission, with Enable now", () => {
    expect(rows({ view: paidView() }).sandbox).toMatchObject({
      status: "optional",
      value: "Ready, turns on when an app needs it",
      link: null,
      action: "enable-sandbox",
    });
  });

  it("says what sandbox builds still need otherwise, with the fix as the action", () => {
    expect(rows().sandbox).toMatchObject({
      status: "optional",
      value: "Needs Workers Paid",
      link: { href: DASHBOARD_LINKS.workersPlans, label: "Upgrade" },
      action: null,
    });
    // Paid, but the token cannot read Containers: the reason goes to the tooltip.
    expect(rows({ view: { ...paidView(), containers: NO_PERMISSION } }).sandbox).toMatchObject({
      value: "Needs a token permission",
      detail: NO_CONTAINERS_PERMISSION_REASON,
      link: { href: DASHBOARD_LINKS.accountApiTokens, external: true },
      action: null,
    });
    expect(rows({ view: { ...paidView(), r2: { state: "not-enabled" } } }).sandbox).toMatchObject({
      value: "Needs R2 turned on",
      link: { href: DASHBOARD_LINKS.r2 },
    });
    // Never asks the admin to act now: it is turned on at first need.
    for (const v of [view(), paidView(), { ...paidView(), containers: NO_PERMISSION }]) {
      expect(rows({ view: v }).sandbox.status).not.toBe("needs-you");
    }
  });

  it("shows an enable in progress with a link to its job, and the last failed one", () => {
    const enabling = rows({
      view: paidView(),
      sandboxJobs: { activeEnable: { id: "job-1" }, lastFailure: null },
    }).sandbox;
    expect(enabling).toMatchObject({
      status: "optional",
      value: "Being turned on",
      action: "enabling",
      link: { href: "/jobs/job-1", external: false },
    });
    const failed = rows({
      view: paidView(),
      sandboxJobs: {
        activeEnable: null,
        lastFailure: { id: "job-0", kind: "sandbox_enable", message: "deploy failed: 500" },
      },
    }).sandbox;
    expect(failed).toMatchObject({
      value: "Last try failed",
      link: { href: "/jobs/job-0", label: "View log" },
      action: null,
    });
    expect(rowHelp(failed)).toContain("deploy failed: 500");
    // Succeeded: the binding serves, so the row is done whatever the jobs say.
    expect(
      rows({
        view: paidView(),
        sandbox: "enabled",
        sandboxJobs: { activeEnable: { id: "job-1" }, lastFailure: null },
      }).sandbox.status,
    ).toBe("done");
  });

  it("offers Enable now only once the probes confirmed it, else asks for a Re-check", () => {
    const manualPaid = view({
      containers: null,
      plan: { plan: "paid", source: "set-by-you" },
    });
    expect(rows({ view: manualPaid }).sandbox).toMatchObject({
      value: "Ready, turns on when an app needs it",
      action: null,
    });
    expect(rows({ view: manualPaid }).sandbox.note).toContain("Re-check");
  });

  it("explains a probe that could not tell", () => {
    const r = rows({ view: view({ zeroTrust: NO_PERMISSION, workersDev: NO_PERMISSION }) });
    expect(r["zero-trust"]).toMatchObject({ status: "optional", value: "Unknown" });
    expect(r["zero-trust"].note).toContain("Access: Organizations, Identity Providers, and Groups");
    expect(r["workers-dev"]).toMatchObject({ status: "needs-you", value: "Unknown" });
    expect(r["workers-dev"].note).toContain("workers.dev subdomain");
  });

  it("asks for a Re-check before the probes ever ran", () => {
    const r = rows({ view: capabilitiesView(undefined, null) });
    expect(r["workers-dev"]).toMatchObject({ status: "needs-you", value: "Not checked yet" });
    expect(r.r2).toMatchObject({ status: "optional", value: "Not checked yet" });
    expect(r["zero-trust"].note).toContain("Re-check");
  });

  it("counts the catalog apps that need each thing in the why line", () => {
    const r = rows();
    expect(r["workers-plan"].why).toContain("3 catalog apps need it.");
    expect(r.r2.why).toContain("4 catalog apps store files in R2.");
    expect(r["email-routing"].why).toContain("1 catalog app uses it.");
    expect(r["zero-trust"].why).toContain("No catalog app uses Access yet.");
    expect(r["workers-dev"].why).toContain("12 catalog apps use it by default.");
    // No cached catalog: the reason alone.
    expect(rows({ needs: null }).r2.why).not.toContain("catalog app");
  });

  it("links every row that is not done to the dashboard", () => {
    for (const row of Object.values(rows())) {
      if (row.status !== "done" && row.id !== "sandbox") {
        expect(row.link?.href).toMatch(/^https:\/\/(one\.)?dash\.cloudflare\.com\//);
        expect(row.link?.external).toBe(true);
      }
    }
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
        { services: ["access", "containers"], requires: [], plan: "paid", tier: "sandbox" },
        // An older row without services: its `requires` stand in.
        { requires: ["r2", "zone"], plan: "paid", tier: "self-deploying" },
      ]),
    ).toEqual({
      total: 4,
      workersPaid: 2,
      r2: 2,
      zone: 2,
      emailRouting: 1,
      access: 1,
      sandbox: 2,
    });
  });
});

describe("checklist display rules", () => {
  function list(input: Partial<ChecklistInput> = {}): ChecklistRow[] {
    return buildChecklist({ view: view(), sandbox: "off", needs: NEEDS, accountId: ACC, ...input });
  }

  it("counts progress over the rows that are done or need the admin, not optional ones", () => {
    // Free account: workers.dev, R2, zone, Email Routing done; plan, Zero Trust, sandbox optional.
    expect(checklistProgress(list())).toEqual({ done: 4, total: 4 });
    const missing = list({ view: view({ workersDev: { state: "not-registered" } }) });
    expect(checklistProgress(missing)).toEqual({ done: 3, total: 4 });
    // Nothing checked yet: nothing done, and only what needs the admin counts.
    expect(checklistProgress(list({ view: capabilitiesView(undefined, null) }))).toEqual({
      done: 0,
      total: 1,
    });
  });

  it("puts rows that need the admin first, then done rows, then optional ones", () => {
    const grouped = groupChecklist(
      list({
        view: view({ workersDev: { state: "not-registered" }, r2: { state: "not-enabled" } }),
      }),
    );
    expect(grouped.needsYou.map((r) => r.id)).toEqual(["workers-dev", "r2"]);
    expect(grouped.done.map((r) => r.id)).toEqual(["zone", "email-routing"]);
    expect(grouped.optional.map((r) => r.id)).toEqual(["workers-plan", "zero-trust", "sandbox"]);
  });

  it("puts the explanation in the help tooltip: detail, the probe's note, then why it matters", () => {
    const r = rows({ view: view({ zeroTrust: NO_PERMISSION }) });
    expect(rowHelp(r["zero-trust"])).toBe(`${r["zero-trust"].note} ${r["zero-trust"].why}`);
    expect(rowHelp(r.r2)).toBe(r.r2.why);
  });

  it("shows Configured for a Zero Trust organization, its team domain only in the tooltip", () => {
    const r = rows({
      view: view({
        zeroTrust: { state: "exists", teamDomain: "orange-mode.cloudflareaccess.com" },
      }),
    });
    expect(r["zero-trust"]).toMatchObject({ status: "done", value: "Configured" });
    expect(rowHelp(r["zero-trust"])).toContain("orange-mode.cloudflareaccess.com");
  });

  it("keeps every value short and free of addresses, in every state", () => {
    const views: CapabilitiesView[] = [
      view(),
      paidView(),
      capabilitiesView(undefined, null),
      view({ workersDev: { state: "not-registered" }, r2: { state: "not-enabled" } }),
      view({ zeroTrust: NO_PERMISSION, workersDev: NO_PERMISSION, zone: NO_PERMISSION }),
      { ...paidView(), containers: NO_PERMISSION },
      { ...paidView(), r2: { state: "not-enabled" } },
      view({ zone: { state: "none" }, emailRouting: { state: "no-zone" } }),
      view({ plan: { plan: "paid", source: "set-by-you" }, containers: null }),
    ];
    for (const v of views) {
      for (const sandbox of ["off", "enabled"] as const) {
        for (const row of buildChecklist({ view: v, sandbox, needs: NEEDS, accountId: ACC })) {
          // The workers.dev hostname is the account's own value, shown as is.
          if (row.id !== "workers-dev" || row.status !== "done") {
            expect(row.value.length, `${row.id}: ${row.value}`).toBeLessThanOrEqual(
              MAX_ROW_VALUE_LENGTH,
            );
          }
          expect(row.value).not.toMatch(/https?:\/\//);
          if (row.link !== null) expect(rowHelp(row)).not.toContain(row.link.href);
          expect(rowHelp(row)).not.toMatch(/https?:\/\//);
        }
      }
    }
  });
});
