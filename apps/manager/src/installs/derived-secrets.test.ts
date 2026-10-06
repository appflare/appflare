import { type CatalogSecret, type CatalogVar, generateVapidPrivateKey } from "@appflare/schema";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { secretsOf, varsOf } from "../test/artifact-fixture";
import {
  derivedVarValues,
  deriveSecretValue,
  heldSecrets,
  secretsToAskFor,
  secretsToSet,
  sourcesOfUnsetDerivedVars,
  withDerivedSecrets,
} from "./derived-secrets";

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

// Counterscale's shape: a password the admin types, its bcrypt hash, and a generated key.
const secrets: CatalogSecret[] = secretsOf([
  { name: "CF_PASSWORD", label: "Admin password" },
  {
    name: "CF_PASSWORD_HASH",
    label: "Admin password hash",
    derive: { from: "CF_PASSWORD", method: "bcrypt" },
  },
  { name: "CF_JWT_SECRET", label: "Session key", generate: "password" },
]);
const [password, hash, jwt] = secrets as [CatalogSecret, CatalogSecret, CatalogSecret];

describe("bcrypt in the Workers runtime", () => {
  it("matches the crypt_blowfish test vectors", () => {
    // From Openwall's crypt_blowfish (the reference C implementation's own tests).
    const vectors: Array<[string, string]> = [
      ["U*U", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW"],
      ["U*U*", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.VGOzA784oUp/Z0DY336zx7pLYAy0lwK"],
      ["U*U*U", "$2a$05$XXXXXXXXXXXXXXXXXXXXXOAcXxm9kjPGEMsLznoKqmqw7tc8WCx4a"],
      [
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789chars after 72 are ignored",
        "$2a$05$abcdefghijklmnopqrstuu5s2v8.iXieOjg/.AySBTTZIIVFJeBui",
      ],
    ];
    for (const [value, expected] of vectors) {
      expect(bcrypt.hashSync(value, expected.slice(0, 29))).toBe(expected);
      expect(bcrypt.compareSync(value, expected)).toBe(true);
    }
  });
});

describe("deriveSecretValue", () => {
  it("gives a $2b$ cost-10 hash with a fresh salt that bcrypt.compare accepts", async () => {
    const first = await deriveSecretValue("bcrypt", "correct horse battery staple");
    const second = await deriveSecretValue("bcrypt", "correct horse battery staple");
    expect(first).toMatch(/^\$2b\$10\$[./A-Za-z0-9]{53}$/);
    expect(second).not.toBe(first);
    // What Counterscale's login does with CF_PASSWORD_HASH.
    expect(await bcrypt.compare("correct horse battery staple", first)).toBe(true);
    expect(await bcrypt.compare("wrong", first)).toBe(false);
  });
});

describe("withDerivedSecrets", () => {
  it("adds the derived value from its source and keeps the others as given", async () => {
    const out = await withDerivedSecrets(secrets, { CF_PASSWORD: "hunter2", CF_JWT_SECRET: "k" });
    expect(Object.keys(out).sort()).toEqual(["CF_JWT_SECRET", "CF_PASSWORD", "CF_PASSWORD_HASH"]);
    expect(out.CF_PASSWORD).toBe("hunter2");
    expect(bcrypt.compareSync("hunter2", out.CF_PASSWORD_HASH ?? "")).toBe(true);
  });

  it("never takes a derived value as given, and derives nothing without its source", async () => {
    expect(
      await withDerivedSecrets(secrets, { CF_PASSWORD_HASH: "$2b$10$forged", CF_JWT_SECRET: "k" }),
    ).toEqual({ CF_JWT_SECRET: "k" });
    const out = await withDerivedSecrets(secrets, {
      CF_PASSWORD: "hunter2",
      CF_PASSWORD_HASH: "$2b$10$forged",
    });
    expect(out.CF_PASSWORD_HASH).not.toBe("$2b$10$forged");
    expect(bcrypt.compareSync("hunter2", out.CF_PASSWORD_HASH ?? "")).toBe(true);
  });
});

describe("a derived secret whose source has a key of its own", () => {
  const keyed = secretsOf([
    { name: "PASSWORD", key: "ADMIN_PASSWORD", label: "Password", generate: "password" },
    { name: "PASSWORD_HASH", label: "Hash", derive: { from: "ADMIN_PASSWORD", method: "bcrypt" } },
  ]);

  it("is computed from the source's value by key, and asks for the source by key", async () => {
    const out = await withDerivedSecrets(keyed, { ADMIN_PASSWORD: "hunter2" });
    expect(Object.keys(out).sort()).toEqual(["ADMIN_PASSWORD", "PASSWORD_HASH"]);
    expect(bcrypt.compareSync("hunter2", out.PASSWORD_HASH ?? "")).toBe(true);
    const [source, hashed] = keyed;
    if (source === undefined || hashed === undefined) throw new Error("no secrets");
    expect(secretsToAskFor(keyed, [hashed])).toEqual([source]);
    expect(secretsToSet(keyed, [hashed])).toEqual([source, hashed]);
  });
});

describe("secretsToAskFor and secretsToSet", () => {
  it("ask for the source of a missing derived secret, and set both", () => {
    expect(secretsToAskFor(secrets, [hash])).toEqual([password]);
    expect(secretsToSet(secrets, [hash])).toEqual([password, hash]);
    expect(secretsToAskFor(secrets, [jwt, hash, password])).toEqual([password, jwt]);
    expect(secretsToSet(secrets, [jwt])).toEqual([jwt]);
  });
});

// A push app's shape: a generated VAPID private key, and its public key as a var.
const push: { secrets: CatalogSecret[]; vars: CatalogVar[] } = {
  secrets: secretsOf([
    { name: "VAPID_PRIVATE_KEY", label: "Push signing key", generate: "vapid-private-key" },
    { name: "SESSION", label: "Session key", generate: "password" },
  ]),
  vars: varsOf([
    { name: "HOME", label: "Home", optional: true },
    {
      name: "VAPID_PUBLIC_KEY",
      label: "Push public key",
      derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
    },
  ]),
};

describe("VAPID keys in the Workers runtime", () => {
  it("derive the public key WebCrypto made with the private key", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    const publicKey = await deriveSecretValue("vapid-public-key", jwk.d ?? "");
    expect(publicKey).toHaveLength(87);
    expect(fromBase64Url(publicKey)).toEqual(raw);
  });

  it("generate a private key whose public key WebCrypto imports", async () => {
    const privateKey = generateVapidPrivateKey();
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(privateKey)).toHaveLength(32);
    const point = fromBase64Url(await deriveSecretValue("vapid-public-key", privateKey));
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    await expect(
      crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, true, [
        "verify",
      ]),
    ).resolves.toBeDefined();
  });

  it("refuse a value that is not a private key, never repeating it", async () => {
    await expect(deriveSecretValue("vapid-public-key", "hunter2")).rejects.toThrow(
      /^not a VAPID private key/,
    );
  });
});

