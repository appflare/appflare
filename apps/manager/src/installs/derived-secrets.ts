import {
  BCRYPT_COST,
  type CatalogSecret,
  type CatalogVar,
  isDerivedSecret,
  type SecretDeriveMethod,
  secretKey,
  vapidPublicKey,
} from "@appflare/schema";
import bcrypt from "bcryptjs";

/**
 * Derived secrets and vars (a catalog secret's or var's
 * `derive: { from, method }`): the manager computes them from their source
 * secret's value instead of asking for them, whenever the source gets a value
 * (an install, an update that asks for it, a settings change). The servers
 * that start those jobs add the derived values to the job's secrets and
 * stored settings, so the jobs set them like any other. Secret values are
 * never logged, returned, or stored outside the Workflow params; a derived
 * var (a public key) is ordinary settings. Secrets go by key (`secretKey`),
 * which `derive.from` names.
 */

/**
 * `method` applied to `value`. `bcrypt`: bcryptjs (the library Counterscale
 * itself checks the hash with) at {@link BCRYPT_COST} with a fresh random
 * salt, so each call gives a different hash that matches the same value. It
 * costs about 70 ms of CPU; a Worker on Workers Free ran it within its limit
 * (checked on 2026-09-26 in the development account). `vapid-public-key`:
 * WebCrypto imports the VAPID private key and gives its public point
 * (`vapidPublicKey`); it throws for a value that is not a VAPID private key,
 * which the servers refuse before they get here (`secretValueProblem`).
 */
export async function deriveSecretValue(
  method: SecretDeriveMethod,
  value: string,
): Promise<string> {
  switch (method) {
    case "bcrypt":
      // Synchronous: the async form only splits the same work across timers.
      return bcrypt.hashSync(value, BCRYPT_COST);
    case "vapid-public-key":
      return vapidPublicKey(value);
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
  const derivedKeys = new Set(derived.map(secretKey));
  for (const [key, value] of Object.entries(values)) {
    if (!derivedKeys.has(key)) out[key] = value;
  }
  for (const secret of derived) {
    const derive = secret.derive;
    const source = derive === undefined ? undefined : values[derive.from];
    if (derive === undefined || source === undefined || source.length === 0) continue;
    out[secretKey(secret)] = await deriveSecretValue(derive.method, source);
  }
  return out;
}

/**
 * The value of every derived var whose source secret has a value in
 * `secrets`, by var name; the others are left as they are stored.
 */
export async function derivedVarValues(
  declared: readonly Pick<CatalogVar, "name" | "derive">[],
  secrets: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of declared) {
    const derive = v.derive;
    const source = derive === undefined ? undefined : secrets[derive.from];
    if (derive === undefined || source === undefined || source.length === 0) continue;
    out[v.name] = await deriveSecretValue(derive.method, source);
  }
  return out;
}

/**
 * The sources of the derived vars an install has no stored value for (a
 * version that adds one): their secrets are asked for again, since a secret's
 * value is never read back, so the var can be computed from the new value.
 */
export function sourcesOfUnsetDerivedVars(
  declared: readonly Pick<CatalogVar, "name" | "derive">[],
  stored: Readonly<Record<string, string>>,
): string[] {
  const out = new Set<string>();
  for (const v of declared) {
    if (v.derive !== undefined && (stored[v.name] ?? "").length === 0) out.add(v.derive.from);
  }
  return [...out];
}

/**
 * The keys among `asked` the Worker already has: sources asked for again so
 * a derived value can be computed. Their current value cannot be read back,
 * so a form must not replace it with a generated one unasked.
 */
export function heldSecrets(
  asked: readonly Pick<CatalogSecret, "name" | "key">[],
  recordedKeys: readonly string[],
): string[] {
  const recorded = new Set(recordedKeys);
  return asked.map(secretKey).filter((key) => recorded.has(key));
}

/**
 * The secrets a set of `missing` ones asks the admin for: each derived secret
 * stands for its source (whose new value it is computed from), in the
 * catalog's order, each once. `sources` adds secrets asked for again for
 * another reason (the source of a derived var the install lacks).
 */
export function secretsToAskFor(
  declared: readonly CatalogSecret[],
  missing: readonly CatalogSecret[],
  sources: readonly string[] = [],
): CatalogSecret[] {
  const wanted = new Set<string>(sources);
  for (const secret of missing) wanted.add(secret.derive?.from ?? secretKey(secret));
  return declared.filter((s) => wanted.has(secretKey(s)) && !isDerivedSecret(s));
}

/**
 * The secrets a job sets for `missing` ones: those, plus the source of each
 * derived one (asked for again, so the source and its hash stay a pair), in
 * the catalog's order. `sources` adds secrets asked for again for another
 * reason, with every secret derived from them.
 */
export function secretsToSet(
  declared: readonly CatalogSecret[],
  missing: readonly CatalogSecret[],
  sources: readonly string[] = [],
): CatalogSecret[] {
  const wanted = new Set<string>(sources);
  for (const secret of missing) {
    wanted.add(secretKey(secret));
    if (secret.derive !== undefined) wanted.add(secret.derive.from);
  }
  return declared.filter(
    (s) => wanted.has(secretKey(s)) || (s.derive !== undefined && sources.includes(s.derive.from)),
  );
}
