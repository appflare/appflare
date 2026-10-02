import { describe, expect, it } from "vitest";
import { accessAppCoverage } from "./namespaces/access";
import type { CreateAccessAppArgs } from "./types";

describe("accessAppCoverage", () => {
  it("reads a single-domain application", () => {
    expect(accessAppCoverage({ domain: "Appflare.Example.com" })).toEqual({
      uris: ["appflare.example.com"],
      hostnames: ["appflare.example.com"],
      workerIds: [],
    });
  });

  it("keeps a path, lower-casing only the host", () => {
    expect(accessAppCoverage({ domain: "Host.Example.com/API/health" }).uris).toEqual([
      "host.example.com/API/health",
    ]);
  });

  it("reads public destinations when domain is null, and reports workers separately", () => {
    const coverage = accessAppCoverage({
      domain: null,
      destinations: [
        { type: "worker", worker_id: "tag123" },
        { type: "public", uri: "notes.example.com" },
        { type: "public", uri: "notes.example.com/open/*" },
        { type: "public", uri: "notes.acct.workers.dev" },
      ],
    });
    expect(coverage).toEqual({
      uris: ["notes.example.com", "notes.example.com/open/*", "notes.acct.workers.dev"],
      hostnames: ["notes.example.com", "notes.acct.workers.dev"],
      workerIds: ["tag123"],
    });
  });

  it("merges domain, self_hosted_domains and destinations without duplicates", () => {
    const coverage = accessAppCoverage({
      domain: "a.example.com",
      self_hosted_domains: ["a.example.com", "b.example.com"],
      destinations: [
        { type: "public", uri: "A.example.com" },
        { type: "public", uri: "b.example.com" },
      ],
    });
    expect(coverage.uris).toEqual(["a.example.com", "b.example.com"]);
    expect(coverage.hostnames).toEqual(["a.example.com", "b.example.com"]);
  });

  it("ignores destination kinds it does not know, and malformed entries", () => {
    const coverage = accessAppCoverage({
      destinations: [
        { type: "private", hostname: "db.internal", cidr: "10.0.0.0/8" },
        { type: "public" } as unknown as { type: "public"; uri: string },
        { type: "worker", worker_id: "" },
        { type: "public", uri: "  " },
      ],
    });
    expect(coverage).toEqual({ uris: [], hostnames: [], workerIds: [] });
  });

  it("covers nothing for an application with neither", () => {
    expect(accessAppCoverage({})).toEqual({ uris: [], hostnames: [], workerIds: [] });
  });
});

describe("CreateAccessAppArgs", () => {
  it("takes a domain, destinations, or both, but not neither", () => {
    const byDomain: CreateAccessAppArgs = { type: "self_hosted", name: "a", domain: "a.example" };
    const byDestinations: CreateAccessAppArgs = {
      type: "self_hosted",
      name: "b",
      destinations: [{ type: "public", uri: "b.example" }],
    };
    // @ts-expect-error: an application must protect something.
    const neither: CreateAccessAppArgs = { type: "self_hosted", name: "c" };
    expect([byDomain, byDestinations, neither]).toHaveLength(3);
  });
});
