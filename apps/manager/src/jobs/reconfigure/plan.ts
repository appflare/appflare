import type { EnvBinding } from "@appflare/cf-api";
import {
  type CatalogHyperdrive,
  type CatalogSecret,
  connectionStringProblems,
  hyperdriveFieldLabel,
  isOptionalSecret,
  MAX_CONNECTION_STRING_LENGTH,
} from "@appflare/schema";
import { z } from "zod";
import { parseEmailRouteCfId } from "../../installs/email-routing";
import { resourceName } from "../install/bindings";

/**
 * The pure decisions of a settings change (job kind `reconfigure`): which
 * secrets an install has and which of them may be removed, whether a change
 * to them is allowed, the settings the install stores next, and the merge
 * patch that sets and removes secrets on the uploaded version. Shared by the
 * server function that starts the job, the job itself, and the app page.
 */

/** Longest secret or setting name accepted. */
export const MAX_NAME_LENGTH = 200;
/** Values are bounded so a pasted blob cannot bloat the Workflow payload. */
export const MAX_VALUE_LENGTH = 4096;

const nameSchema = z.string().min(1).max(MAX_NAME_LENGTH);

/**
 * Secret changes: new values by name (never logged; they live only in the
 * Workflow params) and names to remove.
 */
export const secretChangesSchema = z.object({
  set: z.record(nameSchema, z.string().max(MAX_VALUE_LENGTH)).default({}),
  unset: z.array(nameSchema).max(64).default([]),
});
export type SecretChanges = z.infer<typeof secretChangesSchema>;

/**
 * New connection strings by Hyperdrive binding: each replaces that
 * database's Hyperdrive configuration. Credentials, handled like secret
 * values: never logged, never stored outside the Workflow params.
 */
export const connectionChangesSchema = z.record(
  nameSchema,
  z.string().max(MAX_CONNECTION_STRING_LENGTH),
);

/** One secret of an install, as the Settings section lists it. Values are never shown. */
export interface SecretSlot {
  name: string;
  /** The catalog's label, or the name for a secret the version no longer declares. */
  label: string;
  help?: string;
  /** A fresh value is generated in the form (the catalog's `generate: true`). */
  generate: boolean;
  /** The installed version declares it. */
  declared: boolean;
  /**
   * The app works without it: the version declares it `optional: true`, or
   * does not declare it at all. Only such a secret can be removed; one the
   * version needs can be replaced, never removed.
   */
  optional: boolean;
  /** The Worker has it (Appflare recorded setting it). */
  present: boolean;
  /**
   * For a derived secret (the catalog's `derive`): the secret it is computed
   * from. It is never entered: a new value of its source replaces it too.
   */
  derivedFrom?: string;
  /** For a source of derived secrets: their names, which a new value of it replaces too. */
  derives?: string[];
}

/**
 * The install's secrets: every one the installed version declares, in the
 * catalog's order, then those the Worker still has that the version no longer
 * declares (left from an earlier version). The latter, and those the version
 * declares optional, can be removed.
 */
export function secretSlots(
  declared: readonly CatalogSecret[],
  recordedNames: readonly string[],
): SecretSlot[] {
  const recorded = new Set(recordedNames);
  const slots: SecretSlot[] = declared.map((s) => {
    const derives = declared.filter((d) => d.derive?.from === s.name).map((d) => d.name);
    return {
      name: s.name,
      label: s.label,
      ...(s.help === undefined ? {} : { help: s.help }),
      generate: s.generate,
      declared: true,
      optional: isOptionalSecret(s),
      present: recorded.has(s.name),
      ...(s.derive === undefined ? {} : { derivedFrom: s.derive.from }),
      ...(derives.length > 0 ? { derives } : {}),
    };
  });
  const names = new Set(declared.map((s) => s.name));
  for (const name of recordedNames) {
    if (names.has(name)) continue;
    names.add(name);
    slots.push({
      name,
      label: name,
      generate: false,
      declared: false,
      optional: true,
      present: true,
    });
  }
  return slots;
}

/**
 * One database an install reaches through Hyperdrive, as the Settings
 * section lists it: the installed version's declaration, and the Hyperdrive
 * configuration recorded for it.
 */
export interface DatabaseSlot extends CatalogHyperdrive {
  /** The field label (`hyperdriveFieldLabel`). */
  fieldLabel: string;
  /** The recorded configuration's name; null when none is recorded (it cannot be replaced). */
  configName: string | null;
}

