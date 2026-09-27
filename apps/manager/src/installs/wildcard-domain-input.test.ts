import { describe, expect, it } from "vitest";
import {
  addWildcardDomainInput,
  checkWildcardBase,
  checkWildcardSubdomain,
  domainLabel,
  wildcardCertificateNote,
  wildcardOfManifest,
  wildcardPattern,
  wildcardRecordNames,
  wildcardRoutePatterns,
} from "./wildcard-domain-input";

describe("wildcard names", () => {
  it("names the pattern, records and routes of a base", () => {
    expect(wildcardPattern("tunnels.example.com")).toBe("*.tunnels.example.com");
    expect(wildcardRecordNames("tunnels.example.com")).toEqual([
      "tunnels.example.com",
      "*.tunnels.example.com",
    ]);
    // `*.<base>/*` matches every name under the base but not the base itself.
    expect(wildcardRoutePatterns("tunnels.example.com")).toEqual([
      "tunnels.example.com/*",
      "*.tunnels.example.com/*",
    ]);
  });

  it("labels a wildcard domain by its pattern and a custom domain by its hostname", () => {
    expect(domainLabel({ hostname: "tunnels.example.com", wildcard: true })).toBe(
      "*.tunnels.example.com",
    );
    expect(domainLabel({ hostname: "app.example.com", wildcard: false })).toBe("app.example.com");
  });
});

describe("checkWildcardBase", () => {
  it("accepts a name under the zone, which needs a certificate for the names below it", () => {
    expect(checkWildcardBase("Tunnels.Example.com.", "example.com")).toEqual({
      ok: true,
      hostname: "tunnels.example.com",
      wholeDomain: false,
      needsCertificate: true,
    });
  });

  it("accepts the zone itself as a whole domain, which the zone's certificate covers", () => {
    expect(checkWildcardBase("example.com", "example.com")).toEqual({
      ok: true,
      hostname: "example.com",
      wholeDomain: true,
      needsCertificate: false,
    });
  });

  it("refuses a pattern, a name in another zone, and a URL", () => {
    for (const input of ["*.tunnels.example.com", "tunnels.other.org", "https://x.example.com"]) {
      expect(checkWildcardBase(input, "example.com").ok, input).toBe(false);
    }
  });
});

describe("checkWildcardSubdomain", () => {
  it("takes what comes before the zone, empty for the zone itself", () => {
    expect(checkWildcardSubdomain("tunnels", "example.com")).toMatchObject({
      ok: true,
      hostname: "tunnels.example.com",
      wholeDomain: false,
    });
    expect(checkWildcardSubdomain("", "example.com")).toMatchObject({
      ok: true,
      hostname: "example.com",
      wholeDomain: true,
    });
  });

  it("says to leave out the star", () => {
    const checked = checkWildcardSubdomain("*.tunnels", "example.com");
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toContain('without "*."');
  });
});

describe("wildcardCertificateNote", () => {
  it("names the base, the pattern and what covers it", () => {
    const note = wildcardCertificateNote("tunnels.example.com", "example.com");
    expect(note).toContain("*.tunnels.example.com");
    expect(note).toContain("Total TLS");
    expect(note).toContain("https://tunnels.example.com works");
  });
});

describe("wildcardOfManifest", () => {
  const manifest = (install: Record<string, unknown>) =>
    JSON.stringify({ format: 4, catalog: { slug: "hostc", install } });

  it("reads the flag and the reason from the recorded manifest", () => {
    expect(
      wildcardOfManifest(manifest({ wildcardHostname: true, wildcardReason: "Each tunnel." })),
    ).toEqual({ reason: "Each tunnel." });
  });

  it("is null without the flag, or for a manifest it cannot read", () => {
    expect(wildcardOfManifest(manifest({}))).toBeNull();
    expect(wildcardOfManifest(manifest({ wildcardHostname: false }))).toBeNull();
    expect(wildcardOfManifest(null)).toBeNull();
    expect(wildcardOfManifest("{")).toBeNull();
    expect(wildcardOfManifest(JSON.stringify({ version: "1.0.0" }))).toBeNull();
  });
});

describe("addWildcardDomainInput", () => {
  it("takes the zone, the base, and the agreement for a whole domain", () => {
    expect(
      addWildcardDomainInput.parse({
        installId: "i1",
        zoneId: "z-a",
        hostname: "example.com",
        wholeDomain: true,
      }),
    ).toEqual({ installId: "i1", zoneId: "z-a", hostname: "example.com", wholeDomain: true });
    expect(addWildcardDomainInput.safeParse({ installId: "i1", hostname: "x" }).success).toBe(
      false,
    );
  });
});
