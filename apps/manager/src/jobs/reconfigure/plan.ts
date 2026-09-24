import type { EnvBinding } from "@appflare/cf-api";
import type { CatalogSecret } from "@appflare/schema";
import { z } from "zod";
import { parseEmailRouteCfId } from "../../installs/email-routing";

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

/** One secret of an install, as the Settings section lists it. Values are never shown. */
export interface SecretSlot {
  name: string;
  /** The catalog's label, or the name for a secret the version no longer declares. */
  label: string;
  help?: string;
  /** A fresh value is generated in the form (the catalog's `generate: true`). */
  generate: boolean;
  /** The installed version declares it: it can be replaced, never removed. */
  declared: boolean;
  /** The Worker has it (Appflare recorded setting it). */
  present: boolean;
}

/**
 * The install's secrets: every one the installed version declares, in the
 * catalog's order, then those the Worker still has that the version no longer
 * declares (left from an earlier version). Only the latter are optional, so
 * only they can be removed.
 */
export function secretSlots(
  declared: readonly CatalogSecret[],
  recordedNames: readonly string[],
): SecretSlot[] {
  const recorded = new Set(recordedNames);
  const slots: SecretSlot[] = declared.map((s) => ({
    name: s.name,
    label: s.label,
    ...(s.help === undefined ? {} : { help: s.help }),
    generate: s.generate,
    declared: true,
    present: recorded.has(s.name),
  }));
  const names = new Set(declared.map((s) => s.name));
  for (const name of recordedNames) {
    if (names.has(name)) continue;
    names.add(name);
    slots.push({ name, label: name, generate: false, declared: false, present: true });
  }
  return slots;
}

/**
 * Why these secret changes cannot be made, one sentence each; empty when they
 * can. A secret may get a new value when the version declares it or the
 * Worker has it; it may be removed only when the Worker has it and the
 * version does not declare it; a value may not be empty.
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
  for (const name of new Set(changes.unset)) {
    const slot = byName.get(name);
    if (Object.hasOwn(changes.set, name)) {
      problems.push(`${name} cannot be replaced and removed at once.`);
    } else if (slot === undefined || !slot.present) {
      problems.push(`The app has no secret ${name} to remove.`);
    } else if (slot.declared) {
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
