import { describe, expect, it } from "vitest";
import { type CapabilitiesView, capabilitiesView } from "../capabilities/capabilities";
import { accountNeeds, installAdds, needOfCheck } from "./account-needs";
import type { AppPrimitives } from "./primitives";
import { requirementChecks } from "./requirement-checks";

const CHECKED_AT = "2026-09-27T00:00:00.000Z";

function view(overrides: Partial<CapabilitiesView> = {}): CapabilitiesView {
  return { ...capabilitiesView(null, null), ...overrides };
}

function uses(...ids: AppPrimitives["ids"]): AppPrimitives {
  return { ids, complete: true, keyValueDurableObjects: false };
}

function wording(
  app: { plan: "free" | "paid"; requires: string[] },
  p: AppPrimitives,
  v: CapabilitiesView,
) {
  return accountNeeds(app, p, v).map((n) => `${n.name} · ${n.state}`);
}

describe("what an app needs on the account", () => {
  it("says ready, not turned on, or not confirmed in plain words", () => {
    const probed = view({
      checkedAt: CHECKED_AT,
      emailRouting: { state: "available" },
      r2: { state: "not-enabled" },
    });
    expect(
      wording({ plan: "free", requires: [] }, uses("email-routing", "r2", "kv"), probed),
    ).toEqual(["R2 storage · not turned on", "Email Routing · ready", "KV storage · included"]);
    expect(wording({ plan: "free", requires: [] }, uses("email-routing", "r2"), view())).toEqual([
      "Email Routing · not confirmed",
      "R2 storage · not confirmed",
    ]);
  });

  it("says what a missing domain or plan means", () => {
    const noZone = view({
      zone: { state: "none" },
      emailRouting: { state: "no-zone" },
    });
    expect(wording({ plan: "free", requires: [] }, uses("zone", "email-routing"), noZone)).toEqual([
      "A domain · no domain on this account",
      "Email Routing · needs a domain on this account",
    ]);
    const free = view({ plan: { plan: "free", source: "detected" } });
    expect(wording({ plan: "paid", requires: [] }, uses("containers"), free)).toEqual([
      "Workers Paid plan · this account is on Free",
      "Containers · needs Workers Paid",
    ]);
    const paid = view({ plan: { plan: "paid", source: "detected" } });
    expect(wording({ plan: "paid", requires: [] }, uses(), paid)).toEqual([
      "Workers Paid plan · ready",
    ]);
  });

  it("links a missing need to the dashboard page that fixes it, and nothing else", () => {
    const lacking = view({
      plan: { plan: "free", source: "detected" },
      r2: { state: "not-enabled" },
      zone: { state: "none" },
      emailRouting: { state: "no-zone" },
      checkedAt: CHECKED_AT,
    });
    const fixes = accountNeeds(
      { plan: "paid", requires: [] },
      uses("r2", "zone", "email-routing", "kv"),
      lacking,
    ).map((n) => [n.key, n.fix?.label ?? null, n.fix?.href ?? null]);
    expect(fixes).toEqual([
      ["plan", "Upgrade", "https://dash.cloudflare.com/?to=/:account/workers/plans"],
      ["r2", "Turn on", "https://dash.cloudflare.com/?to=/:account/r2/overview"],
      ["zone", "Add a domain", "https://dash.cloudflare.com/?to=/:account/domains/overview"],
      [
        "email-routing",
        "Add a domain",
        "https://dash.cloudflare.com/?to=/:account/domains/overview",
      ],
      ["kv", null, null],
    ]);
    // Not confirmed is not missing: no fix to offer.
    const unknown = accountNeeds({ plan: "paid", requires: [] }, uses("r2"), view());
    expect(unknown.map((n) => n.fix)).toEqual([null, null]);
  });

  it("marks what the admin brings, and keeps the probe's sentence for the tooltip", () => {
    const [database] = accountNeeds({ plan: "free", requires: [] }, uses("hyperdrive"), view());
    expect(database).toMatchObject({
      name: "Your own database",
      state: "you provide it",
      tone: "yours",
    });
    const [r2] = accountNeeds(
      { plan: "free", requires: [] },
      uses("r2"),
      view({ r2: { state: "not-enabled" } }),
    );
    expect(r2?.detail).toContain("payment method");
  });

  it("puts problems first, then what is not confirmed, then what is ready", () => {
    const needs = accountNeeds(
      { plan: "free", requires: [] },
      uses("kv", "access", "r2"),
      view({ r2: { state: "not-enabled" } }),
    );
    expect(needs.map((n) => n.tone)).toEqual(["missing", "unknown", "ready"]);
  });

  it("words a requirement check the same way as its row", () => {
    const checks = requirementChecks(
      { plan: "paid", requires: ["r2"] },
      view({ r2: { state: "not-enabled" } }),
    );
    expect(checks.pending.map((c) => needOfCheck(c)).map((n) => `${n.name} · ${n.state}`)).toEqual([
      "Workers Paid plan · not confirmed",
      "R2 storage · not turned on",
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
        "The install adds the app's Worker, 2 KV namespaces, a D1 database, an R2 bucket and a Durable Object class to your account.",
      detail:
        "Named in the app: LINKS (KV namespace), CACHE (KV namespace), DB (D1 database), FILES (R2 bucket), Room (Durable Object class).",
    });
  });

  it("is only the Worker for an app with no resources", () => {
    expect(installAdds([], [])).toEqual({
      sentence: "The install adds the app's Worker to your account.",
      detail: null,
    });
  });
});
