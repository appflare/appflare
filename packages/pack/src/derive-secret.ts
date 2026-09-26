import { BCRYPT_COST, type SecretDeriveMethod } from "@appflare/schema";
import bcrypt from "bcryptjs";

/**
 * The value of a derived secret (a catalog secret's `derive`), computed from
 * its source's value the way the manager computes it at install: `bcrypt` is
 * a `$2b$` hash at `BCRYPT_COST` with a fresh random salt, from bcryptjs.
 * For tooling that installs an artifact outside the manager, such as the
 * catalog's install check, so a derived secret gets a real value.
 */
export function deriveSecretValue(method: SecretDeriveMethod, value: string): string {
  switch (method) {
    case "bcrypt":
      return bcrypt.hashSync(value, BCRYPT_COST);
  }
}
