import catalog from "virtual:appflare-catalog";
import examples from "virtual:appflare-scope-examples";
import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { MANAGER_SCOPE_REASONS, type RequestedGroupKey } from "@appflare/cf-api/scope-reasons";
import { SERVICE_IDS } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { listedScopes } from "../components/deploy/scope-list.tsx";
import { type ExampleCandidate, MAX_EXAMPLES, scopeExamples } from "./scope-examples.ts";

const app = (name: string, services: string[], extra: Partial<ExampleCandidate> = {}) => ({
  name,
  services,
  icon: "https://example.com/icon.png",
  addedAt: "2026-09-01T00:00:00Z",
  popularity: { stars: 10 },
  ...extra,
});

describe("why each permission is asked for, on the deploy page", () => {
  it("lists every scope Appflare requests, each with a reason, and nothing else", () => {
    const listed = listedScopes(examples);
    expect(listed.map((s) => s.scope)).toEqual([...MANAGER_OAUTH_SCOPES]);
    for (const { why, reason } of listed) {
      expect(why.startsWith(`${reason.label} lets Appflare `)).toBe(true);
    }
    expect(listed.map((s) => s.reason.label)).not.toContain("Billing");
  });

  it("names only catalog services that exist", () => {
    for (const reason of Object.values(MANAGER_SCOPE_REASONS)) {
      if ("service" in reason) expect(SERVICE_IDS).toContain(reason.service);
    }
  });

  it("takes examples only from apps in the catalog that really use the permission's service", () => {
    const byName = new Map(catalog.apps.map((a) => [a.name, a]));
    for (const [group, names] of Object.entries(examples)) {
      const reason = MANAGER_SCOPE_REASONS[group as RequestedGroupKey];
      expect("service" in reason).toBe(true);
      expect(names.length).toBeGreaterThan(0);
      expect(names.length).toBeLessThanOrEqual(MAX_EXAMPLES);
      for (const name of names) {
        const used = byName.get(name);
        expect(used, name).toBeDefined();
        if ("service" in reason) expect(used?.services).toContain(reason.service);
      }
    }
    // Feature reasons never name apps.
    expect(examples.workers_scripts).toBeUndefined();
    expect(examples.access).toBeUndefined();
  });

  it("prefers apps with an icon, then the most starred, then the longest listed", () => {
    const found = scopeExamples([
      app("No icon", ["d1"], { icon: null, popularity: { stars: 900 } }),
      app("Few stars", ["d1"], { popularity: { stars: 3 } }),
      app("Many stars", ["d1"], { popularity: { stars: 500 } }),
      app("Older", ["d1"], { popularity: { stars: 3 }, addedAt: "2026-01-01T00:00:00Z" }),
      app("Key-value", ["kv"]),
    ]);
    expect(found.d1).toEqual(["Many stars", "Older"]);
    expect(found.workers_kv_storage).toEqual(["Key-value"]);
    // No app uses Vectorize here: no examples, so the sentence has no "apps like".
    expect(found.vectorize).toBeUndefined();
    const vectorize = listedScopes(found).find((s) => s.scope === "vectorize.write");
    expect(vectorize?.why).toBe(MANAGER_SCOPE_REASONS.vectorize.text);
    expect(vectorize?.why).not.toContain("apps like");
  });
});
