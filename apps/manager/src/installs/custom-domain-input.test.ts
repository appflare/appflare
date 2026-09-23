import { describe, expect, it } from "vitest";
import { addCustomDomainInput, checkHostnameInZone } from "./custom-domain-input";

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
