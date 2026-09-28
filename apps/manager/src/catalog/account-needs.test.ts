import { describe, expect, it } from "vitest";
import { type CapabilitiesView, capabilitiesView } from "../capabilities/capabilities";
import {
  CAPABILITY_STATE_LABELS,
  type CapabilityRow,
  capabilityRows,
} from "../capabilities/capability-rows";
import {
  type AccountNeed,
  type AppNeedsOf,
  accountNeeds,
  installAdds,
  needOfCheck,
} from "./account-needs";
import type { AppPrimitives } from "./primitives";
import { requirementChecks } from "./requirement-checks";

const CHECKED_AT = "2026-09-27T00:00:00.000Z";
const ACC = "acc0000000000000000000000000000a";
const DASH = `https://dash.cloudflare.com/?to=/${ACC}`;

function view(overrides: Partial<CapabilitiesView> = {}): CapabilitiesView {
  return { ...capabilitiesView(null, null, ACC), ...overrides };
}

/** Every probe ran and found everything missing, on a detected Workers Free account. */
const LACKING = view({
  checkedAt: CHECKED_AT,
  workersPlan: { state: "free" },
  plan: { plan: "free", source: "detected" },
  r2: { state: "not-enabled" },
  zone: { state: "none" },
  emailRouting: { state: "no-zone" },
  analyticsEngine: { state: "not-enabled" },
  zeroTrust: { state: "none" },
  containers: { state: "needs-workers-paid" },
});

function uses(...ids: AppPrimitives["ids"]): AppPrimitives {
  return { ids, complete: true, keyValueDurableObjects: false };
}

function app(plan: "free" | "paid" = "free", requires: string[] = []): AppNeedsOf {
  return { plan, requires, tier: "artifact" };
}

function wording(a: AppNeedsOf, p: AppPrimitives, v: CapabilitiesView) {
  return accountNeeds(a, p, v).map((n) => `${n.name} · ${n.state}`);
}

function byKey(needs: readonly AccountNeed[], key: string): AccountNeed {
  const need = needs.find((n) => n.key === key);
  if (need === undefined) throw new Error(`no need ${key}`);
  return need;
}

/** The rows of Your account when nothing in the account needs anything yet. */
function accountRows(v: CapabilitiesView): Map<string, CapabilityRow> {
  const rows = capabilityRows({ view: v, sandbox: "off", needs: null, inUse: null });
  return new Map(rows.map((r) => [r.id, r]));
}

const SEE = (id: string) => ({
  label: "See in Your account",
  href: `/settings/account#capability-${id}`,
});

