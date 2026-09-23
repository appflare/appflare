import { beforeAll, describe, expect, it } from "vitest";
import { AUD, createTestAccessTeam, TEAM_DOMAIN, type TestAccessTeam } from "../test/access-jwt";
import { type AccessKeyLookup, verifyAccessJwt } from "./jwt";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const EXPECTED = { aud: AUD, teamDomain: TEAM_DOMAIN };

let team: TestAccessTeam;
let other: TestAccessTeam;
let keys: AccessKeyLookup;

async function importJwk(t: TestAccessTeam): Promise<CryptoKey> {
  const [jwk] = t.jwks.keys;
  if (jwk === undefined) throw new Error("no key");
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

beforeAll(async () => {
  team = await createTestAccessTeam("kid-team");
  other = await createTestAccessTeam("kid-other");
  const key = await importJwk(team);
  keys = async (kid) => (kid === team.kid ? key : null);
});

describe("verifyAccessJwt", () => {
  it("accepts a token Access signed for this application", async () => {
    const token = await team.sign(team.claims(NOW));
    expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
      ok: true,
      identity: { email: "admin@example.com", sub: "7335d417-61da-459d-899c-0a01c76a2f94" },
    });
  });

  it("accepts a string aud as well as an array", async () => {
    const token = await team.sign(team.claims(NOW, { aud: AUD }));
    expect((await verifyAccessJwt(token, EXPECTED, keys, NOW)).ok).toBe(true);
  });

  it("refuses a missing token", async () => {
    expect(await verifyAccessJwt(null, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await verifyAccessJwt("", EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("refuses an expired token, allowing 30 seconds of clock skew", async () => {
    const exp = Math.floor(NOW / 1000) - 31;
    const expired = await team.sign(team.claims(NOW - 3_600_000, { exp }));
    expect(await verifyAccessJwt(expired, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
    const justExpired = await team.sign(team.claims(NOW, { exp: Math.floor(NOW / 1000) - 5 }));
    expect((await verifyAccessJwt(justExpired, EXPECTED, keys, NOW)).ok).toBe(true);
  });

  it("refuses a token that is not valid yet", async () => {
    const token = await team.sign(team.claims(NOW, { nbf: Math.floor(NOW / 1000) + 120 }));
    expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  it("refuses a token for another application", async () => {
    const token = await team.sign(team.claims(NOW, { aud: ["another-application-aud"] }));
    expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
  });

  it("refuses every token when the stored aud is empty", async () => {
    const token = await team.sign(team.claims(NOW, { aud: [""] }));
    expect(await verifyAccessJwt(token, { ...EXPECTED, aud: "" }, keys, NOW)).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
  });

  it("refuses a token from another issuer", async () => {
    const token = await team.sign(
      team.claims(NOW, { iss: "https://someone-else.cloudflareaccess.com" }),
    );
    expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "wrong-issuer",
    });
  });

  it("refuses a token signed by a key the team does not publish", async () => {
    const token = await other.sign(team.claims(NOW));
    expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "unknown-key",
    });
  });

  it("refuses a token whose signature does not match (forged with another key, known kid)", async () => {
    const token = await other.sign(team.claims(NOW), { kid: team.kid });
    expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses a token whose claims were edited after signing", async () => {
    const token = await team.sign(team.claims(NOW, { email: "member@example.com" }));
    const [head, , sig] = token.split(".");
    const edited = btoa(JSON.stringify(team.claims(NOW)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyAccessJwt(`${head}.${edited}.${sig}`, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses any algorithm but RS256, including none", async () => {
    const none = await team.sign(team.claims(NOW), { alg: "none" });
    expect(await verifyAccessJwt(none, EXPECTED, keys, NOW)).toEqual({
      ok: false,
      reason: "unsupported-algorithm",
    });
    const hs = await team.sign(team.claims(NOW), { alg: "HS256" });
    expect((await verifyAccessJwt(hs, EXPECTED, keys, NOW)).ok).toBe(false);
  });

  it("refuses malformed tokens", async () => {
    for (const token of ["abc", "a.b", "a.b.c.d", "!!!.???.***", "e30.e30.e30"]) {
      expect(await verifyAccessJwt(token, EXPECTED, keys, NOW)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("fails closed when the keys cannot be fetched", async () => {
    const token = await team.sign(team.claims(NOW));
    const broken: AccessKeyLookup = async () => {
      throw new Error("certs unreachable");
    };
    expect(await verifyAccessJwt(token, EXPECTED, broken, NOW)).toEqual({
      ok: false,
      reason: "keys-unavailable",
    });
  });
});
