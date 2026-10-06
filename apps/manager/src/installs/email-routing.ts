import { artifactManifestSchema, type CatalogEmailRouting } from "@appflare/schema";
import { z } from "zod";
import {
  type PermissionGroup,
  permissionName,
  TOKEN_PERMISSION_GROUPS,
} from "../cloudflare/token-template";

/**
 * Email Routing for apps whose catalog manifest sets `install.emailRouting`:
 * which addresses an install routes to its Worker, how the install records
 * what it set up (resources of kind `email_route`), and the words the install
 * form, the install page and the uninstall dialog use. Client-safe: no server
 * imports.
 */

/** Longest address a routing rule matches (Cloudflare's matcher `value` limit). */
export const EMAIL_ROUTING_ADDRESS_MAX_LENGTH = 90;

/** Rules a domain may hold (Cloudflare's Email Routing limit). */
export const EMAIL_ROUTING_RULES_PER_DOMAIN = 200;

/** What an install routes to its Worker on one zone. */
export interface EmailRoutingPlan {
  zoneName: string;
  /** Full addresses, one routing rule each, in manifest order. */
  addresses: string[];
  catchAll: boolean;
}

/**
 * The addresses of `config` in the zone `zoneName`: a local part becomes
 * `<local>@<zone>`, a full address must be in the zone itself (a subdomain
 * would need its own Email Routing setup, which Appflare does not do).
 */
export function planEmailRouting(
  config: CatalogEmailRouting,
  zoneName: string,
): { ok: true; plan: EmailRoutingPlan } | { ok: false; error: string } {
  const zone = zoneName.toLowerCase();
  const addresses: string[] = [];
  for (const rule of config.rules ?? []) {
    const at = rule.indexOf("@");
    const address = at === -1 ? `${rule}@${zone}` : rule;
    if (at !== -1 && rule.slice(at + 1) !== zone) {
      return {
        ok: false,
        error: `The app wants mail for ${rule}, which is not an address at ${zone}. Choose the zone ${rule.slice(at + 1)} if it is in this account.`,
      };
    }
    if (address.length > EMAIL_ROUTING_ADDRESS_MAX_LENGTH) {
      return {
        ok: false,
        error: `${address} is longer than the ${EMAIL_ROUTING_ADDRESS_MAX_LENGTH} characters an Email Routing rule can match.`,
      };
    }
    if (!addresses.includes(address)) addresses.push(address);
  }
  return { ok: true, plan: { zoneName: zone, addresses, catchAll: config.catchAll === true } };
}

/** The action that delivers mail to a Worker. */
export function workerAction(workerName: string): { type: "worker"; value: string[] } {
  return { type: "worker", value: [workerName] };
}

/** The name Appflare gives a routing rule it creates. */
export function emailRuleName(workerName: string): string {
  return `${workerName} (installed by Appflare)`;
}

/** Whether a rule or catch-all delivers to exactly this Worker. */
export function deliversTo(
  actions: ReadonlyArray<{ type: string; value?: string[] | undefined }>,
  workerName: string,
): boolean {
  const [first] = actions;
  return first?.type === "worker" && first.value?.[0] === workerName;
}

/**
 * Whether a routing rule is one Appflare could have set up for `address`
 * (lowercase): on, matching that one address and nothing else, and
 * delivering to exactly this Worker. Only such a rule is taken as the
 * install's own; a rule that is off, or also matches on something else (a
 * sender), is someone else's even when it names the Worker.
 */
export function routesAddressTo(
  rule: {
    enabled?: boolean | undefined;
    matchers: ReadonlyArray<{
      type: string;
      field?: string | undefined;
      value?: string | undefined;
    }>;
    actions: ReadonlyArray<{ type: string; value?: string[] | undefined }>;
  },
  address: string,
  workerName: string,
): boolean {
  const [matcher, ...others] = rule.matchers;
  return (
    rule.enabled !== false &&
    others.length === 0 &&
    matcher?.type === "literal" &&
    matcher.field === "to" &&
    matcher.value?.toLowerCase() === address &&
    deliversTo(rule.actions, workerName)
  );
}

