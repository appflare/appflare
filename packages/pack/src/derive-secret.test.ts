import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { deriveSecretValue } from "./derive-secret.ts";

describe("deriveSecretValue", () => {
  it("uses a bcrypt that matches the crypt_blowfish test vectors", () => {
    // From Openwall's crypt_blowfish, the reference implementation's own tests.
    expect(bcrypt.hashSync("U*U", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.")).toBe(
      "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
    );
  });

  it("gives a $2b$ cost-10 hash with a fresh salt that bcrypt.compare accepts", () => {
    const first = deriveSecretValue("bcrypt", "correct horse");
    expect(first).toMatch(/^\$2b\$10\$[./A-Za-z0-9]{53}$/);
    expect(deriveSecretValue("bcrypt", "correct horse")).not.toBe(first);
    expect(bcrypt.compareSync("correct horse", first)).toBe(true);
    expect(bcrypt.compareSync("wrong", first)).toBe(false);
  });
});