describe("derived vars", () => {
  it("are computed from their source's new value, and only then", async () => {
    const privateKey = generateVapidPrivateKey();
    expect(await derivedVarValues(push.vars, { VAPID_PRIVATE_KEY: privateKey })).toEqual({
      VAPID_PUBLIC_KEY: await deriveSecretValue("vapid-public-key", privateKey),
    });
    expect(await derivedVarValues(push.vars, { SESSION: "k" })).toEqual({});
  });

  it("without a stored value ask for their source again, which the update sets with them", () => {
    expect(sourcesOfUnsetDerivedVars(push.vars, {})).toEqual(["VAPID_PRIVATE_KEY"]);
    expect(sourcesOfUnsetDerivedVars(push.vars, { VAPID_PUBLIC_KEY: "BK" })).toEqual([]);
    const [privateKey] = push.secrets as [CatalogSecret];
    expect(secretsToAskFor(push.secrets, [], ["VAPID_PRIVATE_KEY"])).toEqual([privateKey]);
    expect(secretsToSet(push.secrets, [], ["VAPID_PRIVATE_KEY"])).toEqual([privateKey]);
    // The source the Worker has already is held: its field must start empty.
    expect(heldSecrets([privateKey], ["VAPID_PRIVATE_KEY", "SESSION"])).toEqual([
      "VAPID_PRIVATE_KEY",
    ]);
    expect(heldSecrets([privateKey], [])).toEqual([]);
    // A secret derived from a source asked for again is set again with it.
    expect(secretsToSet(secrets, [], ["CF_PASSWORD"])).toEqual([password, hash]);
  });
});