/**
 * The databases of an install: one per Hyperdrive binding the installed
 * version declares, with the configuration recorded for it. The connection
 * string itself is never stored, so it is never shown; it can only be replaced.
 */
export function databaseSlots(
  declared: readonly CatalogHyperdrive[],
  recorded: ReadonlyArray<{ binding: string | null; name: string }>,
): DatabaseSlot[] {
  return declared.map((decl) => ({
    ...decl,
    fieldLabel: hyperdriveFieldLabel(decl),
    configName: recorded.find((r) => r.binding === decl.binding)?.name ?? null,
  }));
}

/**
 * Why the connection strings entered in a settings change cannot be used,
 * one sentence each: each must be for a database the install has a
 * configuration of, and be a valid string for its protocol. Never repeats
 * any part of a string.
 */
export function connectionChangeProblems(
  entered: Readonly<Record<string, string>>,
  slots: readonly DatabaseSlot[],
): string[] {
  const problems = connectionStringProblems(slots, entered, { required: false });
  for (const binding of Object.keys(entered)) {
    const slot = slots.find((s) => s.binding === binding);
    if (slot !== undefined && slot.configName === null) {
      problems.push(
        `Appflare has no record of a Hyperdrive configuration for ${slot.fieldLabel}; reinstall the app to connect it.`,
      );
    }
  }
  return problems;
}

/**
 * The name of the Hyperdrive configuration a settings change creates to
 * replace one: the name the install gives the binding's resource
 * (`<workerName>-<binding>`, from the install's recorded Worker name), then
 * `-r` and the end of the job's id. Built from the install's own naming, never
 * by trimming the current configuration's name, so a replacement of a
 * replacement stays the same length and an upstream name that happens to end
 * like a suffix is never cut.
 */
export function replacementConfigName(workerName: string, binding: string, jobId: string): string {
  return `${resourceName(workerName, binding)}-r${jobId.slice(-8).toLowerCase()}`;
}

/**
 * Why the secrets an admin entered cannot be taken as they are, one sentence
 * each: a derived secret is never entered, only its source. Checked on the
 * form's values before the derived ones are computed (`withDerivedSecrets`).
 */
export function enteredSecretProblems(
  set: Readonly<Record<string, string>>,
  slots: readonly SecretSlot[],
): string[] {
  const byName = new Map(slots.map((s) => [s.name, s]));
  return Object.keys(set).flatMap((name) => {
    const from = byName.get(name)?.derivedFrom;
    return from === undefined
      ? []
      : [`${name} is computed from ${from}; give ${from} a new value instead.`];
  });
}

/**
 * Why these secret changes cannot be made, one sentence each; empty when they
 * can. A secret may get a new value when the version declares it or the
 * Worker has it; it may be removed only when the Worker has it and the
 * version does not need it (declares it optional, or not at all); a value may
 * not be empty. A derived secret and its source change together: each new
 * value of a source comes with a new value of every secret derived from it,
 * and a derived secret gets one only with its source; neither is removed on
 * its own.
 */
export function secretChangeProblems(
  changes: SecretChanges,
  slots: readonly SecretSlot[],
  opts: { canRemove: boolean } = { canRemove: true },
): string[] {
  const byName = new Map(slots.map((s) => [s.name, s]));
  const problems: string[] = [];
  for (const [name, value] of Object.entries(changes.set)) {
    const slot = byName.get(name);
    if (slot === undefined) {
      problems.push(`${name} is not a secret of this app.`);
    } else if (value.length === 0) {
      problems.push(`Enter a new value for ${slot.label} (${name}), or leave it unchanged.`);
    }
  }
  for (const slot of slots) {
    const from = slot.derivedFrom;
    if (from === undefined) continue;
    const setsDerived = Object.hasOwn(changes.set, slot.name);
    const setsSource = Object.hasOwn(changes.set, from);
    if (setsDerived && !setsSource) {
      problems.push(`${slot.name} is computed from ${from}; give ${from} a new value instead.`);
    } else if (setsSource && !setsDerived) {
      problems.push(`${slot.name} is computed from ${from}, so it must change with it.`);
    }
  }
  for (const name of new Set(changes.unset)) {
    const slot = byName.get(name);
    if (Object.hasOwn(changes.set, name)) {
      problems.push(`${name} cannot be replaced and removed at once.`);
    } else if (slot === undefined || !slot.present) {
      problems.push(`The app has no secret ${name} to remove.`);
    } else if (!slot.optional) {
      problems.push(
        `${slot.label} (${name}) is required by the installed version; it can be replaced, not removed.`,
      );
    } else if (!opts.canRemove) {
      problems.push(
        `${name} cannot be removed here: the app's own installer sets its secrets on its Workers.`,
      );
    }
  }
  return problems;
}

