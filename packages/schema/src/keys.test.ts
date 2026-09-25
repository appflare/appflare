import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSigningKeypair } from "../scripts/signing-keypair.ts";
import {
  decodePublicKey,
  type SigningKey,
  signingKeys,
  verifyManifestSignature,
  verifySignature,
} from "./keys";

async function signWith(privateKeyPkcs8Base64: string, bytes: Uint8Array): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    "pkcs8",
    Buffer.from(privateKeyPkcs8Base64, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign({ name: "Ed25519" }, key, bytes);
  return Buffer.from(sig).toString("base64");
}

function manifestBytes(keyId: string): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ format: 1, app: "demo", version: "1.0.0", keyId }, null, 2)}\n`,
  );
}

describe("signingKeys", () => {
  it("embeds the manager and catalog key ids, sharing one 32-byte public key", () => {
    expect(signingKeys.map((k) => k.keyId)).toEqual(["appflare-2026-09", "catalog-2026-09"]);
    for (const key of signingKeys) {
      expect(decodePublicKey(key)).toHaveLength(32);
    }
    expect(new Set(signingKeys.map((k) => k.publicKeyBase64)).size).toBe(1);
  });

  it("has unique key ids and never trusts the unsigned id", () => {
    const ids = signingKeys.map((k) => k.keyId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("unsigned");
  });
});

describe("verifyManifestSignature", () => {
  it("rejects a manifest signed by a key whose id is not in signingKeys", async () => {
    const pair = await generateSigningKeypair();
    const bytes = manifestBytes("test-unknown-2026");
    const sig = await signWith(pair.privateKeyPkcs8Base64, bytes);
    await expect(verifyManifestSignature(bytes, sig)).rejects.toThrow(
      'no trusted signing key matches keyId "test-unknown-2026"',
    );
  });

  it("rejects a manifest that claims a trusted key id but was signed by another key", async () => {
    const pair = await generateSigningKeypair();
    const bytes = manifestBytes("appflare-2026-09");
    const sig = await signWith(pair.privateKeyPkcs8Base64, bytes);
    await expect(verifyManifestSignature(bytes, sig)).rejects.toThrow(
      'manifest signature does not verify with keyId "appflare-2026-09"',
    );
  });

  it("accepts a valid signature and rejects tampered bytes and unsigned artifacts", async () => {
    const pair = await generateSigningKeypair();
    const keys: SigningKey[] = [{ keyId: "test-2026", publicKeyBase64: pair.publicKeyBase64 }];
    expect(decodePublicKey(keys[0] as SigningKey)).toHaveLength(32);

    const bytes = manifestBytes("test-2026");
    const sig = await signWith(pair.privateKeyPkcs8Base64, bytes);
    await expect(verifyManifestSignature(bytes, sig, keys)).resolves.toEqual({
      keyId: "test-2026",
    });

    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 2] = 0x20; // "}" -> " "
    await expect(verifyManifestSignature(tampered, sig, keys)).rejects.toThrow();

    const unsigned = manifestBytes("unsigned");
    const unsignedSig = await signWith(pair.privateKeyPkcs8Base64, unsigned);
    await expect(verifyManifestSignature(unsigned, unsignedSig, keys)).rejects.toThrow(
      "artifact is unsigned",
    );
  });

  it("rejects a public key that is not 32 bytes", () => {
    expect(() => decodePublicKey({ keyId: "short", publicKeyBase64: "AAAA" })).toThrow(
      "signing key short is 3 bytes, expected 32",
    );
  });
});

describe("verifySignature", () => {
  it("checks a signature over any bytes with the key id given", async () => {
    const pair = await generateSigningKeypair();
    const keys: SigningKey[] = [{ keyId: "catalog-test", publicKeyBase64: pair.publicKeyBase64 }];
    const bytes = new TextEncoder().encode('{"slug":"cut","revision":2}\n');
    const sig = await signWith(pair.privateKeyPkcs8Base64, bytes);
    const labels = { signature: "manifest.json.sig", subject: "revised catalog manifest" };
    await expect(
      verifySignature(bytes, sig, "catalog-test", keys, labels),
    ).resolves.toBeUndefined();
    const tampered = new TextEncoder().encode('{"slug":"cut","revision":3}\n');
    await expect(verifySignature(tampered, sig, "catalog-test", keys, labels)).rejects.toThrow(
      'revised catalog manifest signature does not verify with keyId "catalog-test"',
    );
    await expect(verifySignature(bytes, sig, "unsigned", keys, labels)).rejects.toThrow(
      'no trusted signing key matches keyId "unsigned"',
    );
    await expect(verifySignature(bytes, "%%%", "catalog-test", keys, labels)).rejects.toThrow(
      "manifest.json.sig is not valid base64",
    );
  });
});
