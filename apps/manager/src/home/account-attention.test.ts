import { describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import type { CapabilityRowsInput, CatalogNeeds } from "../capabilities/capability-rows";
import { accountAttentionRows, accountRowLink } from "./account-attention";

const ACC = "acc0000000000000000000000000000a";

const NONE: CatalogNeeds = {
  total: 0,
  workersPaid: 0,
  r2: 0,
  analyticsEngine: 0,
  zone: 0,
  emailRouting: 0,
  access: 0,
  sandbox: 0,
};

/** A new Workers Free account: R2 and Analytics Engine off, no domain, no Zero Trust. */
function input(inUse: Partial<CatalogNeeds>): CapabilityRowsInput {
  return {
    view: capabilitiesView(
      undefined,
      {
        checkedAt: "2026-09-24T10:00:00.000Z",
        r2: { state: "not-enabled" },
        containers: { state: "needs-workers-paid" },
        workersPlan: { state: "free" },
        zone: { state: "none" },
        emailRouting: { state: "no-zone" },
        workersDev: { state: "registered", subdomain: "acme" },
        zeroTrust: { state: "none" },
        analyticsEngine: { state: "not-enabled" },
      },
      ACC,
    ),
    sandbox: "off",
    needs: { ...NONE, total: 10, r2: 3, analyticsEngine: 2, zone: 1 },
    inUse: { ...NONE, ...inUse },
  };
}

describe("accountAttentionRows", () => {
  it("lists only what an app in the account needs and the account lacks, with its words", () => {
    const installs = [
      { id: "b", needs: { ...NONE, total: 1, r2: 1 } },
      { id: "a", needs: { ...NONE, total: 1 } },
      { id: "c", needs: { ...NONE, total: 1, r2: 1 } },
    ];
    const rows = accountAttentionRows(input({ total: 3, r2: 2 }), installs);
    expect(rows.map((r) => [r.id, r.name])).toEqual([["r2", "R2 storage"]]);
    expect(rows[0]?.found).toBe("Not turned on");
    expect(rows[0]?.why).not.toBe("");
    // "Not needed" may hide it, for the apps that need it now.
    expect(rows[0]?.dismissible).toBe(true);
    expect(rows[0]?.neededBy).toEqual(["b", "c"]);
  });

  it("leaves out what only other catalog apps would use", () => {
    expect(accountAttentionRows(input({ total: 1 }), [])).toEqual([]);
    expect(accountAttentionRows(input({}), [])).toEqual([]);
  });

  it("never lets Not needed hide the token's permissions", () => {
    const refused = input({});
    refused.view = capabilitiesView(
      undefined,
      {
        checkedAt: "2026-09-24T10:00:00.000Z",
        r2: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
        containers: { state: "needs-workers-paid" },
        workersPlan: { state: "free" },
        zone: { state: "none" },
        emailRouting: { state: "no-zone" },
        workersDev: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
        zeroTrust: { state: "none" },
        analyticsEngine: { state: "not-enabled" },
      },
      ACC,
    );
    const token = accountAttentionRows(refused, []).find((r) => r.id === "token-permissions");
    expect(token?.dismissible).toBe(false);
    expect(token?.neededBy).toEqual([]);
  });

  it("links each row to its own place on Your account", () => {
    expect(accountRowLink({ id: "r2" })).toBe("/settings/account#capability-r2");
  });
});
