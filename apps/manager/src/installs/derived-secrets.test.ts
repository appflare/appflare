import type { CatalogSecret } from "@appflare/schema";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  deriveSecretValue,
  secretsToAskFor,
  secretsToSet,
  withDerivedSecrets,
} from "./derived-secrets";

// Counterscale's shape: a password the admin types, its bcrypt hash, and a generated key.
const secrets: CatalogSecret[] = [
  { name: "CF_PASSWORD", label: "Admin password", generate: false },
  {
    name: "CF_PASSWORD_HASH",
    label: "Admin password hash",
    generate: false,
    derive: { from: "CF_PASSWORD", method: "bcrypt" },
  },
  { name: "CF_JWT_SECRET", label: "Session key", generate: true },
];
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

describe("secretsToAskFor and secretsToSet", () => {
  it("ask for the source of a missing derived secret, and set both", () => {
    expect(secretsToAskFor(secrets, [hash])).toEqual([password]);
    expect(secretsToSet(secrets, [hash])).toEqual([password, hash]);
    expect(secretsToAskFor(secrets, [jwt, hash, password])).toEqual([password, jwt]);
    expect(secretsToSet(secrets, [jwt])).toEqual([jwt]);
  });
});