/**
 * The `env` of a version merge patch (`PATCH .../versions/latest`) that
 * applies the changes: a `secret_text` binding per new value, `null` per
 * removed name (verified live: a `null` for a name the version lacks is
 * accepted and changes nothing, so a repeated patch converges).
 */
export function secretEnvPatch(changes: SecretChanges): Record<string, EnvBinding | null> {
  const env: Record<string, EnvBinding | null> = {};
  for (const [name, text] of Object.entries(changes.set)) {
    env[name] = { type: "secret_text", text };
  }
  for (const name of changes.unset) env[name] = null;
  return env;
}

/** Whether the changes touch any secret. */
export function changesSecrets(changes: SecretChanges): boolean {
  return Object.keys(changes.set).length > 0 || changes.unset.length > 0;
}

/**
 * The `workers/message` annotation of the version that carries a job's
 * secret changes. The job finds a version it already made by it, so a
 * repeated step reuses that version instead of patching again.
 */
export function secretVersionMessage(jobId: string): string {
  return `Appflare: settings change ${jobId}`;
}

/** The annotation of the version that put the serving secrets back after a failed change. */
export function secretsUndoneMessage(jobId: string): string {
  return `Appflare: settings change ${jobId} undone`;
}

/** `installs.config_json` as a map; anything unreadable counts as no settings. */
export function parseStoredVars(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** `installs.config_json` for a map of settings: null when there are none. */
export function storedVarsJson(vars: Readonly<Record<string, string>>): string | null {
  const names = Object.keys(vars).sort();
  if (names.length === 0) return null;
  return JSON.stringify(Object.fromEntries(names.map((n) => [n, vars[n]])));
}

/**
 * The settings an install stores after a change: `entered` for the
 * version's own settings (only those that differ from their default, as the
 * install form sends them; an empty value follows the default), and every
 * other stored value kept as it was, since a later version may read it again.
 */
export function nextStoredVars(
  stored: Readonly<Record<string, string>>,
  fieldNames: readonly string[],
  entered: Readonly<Record<string, string>>,
): Record<string, string> {
  const fields = new Set(fieldNames);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored)) {
    if (!fields.has(name)) out[name] = value;
  }
  for (const name of fieldNames) {
    const value = (entered[name] ?? "").trim();
    if (value.length > 0) out[name] = value;
  }
  return out;
}

/** A zone an install has Email Routing records on. */
export interface EmailZone {
  zoneId: string;
  zoneName: string;
}

/**
 * The zones of an install's recorded `email_route` resources (each record
 * names its zone). `current` is the zone the newest record belongs to: the
 * job that recorded it last (an install, or a move that set the new zone up)
 * is the newest that succeeded that far, so it is where the app receives
 * email. `leftover` lists older zones whose records remain, which only a
 * move that stopped before removing them leaves behind. Ties in `createdAt`
 * go to the later record in `routes` (pass them in insertion order). A
 * zone's name comes from a record's name: the zone itself, `*@<zone>`, or an
 * address at the zone.
 */
export function emailZones(
  routes: ReadonlyArray<{ name: string; cfId: string | null; createdAt: number }>,
): { current: EmailZone | null; leftover: EmailZone[] } {
  const parsed = routes
    .map((route, index) => ({ route, index, target: parseEmailRouteCfId(route.cfId) }))
    .filter((r) => r.target !== null)
    .sort((a, b) => b.route.createdAt - a.route.createdAt || b.index - a.index);
  const zones: EmailZone[] = [];
  for (const { route, target } of parsed) {
    if (target === null || zones.some((z) => z.zoneId === target.zoneId)) continue;
    const at = route.name.lastIndexOf("@");
    zones.push({
      zoneId: target.zoneId,
      zoneName: at === -1 ? route.name : route.name.slice(at + 1),
    });
  }
  const [current = null, ...leftover] = zones;
  return { current, leftover };
}

/** The zone an `email_route` record belongs to; null for a record Appflare did not write. */
export function emailRouteZoneId(cfId: string | null): string | null {
  return parseEmailRouteCfId(cfId)?.zoneId ?? null;
}

/** Names whose stored value differs between two settings maps, sorted. */
export function changedVarNames(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}
