import { describe, expect, it } from "vitest";
import { setupTokenMatches } from "./setup-token";

describe("setupTokenMatches", () => {
  const secret = "s3tup-t0ken-7f1c9a2e4b6d8f0a";

  it("accepts the exact token", async () => {
    expect(await setupTokenMatches(secret, secret)).toBe(true);
  });

  it("rejects a wrong token of the same length", async () => {
    const wrong = `${secret.slice(0, -1)}b`;
    expect(wrong.length).toBe(secret.length);
    expect(await setupTokenMatches(wrong, secret)).toBe(false);
  });

  it("rejects tokens of a different length without throwing", async () => {
    expect(await setupTokenMatches(secret.slice(1), secret)).toBe(false);
    expect(await setupTokenMatches(`${secret}x`, secret)).toBe(false);
  });

  it("rejects a missing or empty token", async () => {
    expect(await setupTokenMatches(undefined, secret)).toBe(false);
    expect(await setupTokenMatches(null, secret)).toBe(false);
    expect(await setupTokenMatches("", secret)).toBe(false);
  });

  it("never matches when the secret is unset (already consumed)", async () => {
    expect(await setupTokenMatches("", "")).toBe(false);
    expect(await setupTokenMatches("anything", undefined)).toBe(false);
  });
});
