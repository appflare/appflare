import {
  BCRYPT_COST,
  type CatalogSecret,
  isDerivedSecret,
  type SecretDeriveMethod,
} from "@appflare/schema";
import bcrypt from "bcryptjs";

/**
 * Derived secrets (a catalog secret's `derive: { from, method }`): the
 * manager computes them from their source secret's value instead of asking
 * for them, whenever the source gets a value (an install, an update that
 * asks for it, a settings change). The servers that start those jobs add the
 * derived values to the job's secrets, so the jobs set them like any other.
 * Values are never logged, returned, or stored outside the Workflow params.
 */

/**
 * `method` applied to `value`. `bcrypt`: bcryptjs (the library Counterscale
 * itself checks the hash with) at {@link BCRYPT_COST} with a fresh random
 * salt, so each call gives a different hash that matches the same value. It
 * costs about 70 ms of CPU; a Worker on Workers Free ran it within its limit
 * (checked on 2026-09-26 in the development account).
 */
export async function deriveSecretValue(
  method: SecretDeriveMethod,
  value: string,
): Promise<string> {
  switch (method) {
    case "bcrypt":
      // Synchronous: the async form only splits the same work across timers.
      return bcrypt.hashSync(value, BCRYPT_COST);
  }
}

/**
 * `values` with a value for every derived secret whose source has one. A
 * value given for a derived secret itself is replaced, never trusted: the
 * source decides it.
 */
export async function withDerivedSecrets(
  declared: readonly CatalogSecret[],
  values: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const derived = declared.filter(isDerivedSecret);
  const derivedNames = new Set(derived.map((s) => s.name));
  for (const [name, value] of Object.entries(values)) {
    if (!derivedNames.has(name)) out[name] = value;
  }
  for (const secret of derived) {
    const derive = secret.derive;
    const source = derive === undefined ? undefined : values[derive.from];
    if (derive === undefined || source === undefined || source.length === 0) continue;
    out[secret.name] = await deriveSecretValue(derive.method, source);
  }
  return out;
}

/**
 * The secrets a set of `missing` ones asks the admin for: each derived secret
 * stands for its source (whose new value it is computed from), in the
 * catalog's order, each once.
 */
export function secretsToAskFor(
  declared: readonly CatalogSecret[],
  missing: readonly CatalogSecret[],
): CatalogSecret[] {
  const wanted = new Set<string>();
  for (const secret of missing) wanted.add(secret.derive?.from ?? secret.name);
  return declared.filter((s) => wanted.has(s.name) && !isDerivedSecret(s));
}

/**
 * The secrets a job sets for `missing` ones: those, plus the source of each
 * derived one (asked for again, so the source and its hash stay a pair), in
 * the catalog's order.
 */
export function secretsToSet(
  declared: readonly CatalogSecret[],
  missing: readonly CatalogSecret[],
): CatalogSecret[] {
  const wanted = new Set<string>();
  for (const secret of missing) {
    wanted.add(secret.name);
    if (secret.derive !== undefined) wanted.add(secret.derive.from);
  }
  return declared.filter((s) => wanted.has(s.name));
}
