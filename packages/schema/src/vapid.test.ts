import { describe, expect, it } from "vitest";
import {
  generateVapidPrivateKey,
  isVapidPrivateKey,
  VAPID_PRIVATE_KEY_LENGTH,
  VAPID_PUBLIC_KEY_LENGTH,
  vapidPublicKey,
} from "./vapid";

function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** A VAPID key pair made the way web-push libraries make one, from a WebCrypto P-256 key. */
async function webCryptoPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: String(jwk.d), publicKey: Buffer.from(raw).toString("base64url") };
}

describe("VAPID keys", () => {
  it("generate a private key of 32 raw bytes as unpadded base64url", () => {
    const key = generateVapidPrivateKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(VAPID_PRIVATE_KEY_LENGTH);
    expect(fromBase64Url(key)).toHaveLength(32);
    expect(isVapidPrivateKey(key)).toBe(true);
    expect(generateVapidPrivateKey()).not.toBe(key);
  });

  it("derive the uncompressed public point, 65 bytes as unpadded base64url", async () => {
    const publicKey = await vapidPublicKey(generateVapidPrivateKey());
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(publicKey).toHaveLength(VAPID_PUBLIC_KEY_LENGTH);
    const point = fromBase64Url(publicKey);
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(0x04);
  });

  it("derive the same public key WebCrypto made with the private key", async () => {
    for (let i = 0; i < 8; i++) {
      const pair = await webCryptoPair();
      expect(await vapidPublicKey(pair.privateKey)).toBe(pair.publicKey);
    }
  });

  it("derive a public key that verifies what the private key signs", async () => {
    const privateKey = generateVapidPrivateKey();
    const point = fromBase64Url(await vapidPublicKey(privateKey));
    const x = Buffer.from(point.slice(1, 33)).toString("base64url");
    const y = Buffer.from(point.slice(33)).toString("base64url");
    const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
    const signer = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: privateKey, x, y },
      algorithm,
      false,
      ["sign"],
    );
    const verifier = await crypto.subtle.importKey("raw", point, algorithm, false, ["verify"]);
    const data = new TextEncoder().encode("aud=https://push.example");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, data);
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, data),
    ).toBe(true);
  });

  it("refuse what is not a P-256 private key, never repeating it", async () => {
    const scalar = (hex: string) => Buffer.from(hex.padStart(64, "0"), "hex").toString("base64url");
    const order = scalar("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    const one = scalar("1");
    const bad = [
      "",
      "short",
      `${generateVapidPrivateKey()}=`,
      "A".repeat(43), // zero
      order,
      "_".repeat(43), // above n, and not canonical
      "+/".repeat(21).concat("A"), // base64, not base64url
    ];
    for (const value of bad) {
      expect(isVapidPrivateKey(value), value).toBe(false);
      await expect(vapidPublicKey(value)).rejects.toThrow("not a VAPID private key");
    }
    // The smallest and largest scalars are keys; the generator's point is 1's public key.
    expect(await vapidPublicKey(one)).toBe(
      Buffer.from(
        "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
          "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
        "hex",
      ).toString("base64url"),
    );
    const last = scalar("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550");
    expect(isVapidPrivateKey(last)).toBe(true);
    // The last character's two spare bits must be zero.
    expect(one.endsWith("E")).toBe(true);
    expect(isVapidPrivateKey(`${one.slice(0, -1)}F`)).toBe(false);
  });
});