/** An action for people: "the Worker inbox", "forwarding to me@example.net", "drop". */
export function describeAction(
  actions: ReadonlyArray<{ type: string; value?: string[] | undefined }>,
): string {
  const [first] = actions;
  if (first === undefined) return "no action";
  const value = first.value?.[0];
  switch (first.type) {
    case "worker":
      return value === undefined ? "a Worker" : `the Worker ${value}`;
    case "forward":
      return value === undefined ? "forwarding" : `forwarding to ${value}`;
    case "drop":
      return "drop";
    default:
      return first.type;
  }
}

/** Cloudflare's own Email Routing mail servers (`route1.mx.cloudflare.net`, ...). */
export function isCloudflareMx(content: string): boolean {
  return /(^|\.)mx\.cloudflare\.net\.?$/i.test(content.trim());
}

/**
 * A zone's catch-all as it was before an install pointed it at its Worker,
 * so the uninstall can put it back. Its matcher is always `{ type: "all" }`.
 */
export const savedCatchAllSchema = z.object({
  enabled: z.boolean(),
  actions: z
    .array(
      z.object({
        type: z.string().min(1).max(32),
        value: z.array(z.string().max(EMAIL_ROUTING_ADDRESS_MAX_LENGTH)).max(1).optional(),
      }),
    )
    .max(1),
});
export type SavedCatchAll = z.infer<typeof savedCatchAllSchema>;

/** The catch-all Cloudflare starts a zone with, and the fallback when none was saved. */
export const DEFAULT_CATCH_ALL: SavedCatchAll = { enabled: false, actions: [{ type: "drop" }] };

/** The part of a catch-all an uninstall restores, from what Cloudflare answered. */
export function saveCatchAll(catchAll: {
  enabled: boolean;
  actions: ReadonlyArray<{ type: string; value?: string[] | undefined }>;
}): SavedCatchAll {
  const [first] = catchAll.actions;
  const parsed = savedCatchAllSchema.safeParse({
    enabled: catchAll.enabled,
    actions:
      first === undefined
        ? []
        : [
            {
              type: first.type,
              ...(first.value === undefined ? {} : { value: first.value.slice(0, 1) }),
            },
          ],
  });
  return parsed.success ? parsed.data : DEFAULT_CATCH_ALL;
}

/** "drop, off" / "forwarding to me@example.net, on", for logs and the uninstall dialog. */
export function describeCatchAll(saved: SavedCatchAll): string {
  return `${describeAction(saved.actions)}, ${saved.enabled ? "on" : "off"}`;
}

/**
 * What one `email_route` resource stands for, stored in its `cf_id`:
 * `rule:<zone id>:<rule id>` (a routing rule; the resource's name is the
 * address), `catch_all:<zone id>[:<saved>]` (the zone's catch-all points at
 * the Worker; the name is `*@<zone>`; `<saved>` is the catch-all before the
 * install as base64url JSON), `routing:<zone id>` (Appflare turned Email
 * Routing on for the zone; the name is the zone).
 */
export type EmailRouteTarget =
  | { kind: "rule"; zoneId: string; ruleId: string }
  | { kind: "catch_all"; zoneId: string; previous: SavedCatchAll | null }
  | { kind: "routing"; zoneId: string };

