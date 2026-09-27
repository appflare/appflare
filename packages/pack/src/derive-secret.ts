import { createECDH } from "node:crypto";
import { BCRYPT_COST, isVapidPrivateKey, type SecretDeriveMethod } from "@appflare/schema";
import bcrypt from "bcryptjs";

/**
 * The value of a derived secret or var (a catalog `derive`), computed from
 * its source's value the way the manager computes it at install: `bcrypt` is
 * a `$2b$` hash at `BCRYPT_COST` with a fresh random salt, from bcryptjs;
 * `vapid-public-key` is the unpadded base64url of the 65-byte uncompressed
 * P-256 point of a VAPID private key. For tooling that installs an artifact
 * outside the manager, such as the catalog's install check, so a derived
 * value is a real one. Throws when a VAPID source is not a VAPID private key;
 * the message never repeats it.
 */
export function deriveSecretValue(method: SecretDeriveMethod, value: string): string {
  switch (method) {
    case "bcrypt":
      return bcrypt.hashSync(value, BCRYPT_COST);
    case "vapid-public-key": {
      if (!isVapidPrivateKey(value)) {
        throw new Error("not a VAPID private key: expected the base64url of a 32-byte P-256 key");
      }
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(Buffer.from(value, "base64url"));
      return ecdh.getPublicKey().toString("base64url");
    }
  }
}
