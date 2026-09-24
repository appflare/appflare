import { describe, expect, it } from "vitest";
import {
  addCustomDomainInput,
  checkHostnameInZone,
  checkSubdomainInZone,
} from "./custom-domain-input";

describe("checkHostnameInZone", () => {
  it("accepts the zone apex and names under it, normalized", () => {
    expect(checkHostnameInZone("example.com", "example.com")).toEqual({
      ok: true,
      hostname: "example.com",
    });
    expect(checkHostnameInZone("  App.Example.COM. ", "example.com")).toEqual({
      ok: true,
      hostname: "app.example.com",
    });
    expect(checkHostnameInZone("a.b-c.example.com", "Example.com")).toEqual({
      ok: true,
      hostname: "a.b-c.example.com",
    });
  });

  it("turns an international name into Punycode", () => {
    expect(checkHostnameInZone("bücher.example.com", "example.com")).toEqual({
      ok: true,
      hostname: "xn--bcher-kva.example.com",
    });
  });

  it("refuses a hostname outside the zone, including a lookalike suffix", () => {
    for (const host of ["app.example.org", "notexample.com", "app.notexample.com", "com"]) {
      const result = checkHostnameInZone(host, "example.com");
      expect(result.ok, host).toBe(false);
    }
    expect(checkHostnameInZone("app.example.org", "example.com")).toEqual({
      ok: false,
      error: "The hostname must be example.com or end in .example.com.",
    });
  });

  it("refuses wildcards, URLs, and malformed names", () => {
    expect(checkHostnameInZone("*.example.com", "example.com")).toMatchObject({
      ok: false,
      error: expect.stringContaining("wildcards"),
    });
    expect(checkHostnameInZone("https://app.example.com/", "example.com")).toMatchObject({
      ok: false,
      error: "Enter only the hostname, such as app.example.com, without https:// or a path.",
    });
    for (const host of [
      "",
      "-app.example.com",
      "app-.example.com",
      "a..example.com",
      "app_1.example.com",
      `${"a".repeat(64)}.example.com`,
      `${"abcdefghi.".repeat(25)}example.com`,
    ]) {
      expect(checkHostnameInZone(host, "example.com").ok, host).toBe(false);
    }
  });
});

describe("checkSubdomainInZone", () => {
  it("takes an empty subdomain as the zone's root", () => {
    for (const empty of ["", "   ", "."]) {
      expect(checkSubdomainInZone(empty, "Example.com."), JSON.stringify(empty)).toEqual({
        ok: true,
        hostname: "example.com",
      });
    }
  });

  it("puts a subdomain in front of the zone, normalized", () => {
    expect(checkSubdomainInZone(" App ", "example.com")).toEqual({
      ok: true,
      hostname: "app.example.com",
    });
    expect(checkSubdomainInZone("bücher", "example.com")).toEqual({
      ok: true,
      hostname: "xn--bcher-kva.example.com",
    });
  });

  it("takes a whole hostname in the zone as it is, without doubling the zone", () => {
    expect(checkSubdomainInZone("sub.example.com", "example.com")).toEqual({
      ok: true,
      hostname: "sub.example.com",
    });
    expect(checkSubdomainInZone("a.b-c.example.com.", "example.com")).toEqual({
      ok: true,
      hostname: "a.b-c.example.com",
    });
    expect(checkSubdomainInZone("example.com", "example.com")).toEqual({
      ok: true,
      hostname: "example.com",
    });
    expect(checkSubdomainInZone("Example.com", "example.com")).toEqual({
      ok: true,
      hostname: "example.com",
    });
  });

  it("refuses a dotted name outside the zone instead of putting it under the zone", () => {
    for (const other of ["evil.com", "a.b", "example.com.evil.com", "notexample.com"]) {
      expect(checkSubdomainInZone(other, "example.com"), other).toEqual({
        ok: false,
        error: "Enter a name under example.com, or leave empty for the root.",
      });
    }
  });

  it("refuses URLs, wildcards and malformed labels", () => {
    expect(checkSubdomainInZone("https://app", "example.com")).toEqual({
      ok: false,
      error: "Enter only the name before .example.com, such as app, without https:// or a path.",
    });
    expect(checkSubdomainInZone("*", "example.com")).toMatchObject({
      ok: false,
      error: expect.stringContaining("wildcards"),
    });
    for (const sub of ["-app", "app-", "a..b", "app_1", "a".repeat(64)]) {
      expect(checkSubdomainInZone(sub, "example.com").ok, sub).toBe(false);
    }
  });

  it("gives the hostname the server accepts for the same zone", () => {
    for (const sub of ["", "app", "app.example.com"]) {
      const checked = checkSubdomainInZone(sub, "example.com");
      if (!checked.ok) throw new Error(checked.error);
      expect(checkHostnameInZone(checked.hostname, "example.com")).toEqual(checked);
    }
  });
});

describe("addCustomDomainInput", () => {
  it("takes the override flag as an optional boolean", () => {
    const base = { installId: "i1", zoneId: "z1", hostname: "app.example.com" };
    expect(addCustomDomainInput.safeParse(base).success).toBe(true);
    expect(
      addCustomDomainInput.safeParse({ ...base, overrideExistingDnsRecord: true }).success,
    ).toBe(true);
    expect(
      addCustomDomainInput.safeParse({ ...base, overrideExistingDnsRecord: "yes" }).success,
    ).toBe(false);
    expect(addCustomDomainInput.safeParse({ ...base, zoneId: "" }).success).toBe(false);
  });
});
