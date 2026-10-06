/**
 * `requires` values that name something the manager must know how to do,
 * rather than something the Cloudflare account must have. A manager from
 * before the feature does not know the value, so it leaves the entry out of
 * its catalog (and refuses its artifact) instead of installing the app wrong;
 * a manager that knows it has nothing to check in the account.
 *
 * - `secret-keys`: a secret has a `key` of its own, so two secrets may give
 *   different Workers of the entry a value under one name. An older manager
 *   would store and set both under that name.
 * - `service-props`: a service binding carries `props`, which an older
 *   manager refuses to upload.
 * - `config-patch-values`: a config patch sets a var to text or adds a
 *   Workers AI binding, which an older manager's copy of the config patch
 *   rules refuses when it reads the artifact's catalog manifest.
 *
 * This module imports nothing: `catalog.ts` imports it, and the JSON Schema
 * export runs `catalog.ts` directly under Node's type stripping.
 */
export const MANAGER_FEATURE_REQUIREMENTS = [
  "secret-keys",
  "service-props",
  "config-patch-values",
] as const;
export type ManagerFeatureRequirement = (typeof MANAGER_FEATURE_REQUIREMENTS)[number];

/** The `requires` value an entry lists when a secret has a `key` that is not its name. */
export const SECRET_KEYS_REQUIREMENT = "secret-keys" satisfies ManagerFeatureRequirement;

/** The `requires` value an entry lists when a service binding carries `props`. */
export const SERVICE_PROPS_REQUIREMENT = "service-props" satisfies ManagerFeatureRequirement;

/** The `requires` value an entry lists when a config patch sets var text or adds `ai`. */
export const CONFIG_PATCH_VALUES_REQUIREMENT =
  "config-patch-values" satisfies ManagerFeatureRequirement;

/** Whether a `requires` value names a manager feature rather than an account capability. */
export function isManagerFeatureRequirement(value: string): value is ManagerFeatureRequirement {
  return (MANAGER_FEATURE_REQUIREMENTS as readonly string[]).includes(value);
}

/**
 * The `requires` values that ask something of the Cloudflare account: every
 * one but the manager features, which the manager reading them already has.
 */
export function accountRequirements<T extends string>(requires: readonly T[]): T[] {
  return requires.filter((r) => !isManagerFeatureRequirement(r));
}
