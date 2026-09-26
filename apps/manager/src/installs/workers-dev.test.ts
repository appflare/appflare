import { describe, expect, it } from "vitest";
import {
  appBaseUrl,
  domainHostnames,
  MANAGER_SUBDOMAIN,
  primaryDomain,
  workersDevBase,
  workersDevSubdomain,
  workersDevWhenDomainLive,
  workersDevWhenDomainRemoved,
} from "./workers-dev";

describe("domainHostnames with liveness", () => {
  it("puts live domains first, so the primary domain is never a pending one", () => {
    const rows = [
      { id: "i1:domain:01A", kind: "domain", name: "pending.example.com", live_at: null },
      { id: "i1:domain:01C", kind: "domain", name: "later.example.com", live_at: 9 },
      { id: "i1:domain:01B", kind: "domain", name: "live.example.com", live_at: new Date(5) },
    ];
    expect(domainHostnames(rows)).toEqual([
      "live.example.com",
      "later.example.com",
      "pending.example.com",
    ]);
    expect(primaryDomain(domainHostnames(rows), null)).toBe("live.example.com");
    expect(
      appBaseUrl({
        workerName: "cut",
        subdomain: "acme",
        workersDev: false,
        domains: domainHostnames(rows),
        served: "removed.example.com",
      }),
    ).toBe("https://live.example.com");
  });
});

describe("workersDevWhenDomainLive", () => {
  const state = {
    choice: "auto" as const,
    enabled: true,
    selfDeploying: false,
    settingsUseWorkersDevUrl: false,
  };

  it("turns workers.dev off while Appflare decides", () => {
    expect(workersDevWhenDomainLive(state)).toEqual({ action: "turn-off" });
  });

  it("keeps it once an admin used the switch", () => {
    expect(workersDevWhenDomainLive({ ...state, choice: "manual" })).toEqual({
      action: "keep",
      reason: "manual",
    });
  });

  it("keeps it when it is off already, for a self-deploying app, or when settings hold the URL", () => {
    expect(workersDevWhenDomainLive({ ...state, enabled: false })).toEqual({
      action: "keep",
      reason: "off",
    });
    expect(workersDevWhenDomainLive({ ...state, selfDeploying: true })).toEqual({
      action: "keep",
      reason: "self-deploying",
    });
    expect(workersDevWhenDomainLive({ ...state, settingsUseWorkersDevUrl: true })).toEqual({
      action: "keep",
      reason: "settings",
    });
  });
});

describe("workersDevWhenDomainRemoved", () => {
  it("changes nothing while workers.dev is on or another live domain remains", () => {
    expect(
      workersDevWhenDomainRemoved({ choice: "auto", enabled: true, otherLiveDomains: 0 }),
    ).toEqual({ action: "keep" });
    expect(
      workersDevWhenDomainRemoved({ choice: "manual", enabled: false, otherLiveDomains: 1 }),
    ).toEqual({ action: "keep" });
  });

  it("turns workers.dev back on with the last live domain when Appflare turned it off", () => {
    expect(
      workersDevWhenDomainRemoved({ choice: "auto", enabled: false, otherLiveDomains: 0 }),
    ).toEqual({ action: "turn-on" });
  });

  it("refuses the removal when an admin turned it off", () => {
    expect(
      workersDevWhenDomainRemoved({ choice: "manual", enabled: false, otherLiveDomains: 0 }),
    ).toMatchObject({ action: "refuse" });
  });
});

describe("workersDevSubdomain", () => {
  it("sends the stored choice and always keeps version previews on", () => {
    expect(workersDevSubdomain(true)).toEqual({ enabled: true, previews_enabled: true });
    expect(workersDevSubdomain(false)).toEqual({ enabled: false, previews_enabled: true });
  });

  it("keeps Appflare's own workers.dev URL on", () => {
    expect(MANAGER_SUBDOMAIN).toEqual({ enabled: true, previews_enabled: true });
  });
});

describe("appBaseUrl", () => {
  const base = { workerName: "cut", subdomain: "acme" };

  it("is the workers.dev URL while that is on, whatever domains exist", () => {
    expect(appBaseUrl({ ...base, workersDev: true, domains: ["links.example.com"] })).toBe(
      "https://cut.acme.workers.dev",
    );
    expect(workersDevBase("cut", "acme")).toBe("https://cut.acme.workers.dev");
  });

  it("is the first custom domain while workers.dev is off", () => {
    expect(
      appBaseUrl({ ...base, workersDev: false, domains: ["links.example.com", "b.example.com"] }),
    ).toBe("https://links.example.com");
  });

  it("falls back to workers.dev when it is off and no domain is left", () => {
    expect(appBaseUrl({ ...base, workersDev: false, domains: [] })).toBe(
      "https://cut.acme.workers.dev",
    );
  });
});

describe("domainHostnames", () => {
  it("lists custom domains in the order they were added (by their ULID ids)", () => {
    expect(
      domainHostnames([
        { id: "i1:domain:01J9B", kind: "domain", name: "second.example.com" },
        { id: "i1:kv:CACHE", kind: "kv", name: "cut-cache" },
        { id: "i1:domain:01J9A", kind: "domain", name: "first.example.com" },
      ]),
    ).toEqual(["first.example.com", "second.example.com"]);
  });
});

describe("primaryDomain", () => {
  const domains = ["first.example.com", "second.example.com"];

  it("is the domain the switch verified while it is still attached, else the first", () => {
    expect(primaryDomain(domains, "second.example.com")).toBe("second.example.com");
    expect(primaryDomain(domains, "removed.example.com")).toBe("first.example.com");
    expect(primaryDomain(domains, null)).toBe("first.example.com");
    expect(primaryDomain([], "second.example.com")).toBeNull();
    expect(
      appBaseUrl({
        workerName: "cut",
        subdomain: "acme",
        workersDev: false,
        domains,
        served: "second.example.com",
      }),
    ).toBe("https://second.example.com");
  });
});
