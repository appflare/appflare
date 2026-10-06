import { describe, expect, it } from "vitest";
import {
  MANAGER_SCOPE_REASONS,
  OFFLINE_ACCESS_REASON,
  type ScopeReason,
  scopeReasonText,
} from "./oauth-scope-reasons";
import { MANAGER_OAUTH_SCOPE_BY_GROUP } from "./oauth-scopes";

const reasons: Array<[string, ScopeReason]> = [
  ...Object.entries(MANAGER_SCOPE_REASONS),
  ["offline_access", OFFLINE_ACCESS_REASON],
];

/** Sentences in a text: each ends with a full stop followed by a space or the end. */
const sentences = (text: string) => text.split(/(?<=\.)\s+/).filter((s) => s !== "");

describe("why each permission is asked for", () => {
  it("has a reason for every group Appflare requests, and none for one it cannot", () => {
    const requested = Object.entries(MANAGER_OAUTH_SCOPE_BY_GROUP)
      .filter(([, scope]) => scope !== null)
      .map(([group]) => group)
      .sort();
    expect(Object.keys(MANAGER_SCOPE_REASONS).sort()).toEqual(requested);
    expect(Object.keys(MANAGER_SCOPE_REASONS)).not.toContain("billing");
  });

  it.each(reasons)("says %s in one or two plain sentences, starting with its name", (_g, r) => {
    for (const text of [r.text, r.withApps].filter((t): t is string => t !== undefined)) {
      expect(text.startsWith(`${r.label} lets Appflare `)).toBe(true);
      expect(sentences(text).length).toBeLessThanOrEqual(2);
      expect(text).not.toMatch(/—|;/);
    }
    // An app reason has both forms; a feature reason has neither of the app fields.
    expect(r.withApps === undefined).toBe(r.service === undefined);
    if (r.withApps !== undefined) {
      expect(r.withApps.match(/\{apps\}/g)).toHaveLength(1);
      expect(r.text).not.toContain("{apps}");
    }
  });

  it("names the example apps only when there are some", () => {
    const d1 = MANAGER_SCOPE_REASONS.d1;
    expect(scopeReasonText(d1)).toBe(d1.text);
    expect(scopeReasonText(d1, ["Mailflare"])).toContain("apps like Mailflare,");
    expect(scopeReasonText(d1, ["A", "B"])).toContain("apps like A and B,");
    expect(scopeReasonText(d1, ["A", "B", "C"])).toContain("apps like A, B and C,");
    const scripts = MANAGER_SCOPE_REASONS.workers_scripts;
    expect(scopeReasonText(scripts, ["A"])).toBe(scripts.text);
  });
});