describe("what an app needs on the account", () => {
  it("names each need and says why apps need it as its row on Your account does", () => {
    const needs = accountNeeds(
      app("free", ["r2", "zone", "email-routing", "analytics-engine"]),
      uses("r2", "zone", "email-routing", "analytics-engine", "access"),
      LACKING,
    );
    const rows = accountRows(LACKING);
    const pairs = [
      ["r2", "r2"],
      ["zone", "zone"],
      ["email-routing", "email-routing"],
      ["analytics-engine", "analytics-engine"],
      ["access", "zero-trust"],
    ] as const;
    for (const [key, id] of pairs) {
      const need = byKey(needs, key);
      const row = rows.get(id);
      expect(need.name).toBe(row?.name);
      // Access is worked out from the app's bindings; the rest its `requires` names.
      const lead = key === "access" ? "This app uses it." : "This app needs it.";
      expect(need.reason).toBe(`${lead} ${row?.why}`);
    }
  });

  it("says the app uses what was worked out from its bindings, with the same state and actions", () => {
    const declared = byKey(accountNeeds(app("free", ["r2"]), uses("r2"), LACKING), "r2");
    const inferred = byKey(accountNeeds(app(), uses("r2"), LACKING), "r2");
    expect(declared.reason).toBe(
      "This app needs it. Apps keep files and uploads in R2. Turning it on is free.",
    );
    expect(inferred.reason).toBe(
      "This app uses it. Apps keep files and uploads in R2. Turning it on is free.",
    );
    expect({ ...inferred, reason: null }).toEqual({ ...declared, reason: null });
  });

  it("gives a row to a requirement the app's services leave out", () => {
    // An index row from before its services named the domain.
    const needs = accountNeeds(app("free", ["zone"]), uses("kv"), LACKING);
    expect(needs.map((n) => [n.key, n.state])).toEqual([
      ["zone", "Needs action"],
      ["kv", "Included"],
    ]);
    // The banner counts it too, as the same row.
    const [check, ...rest] = requirementChecks(app("free", ["zone"]), LACKING).pending;
    expect(rest).toEqual([]);
    if (check === undefined) throw new Error("no pending check");
    expect(needOfCheck(check, app("free", ["zone"]), uses("kv"), LACKING)).toEqual(
      byKey(needs, "zone"),
    );
  });

  it("reads a capability nothing else uses as needed, because this app needs it", () => {
    const rows = accountRows(LACKING);
    // Your account: nothing installed needs R2, so it is only not set up there.
    expect(rows.get("r2")?.state).toBe("not-set-up");
    const r2 = byKey(accountNeeds(app("free", ["r2"]), uses("r2"), LACKING), "r2");
    expect(r2).toMatchObject({ state: "Needs action", tone: "missing" });
    expect(r2.reason).toMatch(/^This app needs it\. /);
  });

  it("maps each state of a capability row to the need's words and actions", () => {
    const readyView = view({
      checkedAt: CHECKED_AT,
      r2: { state: "enabled" },
      zone: { state: "available" },
      emailRouting: { state: "available" },
      analyticsEngine: { state: "enabled" },
      zeroTrust: { state: "exists", teamDomain: "acme" },
    });
    for (const need of accountNeeds(
      app(),
      uses("r2", "zone", "email-routing", "analytics-engine", "access"),
      readyView,
    )) {
      expect(need).toMatchObject({
        state: "Ready",
        tone: "ready",
        reason: null,
        fix: null,
        more: null,
      });
    }

    const couldNotCheck = view({
      checkedAt: CHECKED_AT,
      r2: { state: "unknown", reason: "no-permission", detail: "GET /r2/buckets 403" },
    });
    expect(byKey(accountNeeds(app("free", ["r2"]), uses("r2"), couldNotCheck), "r2")).toEqual({
      key: "r2",
      name: "R2 storage",
      state: "Could not check",
      tone: "unknown",
      reason: "This app needs it. Apps keep files and uploads in R2. Turning it on is free.",
      fix: null,
      more: SEE("r2"),
    });
    // Before the probes ever ran, the same.
    expect(byKey(accountNeeds(app(), uses("zone"), view()), "zone")).toMatchObject({
      state: "Could not check",
      fix: null,
      more: SEE("zone"),
    });
  });

  it("keeps the row's dashboard action and adds the row on Your account", () => {
    const needs = accountNeeds(
      app("paid"),
      uses("r2", "zone", "email-routing", "analytics-engine", "access", "kv"),
      LACKING,
    );
    expect(needs.map((n) => [n.key, n.state, n.fix, n.more])).toEqual([
      [
        "plan",
        "Paid plan only",
        { label: "Upgrade", href: `${DASH}/workers/plans` },
        SEE("workers-plan"),
      ],
      [
        "r2",
        "Needs action",
        { label: "Turn on in Cloudflare", href: `${DASH}/r2/overview` },
        SEE("r2"),
      ],
      [
        "zone",
        "Needs action",
        { label: "Add a domain in Cloudflare", href: `${DASH}/domains/overview` },
        SEE("zone"),
      ],
      [
        "email-routing",
        "Needs action",
        // With no domain yet, adding one comes first.
        { label: "Add a domain in Cloudflare", href: `${DASH}/domains/overview` },
        SEE("email-routing"),
      ],
      [
        "analytics-engine",
        "Needs action",
        { label: "Turn on in Cloudflare", href: `${DASH}/workers/analytics-engine` },
        SEE("analytics-engine"),
      ],
      [
        "access",
        "Needs action",
        {
          label: "Turn on in Cloudflare",
          href: `https://one.dash.cloudflare.com/?to=/${ACC}/home`,
        },
        SEE("zero-trust"),
      ],
      ["kv", "Included", null, null],
    ]);
    // Each action's words and target are the row's own.
    const rows = accountRows(LACKING);
    for (const [key, id] of [
      ["r2", "r2"],
      ["analytics-engine", "analytics-engine"],
      ["access", "zero-trust"],
    ] as const) {
      const action = rows.get(id)?.action;
      expect(byKey(needs, key).fix).toEqual(
        action !== undefined && action !== null && "href" in action
          ? { label: action.label, href: action.href }
          : null,
      );
    }
  });

  it("says what the plan means for an app that needs Workers Paid", () => {
    const needsPaid = (v: CapabilitiesView) => byKey(accountNeeds(app("paid"), uses(), v), "plan");
    expect(needsPaid(view({ plan: { plan: "paid", source: "detected" } }))).toMatchObject({
      name: "Workers plan",
      state: "Ready",
      more: null,
    });
    expect(needsPaid(view({ plan: { plan: "paid", source: "set-by-you" } })).state).toBe("Ready");
    expect(needsPaid(LACKING)).toMatchObject({
      state: CAPABILITY_STATE_LABELS["paid-only"],
      tone: "missing",
      reason: "This app needs Workers Paid, and this account is on Workers Free.",
    });
    // Not known: the Workers plan row's own state, and "Choose plan" there.
    const refused = view({
      checkedAt: CHECKED_AT,
      workersPlan: { state: "unknown", reason: "no-permission", detail: "403" },
    });
    expect(needsPaid(refused)).toEqual({
      key: "plan",
      name: "Workers plan",
      state: "Needs action",
      tone: "missing",
      reason: "This app needs Workers Paid, and Appflare cannot tell this account's plan.",
      fix: null,
      more: { label: "Choose plan", href: "/settings/account#capability-workers-plan" },
    });
    expect(needsPaid(view())).toMatchObject({ state: "Could not check", tone: "unknown" });
  });

  it("puts what only Workers Paid includes under the plan", () => {
    const [containers] = accountNeeds(app(), uses("containers"), LACKING);
    expect(containers).toMatchObject({
      name: "Containers",
      state: "Paid plan only",
      reason: "It needs Workers Paid, and this account is on Workers Free.",
      fix: { label: "Upgrade", href: `${DASH}/workers/plans` },
      more: SEE("workers-plan"),
    });
    const paid = view({ plan: { plan: "paid", source: "detected" } });
    expect(wording(app(), uses("pipelines"), paid)).toEqual(["Pipelines · Ready"]);
    expect(wording(app(), uses("durable-objects"), LACKING)).toEqual([
      "Durable Objects · Included",
    ]);
  });

  it("trusts a probe that found Workers Paid missing over a plan an admin stated", () => {
    const stated = view({
      plan: { plan: "paid", source: "set-by-you" },
      containers: { state: "needs-workers-paid" },
    });
    const a = app("free", ["containers"]);
    const [containers] = accountNeeds(a, uses("containers"), stated);
    expect(containers).toMatchObject({
      state: "Paid plan only",
      tone: "missing",
      reason: "It needs Workers Paid, and Cloudflare says this account does not have it.",
      fix: { label: "Upgrade", href: `${DASH}/workers/plans` },
    });
    // The banner lists it, and its row there says the same.
    const [check] = requirementChecks(a, stated).pending;
    if (check === undefined) throw new Error("no pending check");
    expect(needOfCheck(check, a, uses("containers"), stated)).toEqual(containers);
  });

  it("marks what the admin brings, and what Appflare cannot check", () => {
    expect(accountNeeds(app(), uses("hyperdrive"), view())).toEqual([
      {
        key: "hyperdrive",
        name: "Your own database",
        state: "You provide it",
        tone: "yours",
        reason: null,
        fix: null,
        more: null,
      },
    ]);
    const [unknown] = accountNeeds(app("free", ["teleport"]), uses(), view());
    expect(unknown).toMatchObject({ state: "Could not check", tone: "unknown", more: null });
  });

  it("puts problems first, then what could not be checked, then what is ready", () => {
    const needs = accountNeeds(
      app(),
      uses("kv", "zone", "r2"),
      view({ r2: { state: "not-enabled" } }),
    );
    expect(needs.map((n) => [n.key, n.tone])).toEqual([
      ["r2", "missing"],
      ["zone", "unknown"],
      ["kv", "ready"],
    ]);
  });

  it("gives the banner the same rows as the page", () => {
    const a = app("paid", ["r2", "analytics-engine", "teleport"]);
    const p = uses("r2", "analytics-engine");
    const checks = requirementChecks(a, LACKING);
    const page = accountNeeds(a, p, LACKING);
    for (const check of checks.pending) {
      expect(needOfCheck(check, a, p, LACKING)).toEqual(byKey(page, check.key));
    }
    expect(checks.pending.map((c) => c.key)).toEqual([
      "plan",
      "r2",
      "analytics-engine",
      "teleport",
    ]);
  });
});

