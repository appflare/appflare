import { describe, expect, it } from "vitest";
import { constantTimeEquals } from "./constant-time";

describe("constantTimeEquals", () => {
  const secret = "s3cret-7f1c9a2e4b6d8f0a";

  it("accepts the exact value", async () => {
    expect(await constantTimeEquals(secret, secret)).toBe(true);
  });

  it("rejects a wrong value of the same length", async () => {
    const wrong = `${secret.slice(0, -1)}b`;
    expect(wrong.length).toBe(secret.length);
    expect(await constantTimeEquals(wrong, secret)).toBe(false);
  });

  it("rejects values of a different length without throwing", async () => {
    expect(await constantTimeEquals(secret.slice(1), secret)).toBe(false);
    expect(await constantTimeEquals(`${secret}x`, secret)).toBe(false);
  });

  it("never matches a missing or empty value on either side", async () => {
    expect(await constantTimeEquals(undefined, secret)).toBe(false);
    expect(await constantTimeEquals(null, secret)).toBe(false);
    expect(await constantTimeEquals("", secret)).toBe(false);
    expect(await constantTimeEquals("", "")).toBe(false);
    expect(await constantTimeEquals("anything", undefined)).toBe(false);
  });
});
