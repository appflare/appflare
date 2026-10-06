import {
  boundToWorker,
  type CatalogManifest,
  type CatalogSecret,
  secretKey,
  secretTargets,
} from "@appflare/schema";
import type { SecretChanges } from "./reconfigure/plan";

/**
 * Secret keys and the names Workers read secrets by. Appflare knows a
 * catalog secret by its key (`secretKey`: the catalog's `key`, else its
 * `name`): the forms, the job inputs and the install's records (`resources`
 * rows of kind `secret`: `name` is the key, `binding` the name the Worker
 * reads) go by it. Two secrets of an app of several Workers may share a name
 * and go to different Workers, so what reaches one Worker is always
 * translated to the names that Worker reads, here and only here. For every
 * secret without a key of its own, and every install recorded before keys
 * existed, key and name are the same.
 */

type KeyedSecret = Pick<CatalogSecret, "name"> & { key?: string | undefined };

/** The name one Worker reads each of its secrets by, by key. */
export function secretNamesByKey(own: readonly KeyedSecret[]): Map<string, string> {
  return new Map(own.map((s) => [secretKey(s), s.name]));
}

/**
 * The values of `values` (by key) that go to a Worker whose catalog secrets
 * are `own` (its `workerManifest` view), by the name the Worker reads each
 * by. Keys of secrets the Worker does not get are left out.
 */
export function workerSecretValues(
  own: readonly KeyedSecret[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of secretNamesByKey(own)) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The part of a settings change's secret changes (by key) that goes to one
 * Worker, by the names it reads: the changes of the secrets the Worker gets
 * (`own`), and of `undeclared`, the recorded secrets the installed version no
 * longer declares (key to the name the Worker has it under), which belong to
 * the primary Worker.
 *
 * Removing an undeclared record never deletes a secret the Worker reads for
 * a declared one: when one of `own` has the same name (a secret the version
 * now knows under another key), only the record goes, and the Worker keeps
 * the value, unless that declared secret is removed too.
 */
export function workerSecretChanges(
  changes: SecretChanges,
  own: readonly KeyedSecret[],
  undeclared: ReadonlyMap<string, string> = new Map(),
): SecretChanges {
  const ownNames = secretNamesByKey(own);
  const names = new Map([...undeclared, ...ownNames]);
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(changes.set)) {
    const name = names.get(key);
    if (name !== undefined) set[name] = value;
  }
  const removed = new Set(changes.unset);
  const declaredNames = new Set(
    [...ownNames].filter(([key]) => !removed.has(key)).map(([, name]) => name),
  );
  const unset = changes.unset.flatMap((key) => {
    const name = names.get(key);
    if (name === undefined) return [];
    if (!ownNames.has(key) && declaredNames.has(name)) return [];
    return [name];
  });
  return { set, unset: [...new Set(unset)] };
}

/**
 * The recorded secrets of an install (`resources` rows of kind `secret`) the
 * catalog secrets `declared` do not name, by key, with the name the Worker
 * has each under (`binding`; the key itself for a row that has none).
 */
export function undeclaredSecretNames(
  declared: readonly KeyedSecret[],
  recorded: ReadonlyArray<{ name: string; binding: string | null }>,
): Map<string, string> {
  const keys = new Set(declared.map(secretKey));
  return new Map(
    recorded.filter((r) => !keys.has(r.name)).map((r) => [r.name, r.binding ?? r.name]),
  );
}

/** Where a secret goes: the Workers of its entry by name, the primary one as "" (the install's own). */
export interface SecretPlacement {
  key: string;
  /** The name its Workers read it by. */
  name: string;
  targets: string[];
}

/**
 * Every secret of a catalog manifest that reaches a Worker (seed-only ones
 * do not), by key, with the Workers it goes to. The primary Worker is `""`,
 * so a secret of a one-Worker app and one an app of several gives its
 * primary Worker compare equal across versions.
 */
export function secretPlacements(
  catalog: Pick<CatalogManifest, "secrets" | "install">,
): SecretPlacement[] {
  const primary = catalog.install.workers?.find((w) => w.primary)?.name;
  return boundToWorker(catalog.secrets).map((s) => {
    const targets = secretTargets(s, catalog).map((t) => (t === primary ? "" : t));
    return { key: secretKey(s), name: s.name, targets: targets.length === 0 ? [""] : targets };
  });
}

/**
 * The secrets a new version declares under a key the install has no record
 * of, whose value every Worker that gets it already has under the same name
 * from a recorded secret the version no longer declares (a secret given a
 * key of its own, or a new key): new key to the recorded key it takes over.
 * An update records the value under the new key instead of asking for it
 * again. `previous` is where the installed version put its secrets; a
 * recorded secret it does not declare counts as the primary Worker's.
 */
export function adoptedSecretKeys(
  next: Pick<CatalogManifest, "secrets" | "install">,
  previous: readonly SecretPlacement[] | null,
  recorded: ReadonlyArray<{ name: string; binding: string | null }>,
): Map<string, string> {
  const placements = secretPlacements(next);
  const nextKeys = new Set(placements.map((p) => p.key));
  const recordedKeys = new Set(recorded.map((r) => r.name));
  const adopted = new Map<string, string>();
  for (const p of placements) {
    if (recordedKeys.has(p.key)) continue;
    const from = recorded.find((r) => {
      if (nextKeys.has(r.name) || (r.binding ?? r.name) !== p.name) return false;
      const had = previous?.find((q) => q.key === r.name)?.targets ?? [""];
      return p.targets.every((t) => had.includes(t));
    });
    if (from !== undefined) adopted.set(p.key, from.name);
  }
  return adopted;
}
