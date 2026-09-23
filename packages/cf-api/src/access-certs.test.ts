import { describe, expect, it } from "vitest";
import { makeFakeFetch } from "./fake-fetch";
import {
  AccessCertsError,
  accessCertsUrl,
  fetchAccessCerts,
  isAccessTeamDomain,
} from "./namespaces/access";

const TEAM = "falling-mouse-0b3c.cloudflareaccess.com";

const KEY = {
  kid: "f54fb13f821b3fa6",
  kty: "RSA",
  alg: "RS256",
  use: "sig",
  e: "AQAB",
  n: "2mOqW3hnjG",
};

describe("isAccessTeamDomain", () => {
  it("accepts <team>.cloudflareaccess.com only", () => {
    expect(isAccessTeamDomain(TEAM)).toBe(true);
    expect(isAccessTeamDomain("cloudflareaccess.com")).toBe(false);
    expect(isAccessTeamDomain("evil.example.com")).toBe(false);
    expect(isAccessTeamDomain("team.cloudflareaccess.com.evil.example")).toBe(false);
    expect(isAccessTeamDomain("a.b.cloudflareaccess.com")).toBe(false);
    expect(isAccessTeamDomain("https://team.cloudflareaccess.com")).toBe(false);
  });

  it("builds the certs URL and refuses other hosts", () => {
    expect(accessCertsUrl(TEAM)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    expect(() => accessCertsUrl("example.com")).toThrow(/team domain/);
  });
});

describe("fetchAccessCerts", () => {
  it("GETs the team's certs without a token and returns the JWKs", async () => {
    const fake = makeFakeFetch({
      envelope: {
        keys: [KEY],
        public_cert: { kid: KEY.kid, cert: "-----BEGIN CERTIFICATE-----" },
        public_certs: [{ kid: KEY.kid, cert: "-----BEGIN CERTIFICATE-----" }],
      },
    });
    const certs = await fetchAccessCerts(TEAM, { fetch: fake.fetch });
    expect(certs).toEqual({ keys: [KEY] });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    expect(fake.last().authorization).toBeNull();
  });

  it("fails on an HTTP error", async () => {
    const fake = makeFakeFetch({ status: 502, text: "bad gateway" });
    await expect(fetchAccessCerts(TEAM, { fetch: fake.fetch })).rejects.toBeInstanceOf(
      AccessCertsError,
    );
  });

  it("fails on a body that is not a key set", async () => {
    const notJson = makeFakeFetch({ text: "<html>" });
    await expect(fetchAccessCerts(TEAM, { fetch: notJson.fetch })).rejects.toThrow(/not JSON/);
    const wrongShape = makeFakeFetch({ envelope: { keys: [{ kid: "x", kty: "EC" }] } });
    await expect(fetchAccessCerts(TEAM, { fetch: wrongShape.fetch })).rejects.toThrow(
      /unexpected shape/,
    );
  });

  it("never fetches from a host that is not a team domain", async () => {
    const fake = makeFakeFetch({ envelope: { keys: [] } });
    await expect(fetchAccessCerts("attacker.example", { fetch: fake.fetch })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});
