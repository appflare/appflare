import { describe, expect, it } from "vitest";
import { channelKey, decryptConfig, encryptConfig, newSigningSecret, signBody } from "./crypto";

const CONFIG = {
  kind: "telegram" as const,
  botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ",
  chatId: "-100123",
};

describe("channel credentials at rest", () => {
  it("round-trips, and the stored text contains nothing readable", async () => {
    const key = await channelKey("secret-one-0123456789");
    const sealed = await encryptConfig(key, "ch1", CONFIG);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("AAHdq");
    expect(sealed).not.toContain("-100123");
    expect(await decryptConfig(key, "ch1", sealed)).toEqual(CONFIG);
  });

  it("uses a fresh IV each time", async () => {
    const key = await channelKey("secret-one-0123456789");
    expect(await encryptConfig(key, "ch1", CONFIG)).not.toBe(
      await encryptConfig(key, "ch1", CONFIG),
    );
  });

  it("binds the ciphertext to its channel id", async () => {
    const key = await channelKey("secret-one-0123456789");
    const sealed = await encryptConfig(key, "ch1", CONFIG);
    expect(await decryptConfig(key, "ch2", sealed)).toBeNull();
  });

  it("cannot be read with a key from another secret, or when tampered with", async () => {
    const sealed = await encryptConfig(await channelKey("secret-one-0123456789"), "ch1", CONFIG);
    expect(
      await decryptConfig(await channelKey("secret-two-0123456789"), "ch1", sealed),
    ).toBeNull();
    const key = await channelKey("secret-one-0123456789");
    // Flip a character whose bits are all ciphertext: writing "AA" over the end
    // left a seal unchanged whenever it already ended in "AA".
    const flipped = sealed.at(-6) === "A" ? "B" : "A";
    const damaged = `${sealed.slice(0, -6)}${flipped}${sealed.slice(-5)}`;
    expect(await decryptConfig(key, "ch1", damaged)).toBeNull();
    expect(await decryptConfig(key, "ch1", "v2.x.y")).toBeNull();
    expect(await decryptConfig(key, "ch1", "garbage")).toBeNull();
  });

  it("refuses to derive a key without the Worker secret", async () => {
    await expect(channelKey(undefined)).rejects.toThrow(/BETTER_AUTH_SECRET/);
    await expect(channelKey("")).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe("webhook signatures", () => {
  it("is the hex HMAC-SHA256 of the body (known vector)", async () => {
    expect(await signBody("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("makes long random signing secrets", () => {
    const a = newSigningSecret();
    expect(a).toMatch(/^afwhsec_[\w-]{43}$/);
    expect(newSigningSecret()).not.toBe(a);
  });
});