const idPart = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const savedPart = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function decodeSaved(encoded: string): SavedCatchAll | null {
  try {
    const parsed = savedCatchAllSchema.safeParse(JSON.parse(fromBase64Url(encoded)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function emailRouteCfId(target: EmailRouteTarget): string {
  switch (target.kind) {
    case "rule":
      return `rule:${target.zoneId}:${target.ruleId}`;
    case "catch_all":
      return target.previous === null
        ? `catch_all:${target.zoneId}`
        : `catch_all:${target.zoneId}:${toBase64Url(JSON.stringify(target.previous))}`;
    case "routing":
      return `routing:${target.zoneId}`;
  }
}

/** The target a recorded `cf_id` stands for; null when it is not one Appflare writes. */
export function parseEmailRouteCfId(cfId: string | null): EmailRouteTarget | null {
  if (cfId === null) return null;
  const [kind, zoneId, extra, ...rest] = cfId.split(":");
  if (rest.length > 0 || zoneId === undefined || !idPart.safeParse(zoneId).success) return null;
  if (kind === "rule") {
    return extra !== undefined && idPart.safeParse(extra).success
      ? { kind, zoneId, ruleId: extra }
      : null;
  }
  if (kind === "catch_all") {
    if (extra === undefined) return { kind, zoneId, previous: null };
    if (!savedPart.safeParse(extra).success) return null;
    const previous = decodeSaved(extra);
    return previous === null ? null : { kind, zoneId, previous };
  }
  if (kind === "routing" && extra === undefined) return { kind, zoneId };
  return null;
}

/** The resource name Appflare records for a target. */
export function emailRouteName(
  target: EmailRouteTarget["kind"],
  args: { zoneName: string; address?: string },
): string {
  if (target === "rule") return args.address ?? "";
  if (target === "catch_all") return `*@${args.zoneName}`;
  return args.zoneName;
}

/** The key part of the resource id, so a retried record step never inserts twice. */
export function emailRouteKey(target: EmailRouteTarget["kind"], name: string): string {
  return `${target}:${name}`;
}

/** An `email_route` resource of an install, for the install page and the uninstall dialog. */
export interface EmailRouteView {
  /** The `resources` row id. */
  id: string;
  kind: EmailRouteTarget["kind"];
  /** The address, `*@<zone>`, or the zone. */
  name: string;
  /** What it is, in a sentence fragment. */
  label: string;
  /** What an uninstall does with it. */
  onUninstall: string;
}

/** The recorded rows as views; rows whose `cf_id` Appflare did not write are left out. */
export function emailRouteViews(
  rows: ReadonlyArray<{ id: string; name: string; cfId: string | null }>,
): EmailRouteView[] {
  const views: EmailRouteView[] = [];
  for (const row of rows) {
    const target = parseEmailRouteCfId(row.cfId);
    if (target === null) continue;
    const zone = target.kind === "catch_all" ? row.name.replace(/^\*@/, "") : row.name;
    switch (target.kind) {
      case "rule":
        views.push({
          id: row.id,
          kind: "rule",
          name: row.name,
          label: `Mail to ${row.name} goes to the app`,
          onUninstall: `Deletes the routing rule for ${row.name}.`,
        });
        break;
      case "catch_all":
        views.push({
          id: row.id,
          kind: "catch_all",
          name: row.name,
          label: `Mail to every other address at ${zone} goes to the app (catch-all)`,
          onUninstall: `Puts the catch-all of ${zone} back as it was before the install (${describeCatchAll(target.previous ?? DEFAULT_CATCH_ALL)}), if it still points at the app.`,
        });
        break;
      case "routing":
        views.push({
          id: row.id,
          kind: "routing",
          name: row.name,
          label: `Appflare turned Email Routing on for ${row.name}`,
          onUninstall: `Turns Email Routing off for ${row.name} (removing its MX records) if no other routing rule or catch-all is left there; otherwise, for example while another install still uses it, leaves it on.`,
        });
        break;
    }
  }
  return views;
}

/** The permission groups Email Routing uses, by template key, from the token template. */
function group(key: string): PermissionGroup {
  const found = TOKEN_PERMISSION_GROUPS.find((g) => g.key === key);
  if (found === undefined) throw new Error(`no token permission group ${key}`);
  return found;
}

/**
 * The permissions each Email Routing call needs, by the dashboard's names.
 * Zone: Read and DNS: Edit are the custom domains groups; the others are the
 * "Email Routing" group.
 */
export const EMAIL_ROUTING_PERMISSION = {
  zone: permissionName(group("zone")),
  dns: permissionName(group("dns")),
  zoneSettings: permissionName(group("zone_settings")),
  rules: permissionName(group("email_routing_rule")),
  addresses: permissionName(group("email_routing_address")),
} as const;

/** Every permission an email app's install needs, in the order the token form lists them. */
export const EMAIL_ROUTING_PERMISSIONS: readonly string[] = [
  EMAIL_ROUTING_PERMISSION.zone,
  EMAIL_ROUTING_PERMISSION.dns,
  EMAIL_ROUTING_PERMISSION.zoneSettings,
  EMAIL_ROUTING_PERMISSION.rules,
];

/** Whether an artifact's Worker can send email (it has a `send_email` binding). */
export function sendsEmail(bindings: ReadonlyArray<{ type: string }>): boolean {
  return bindings.some((b) => b.type === "send_email");
}

/**
 * The note an installed app with a `send_email` binding shows under Next
 * steps. Sending is the account's own setup: Appflare changes nothing for it.
 */
export const SEND_EMAIL_NOTE =
  "**Sending email.** This app sends email through Cloudflare. Cloudflare delivers to the " +
  "account's verified destination addresses for free on every plan: add and verify them in the " +
  "Cloudflare dashboard under Email Service, Email Routing, Destination addresses. Sending to any " +
  "other address needs Email Sending, which requires the Workers Paid plan and a sending domain " +
  "set up in Email Service.";

/** The `install.emailRouting` of a stored artifact manifest; null when it has none or cannot be read. */
export function emailRoutingOfManifest(manifestJson: string | null): CatalogEmailRouting | null {
  if (manifestJson === null) return null;
  try {
    const parsed = artifactManifestSchema.safeParse(JSON.parse(manifestJson));
    return parsed.success ? (parsed.data.catalog.install.emailRouting ?? null) : null;
  } catch {
    return null;
  }
}

/** The addresses a version routes to the app, as full addresses when the zone is known, sorted. */
function addressesOf(
  config: CatalogEmailRouting | null | undefined,
  zone: string | null,
): string[] {
  if (config == null) return [];
  const all = (config.rules ?? []).map((rule) =>
    zone === null || rule.includes("@") ? rule : `${rule}@${zone}`,
  );
  return [...new Set(all)].sort();
}

/**
 * The note when the version an update or rollback moves to receives
 * different email than the one serving; null when nothing would change.
 * The job changes Email Routing to match once that version serves, on the
 * zone the app receives email for (see jobs/update/email-routing.ts), so the
 * update and rollback dialogs show it and an update without an admin waits
 * for one. `zoneName`: that zone; null when Appflare has none on record
 * (then nothing can be removed, and nothing is set up until the admin
 * chooses one); undefined when not looked up (the job log, which says
 * where separately).
 */
export function emailRoutingChangeNote(
  serving: CatalogEmailRouting | null | undefined,
  next: CatalogEmailRouting | null | undefined,
  version: string,
  zoneName?: string | null,
): string | null {
  const zone = zoneName ?? null;
  const from = addressesOf(serving, zone);
  const to = addressesOf(next, zone);
  const added = to.filter((a) => !from.includes(a));
  const removed = from.filter((a) => !to.includes(a));
  const takesCatchAll = next?.catchAll === true && serving?.catchAll !== true;
  const givesCatchAll = serving?.catchAll === true && next?.catchAll !== true;
  if (added.length === 0 && removed.length === 0 && !takesCatchAll && !givesCatchAll) return null;
  if (zoneName === null) {
    // No routes on record: nothing to remove, and nowhere to set any up.
    if (next == null) return null;
    return `Version ${version} receives email${to.length > 0 ? ` (${to.join(", ")})` : ""}, and Appflare has no domain on record for the app's email: choose one in the app's settings (Email) once the version serves.`;
  }
  const where = zone ?? "the app's domain";
  const parts: string[] = [];
  if (added.length > 0) parts.push(`mail to ${added.join(", ")} starts reaching the app`);
  if (removed.length > 0) parts.push(`mail to ${removed.join(", ")} stops reaching the app`);
  if (takesCatchAll) {
    parts.push(`every other address at ${where} starts reaching the app (the catch-all)`);
  }
  if (givesCatchAll) parts.push(`the catch-all of ${where} is put back as it was`);
  const after =
    next == null
      ? " Email Routing is turned off again if Appflare turned it on and nothing else uses it."
      : added.length > 0 || takesCatchAll
        ? ` If Email Routing is off for ${where}, it is turned on, and Cloudflare adds its MX, SPF and DKIM records.`
        : "";
  return `Version ${version} ${next == null ? "receives no email" : "changes the email the app receives"}: ${parts.join("; ")}. Appflare makes the change once the version serves, and never touches a routing rule or catch-all it did not set up.${after}`;
}
