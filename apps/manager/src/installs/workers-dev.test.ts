import { describe, expect, it } from "vitest";
import {
  appBaseUrl,
  domainHostnames,
  MANAGER_SUBDOMAIN,
  primaryDomain,
  workersDevBase,
  workersDevSubdomain,
} from "./workers-dev";

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