describe("what the install adds", () => {
  it("counts each kind in one sentence and names the bindings for the tooltip", () => {
    expect(
      installAdds(
        [
          { kind: "kv", binding: "LINKS" },
          { kind: "kv", binding: "CACHE" },
          { kind: "d1", binding: "DB" },
          { kind: "r2", binding: "FILES" },
        ],
        ["Room"],
      ),
    ).toEqual({
      sentence:
        "The install adds the app's Worker, two KV namespaces, a D1 database, an R2 bucket and a Durable Object class to your account.",
      detail:
        "Named in the app: LINKS (KV namespace), CACHE (KV namespace), DB (D1 database), FILES (R2 bucket), Room (Durable Object class).",
    });
  });

  it("counts every kind it creates in the same words as the catalog", () => {
    const creates = [
      { kind: "queue", binding: "JOBS" },
      { kind: "queue", binding: "MAIL" },
      { kind: "vectorize", binding: "INDEX" },
      { kind: "vectorize", binding: "INDEX_2" },
      { kind: "hyperdrive", binding: "PG" },
      { kind: "pipeline_stream", binding: "EVENTS" },
      { kind: "r2", binding: "A" },
      { kind: "r2", binding: "B" },
      { kind: "ratelimit", binding: "LIMIT" },
    ];
    expect(installAdds(creates, ["Room", "Lobby"]).sentence).toBe(
      "The install adds the app's Worker, two queues, two Vectorize indexes, a Hyperdrive configuration, a Pipelines stream, two R2 buckets, a Rate limit and two Durable Object classes to your account.",
    );
  });

  it("counts the app's cron triggers in lower case", () => {
    expect(installAdds([{ kind: "d1", binding: "DB" }], [], 1).sentence).toBe(
      "The install adds the app's Worker, a D1 database and a cron trigger to your account.",
    );
    expect(installAdds([], [], 2)).toEqual({
      sentence: "The install adds the app's Worker and two cron triggers to your account.",
      detail: null,
    });
  });

  it("is only the Worker for an app with no resources", () => {
    expect(installAdds([], [])).toEqual({
      sentence: "The install adds the app's Worker to your account.",
      detail: null,
    });
  });
});
