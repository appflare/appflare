import { describe, expect, it } from "vitest";
import { openServiceTokenSecret, sealServiceTokenSecret } from "./service-token-secret";

const AUTH = "auth-secret-one-0123456789abcdef";
const SECRET = "client-secret-DO-NOT-LEAK-0123456789abcdef";
const T1 = { installId: "i1", tokenId: "tok-1" };

describe("the service token's secret at rest", () => {
  it("round-trips, and the stored text contains nothing readable", async () => {
    const sealed = await sealServiceTokenSecret(AUTH, T1, SECRET);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("DO-NOT-LEAK");
    expect(await openServiceTokenSecret(AUTH, T1, sealed)).toBe(SECRET);
  });

  it("uses a fresh IV each time", async () => {
    expect(await sealServiceTokenSecret(AUTH, T1, SECRET)).not.toBe(
      await sealServiceTokenSecret(AUTH, T1, SECRET),
    );
  });

  it("is bound to its install and token ids", async () => {
    const sealed = await sealServiceTokenSecret(AUTH, T1, SECRET);
    expect(
      await openServiceTokenSecret(AUTH, { installId: "i1", tokenId: "tok-2" }, sealed),
    ).toBeNull();
    expect(
      await openServiceTokenSecret(AUTH, { installId: "i2", tokenId: "tok-1" }, sealed),
    ).toBeNull();
  });

  it("cannot be read after BETTER_AUTH_SECRET changed, without it, or when damaged", async () => {
    const sealed = await sealServiceTokenSecret(AUTH, T1, SECRET);
    expect(await openServiceTokenSecret("auth-secret-two-0123456789", T1, sealed)).toBeNull();
    expect(await openServiceTokenSecret(undefined, T1, sealed)).toBeNull();
    expect(await openServiceTokenSecret("", T1, sealed)).toBeNull();
    // Flip a character whose bits are all ciphertext: writing "AA" over the end
    // left a seal unchanged whenever it already ended in "AA".
    const flipped = sealed.at(-6) === "A" ? "B" : "A";
    const damaged = `${sealed.slice(0, -6)}${flipped}${sealed.slice(-5)}`;
    expect(await openServiceTokenSecret(AUTH, T1, damaged)).toBeNull();
    expect(await openServiceTokenSecret(AUTH, T1, "v2.x.y")).toBeNull();
    expect(await openServiceTokenSecret(AUTH, T1, "garbage")).toBeNull();
  });

  it("refuses to seal without the Worker secret", async () => {
    await expect(sealServiceTokenSecret(undefined, T1, SECRET)).rejects.toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});
