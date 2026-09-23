import {
  CloudflareApiError,
  type CloudflareClient,
  type EmailRoutingCatchAll,
  type EmailRoutingRule,
  type Zone,
} from "@appflare/cf-api";
import type { ArtifactManifest, CatalogEmailRouting } from "@appflare/schema";
import { isPermissionError, listAccountZones, unlessForbidden } from "./custom-domains.server";
import {
  DEFAULT_CATCH_ALL,
  deliversTo,
  describeAction,
  EMAIL_ROUTING_PERMISSION,
  EMAIL_ROUTING_RULES_PER_DOMAIN,
  isCloudflareMx,
  planEmailRouting,
  type SavedCatchAll,
  saveCatchAll,
  sendsEmail,
} from "./email-routing";

/**
 * Email Routing against the Cloudflare API: what a zone looks like before an
 * email app is installed there (shared by the install form's preview and the
 * install job's check), the zones the form offers, and undoing what an
 * install set up (the uninstall job). Reads the token lacks permission for
 * are reported as missing permissions by the dashboard's names, never as
 * failures, so the form can say what to add.
 */

export class EmailRoutingError extends Error {
  override name = "EmailRoutingError";
}

/** What the zone's catch-all does today, as far as the install is concerned. */
export type CatchAllState =
  /** Off, or on with drop: the install may point it at the app. */
  | "free"
  /** Already delivers to this Worker (an earlier attempt of the same install). */
  | "ours"
  /** Delivers somewhere else; the install refuses to replace it. */
  | "taken";

/** One address the install routes to the Worker. */
export interface InspectedAddress {
  address: string;
  /** A rule that already delivers this address to the Worker (an earlier attempt), else null. */
  existingRuleId: string | null;
}

/**
 * A zone as an email app's install would find it. Plain data (it crosses a
 * job unit's RPC call and a Workflow step result).
 */
export interface EmailRoutingInspection {
  zoneId: string;
  /** Null when the zone could not be read. */
  zoneName: string | null;
  /** Null when the settings could not be read. */
  routing: { enabled: boolean; status: string | null } | null;
  addresses: InspectedAddress[];
  /** The app asks for the zone's catch-all. */
  wantsCatchAll: boolean;
  /** Null when the app does not ask for the catch-all (or it could not be read). */
  catchAll: {
    state: CatchAllState;
    action: string;
    /** The catch-all as it is now, which the uninstall puts back. */
    previous: SavedCatchAll;
  } | null;
  /** Mail servers of another provider at the zone apex, when routing is off. */
  foreignMx: string[];
  /** Why the install cannot go ahead on this zone; empty when it can. */
  problems: string[];
  /** Worth knowing, but no reason to stop. */
  warnings: string[];
  /** Permissions the token lacks for what the install must do, by the dashboard's names. */
  missing: string[];
}

function addMissing(list: string[], permission: string): void {
  if (!list.includes(permission)) list.push(permission);
}

function isGone(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** The literal address a rule matches, lowercased; null for anything else. */
function literalAddress(rule: EmailRoutingRule): string | null {
  const literal = rule.matchers.find((m) => m.type === "literal" && m.field !== "from");
  return literal?.value?.toLowerCase() ?? null;
}

/** Whether a catch-all hands mail to something other than drop. */
export function catchAllInUse(catchAll: EmailRoutingCatchAll): boolean {
  return catchAll.enabled && (catchAll.actions[0]?.type ?? "drop") !== "drop";
}

/** Rules other than the catch-all (which some answers list among the rules). */
function regularRules(rules: EmailRoutingRule[]): EmailRoutingRule[] {
  return rules.filter((r) => !r.matchers.some((m) => m.type === "all"));
}

/**
 * Reads what installing `config` for Worker `workerName` would change on
 * zone `zoneId`, and why it may not: the zone belongs to another account, is
 * not active, or does not use Cloudflare DNS; an address already has a rule
 * that delivers elsewhere; the catch-all already delivers elsewhere; routing
 * is off and the zone's mail goes to another provider (turning routing on
 * would replace those MX records); or the rule limit would be passed.
 *
 * Calls: the zone, the routing settings, then (routing off) the apex DNS
 * records, (addresses) every page of rules, (catch-all) the catch-all: 3 to
 * about 8 requests.
 */
export async function inspectEmailRouting(
  api: CloudflareClient,
  request: { zoneId: string; config: CatalogEmailRouting; workerName: string },
): Promise<EmailRoutingInspection> {
  const result: EmailRoutingInspection = {
    zoneId: request.zoneId,
    zoneName: null,
    routing: null,
    addresses: [],
    wantsCatchAll: request.config.catchAll === true,
    catchAll: null,
    foreignMx: [],
    problems: [],
    warnings: [],
    missing: [],
  };

  let zone: Zone;
  try {
    zone = await api.zones.getZone(request.zoneId);
  } catch (error) {
    if (isPermissionError(error) || isGone(error)) {
      addMissing(result.missing, EMAIL_ROUTING_PERMISSION.zone);
      result.problems.push("The Cloudflare token cannot see that zone.");
      return result;
    }
    throw error;
  }
  result.zoneName = zone.name;
  if (zone.account?.id !== api.accountId) {
    result.problems.push(
      `${zone.name} belongs to another Cloudflare account, not the one Appflare runs in.`,
    );
    return result;
  }
  if (zone.status !== "active" || zone.paused === true) {
    result.problems.push(
      `${zone.name} is not active on Cloudflare yet (${zone.status}), so it cannot receive email.`,
    );
  }
  if (zone.type !== undefined && zone.type !== "full") {
    result.problems.push(
      `${zone.name} does not use Cloudflare DNS (${zone.type} setup); Email Routing needs Cloudflare as the zone's DNS provider.`,
    );
  }

  const planned = planEmailRouting(request.config, zone.name);
  if (!planned.ok) {
    result.problems.push(planned.error);
    return result;
  }
  const { plan } = planned;

  const settings = await unlessForbidden(() => api.emailRouting.getSettings(zone.id));
  if (settings === null) {
    addMissing(result.missing, EMAIL_ROUTING_PERMISSION.zoneSettings);
  } else {
    result.routing = { enabled: settings.enabled, status: settings.status ?? null };
    if (settings.enabled && settings.status !== undefined && settings.status !== "ready") {
      result.warnings.push(
        `Email Routing on ${zone.name} reports "${settings.status}": its DNS records are not as Cloudflare expects, so mail may not arrive until they are fixed in the dashboard (Email Service, Email Routing, Settings).`,
      );
    }
    if (!settings.enabled) {
      const records = await unlessForbidden(() =>
        api.zones.listDnsRecords(zone.id, { name: zone.name }),
      );
      if (records === null) {
        addMissing(result.missing, EMAIL_ROUTING_PERMISSION.dns);
      } else {
        result.foreignMx = records
          .filter((r) => r.type === "MX" && !isCloudflareMx(r.content ?? ""))
          .map((r) => r.content ?? "")
          .filter((c) => c.length > 0);
        if (result.foreignMx.length > 0) {
          result.problems.push(
            `${zone.name} receives its mail elsewhere (MX ${result.foreignMx.join(", ")}). Turning Email Routing on would replace those records, so Appflare leaves that choice to you: turn Email Routing on for ${zone.name} in the Cloudflare dashboard if you mean to, or choose another zone.`,
          );
        }
      }
    }
  }

  if (plan.addresses.length > 0) {
    const rules = await unlessForbidden(() => api.emailRouting.listRules(zone.id));
    if (rules === null) {
      addMissing(result.missing, EMAIL_ROUTING_PERMISSION.rules);
      result.addresses = plan.addresses.map((address) => ({ address, existingRuleId: null }));
    } else {
      const regular = regularRules(rules);
      for (const address of plan.addresses) {
        const existing = regular.find((r) => literalAddress(r) === address);
        if (existing === undefined) {
          result.addresses.push({ address, existingRuleId: null });
        } else if (deliversTo(existing.actions, request.workerName)) {
          result.addresses.push({ address, existingRuleId: existing.id });
        } else {
          result.addresses.push({ address, existingRuleId: null });
          result.problems.push(
            `${address} already has a routing rule (${describeAction(existing.actions)}). Appflare does not replace it; delete the rule in the Cloudflare dashboard or choose another zone.`,
          );
        }
      }
      const toCreate = result.addresses.filter((a) => a.existingRuleId === null).length;
      if (regular.length + toCreate > EMAIL_ROUTING_RULES_PER_DOMAIN) {
        result.problems.push(
          `${zone.name} has ${regular.length} routing rules; ${toCreate} more would pass Cloudflare's limit of ${EMAIL_ROUTING_RULES_PER_DOMAIN}.`,
        );
      }
    }
  }

  if (plan.catchAll) {
    const catchAll = await unlessForbidden(() => api.emailRouting.getCatchAll(zone.id));
    if (catchAll === null) {
      addMissing(result.missing, EMAIL_ROUTING_PERMISSION.rules);
    } else {
      const action = describeAction(catchAll.actions);
      let state: CatchAllState = "free";
      if (catchAll.enabled && deliversTo(catchAll.actions, request.workerName)) state = "ours";
      else if (catchAllInUse(catchAll)) state = "taken";
      result.catchAll = { state, action, previous: saveCatchAll(catchAll) };
      if (state === "taken") {
        result.problems.push(
          `The catch-all of ${zone.name} already sends mail to ${action}. Appflare does not replace it; turn the catch-all off in the Cloudflare dashboard or choose another zone.`,
        );
      }
    }
  }

  return result;
}

/** The zones the install form offers for Email Routing. */
export interface EmailZoneOptions {
  zones: Array<{ id: string; name: string }>;
  /** Zones that are not active yet, which cannot receive email. */
  inactiveZones: string[];
  /** The token sees no zone: it lacks Zone: Read, or the account has none. */
  noZones: boolean;
}

export async function getEmailZoneOptionsCore(api: CloudflareClient): Promise<EmailZoneOptions> {
  const listed = await listAccountZones(api);
  if (listed === null) return { zones: [], inactiveZones: [], noZones: true };
  return {
    zones: listed.active.map((z) => ({ id: z.id, name: z.name })),
    inactiveZones: listed.inactive.map((z) => z.name),
    noZones: listed.active.length === 0 && listed.inactive.length === 0,
  };
}

/** The install form's preview of what installing on a zone sets up. */
export interface EmailRoutingPreview extends EmailRoutingInspection {
  /** Whether Email Routing would be turned on by the install. */
  enablesRouting: boolean;
  /** The app has a `send_email` binding. */
  sendsEmail: boolean;
  /**
   * The account's verified destination addresses, the ones the app can send
   * to for free; null when the app does not send email or the token cannot
   * list them.
   */
  destinations: string[] | null;
}

/**
 * The preview for app `manifest` installed as `workerName` on `zoneId`: the
 * inspection, plus the verified destination addresses when the app sends email.
 */
export async function previewEmailRoutingCore(
  api: CloudflareClient,
  request: { manifest: ArtifactManifest; zoneId: string; workerName: string },
): Promise<EmailRoutingPreview> {
  const config = request.manifest.catalog.install.emailRouting;
  if (config === undefined) {
    throw new EmailRoutingError(`${request.manifest.catalog.name} does not receive email.`);
  }
  const inspection = await inspectEmailRouting(api, {
    zoneId: request.zoneId,
    config,
    workerName: request.workerName,
  });
  const sends = sendsEmail(request.manifest.worker.bindings);
  let destinations: string[] | null = null;
  if (sends) {
    const listed = await unlessForbidden(() =>
      api.emailRouting.listDestinationAddresses({ verified: true }),
    );
    if (listed === null) {
      inspection.warnings.push(
        `The token cannot list the account's destination addresses (it needs ${EMAIL_ROUTING_PERMISSION.addresses}), so this page cannot show which ones are verified.`,
      );
    } else {
      destinations = listed.filter((a) => a.verified != null).map((a) => a.email);
    }
  }
  return {
    ...inspection,
    enablesRouting: inspection.routing !== null && !inspection.routing.enabled,
    sendsEmail: sends,
    destinations,
  };
}

/**
 * The error a refused Email Routing call becomes: a message that names the
 * permission, or null when the refusal was not about permissions.
 */
export function permissionMessage(error: unknown, what: string, permission: string): string | null {
  if (!isPermissionError(error)) return null;
  return `Cloudflare refused to ${what} (${error instanceof Error ? error.message : String(error)}). The token needs ${permission} on the zone; add it to the token and try again`;
}

/** What removing a recorded routing rule did. */
export type RuleRemoval = "deleted" | "gone";

/** Deletes a routing rule Appflare created; one already gone counts as removed. */
export async function removeEmailRule(
  api: CloudflareClient,
  target: { zoneId: string; ruleId: string },
): Promise<RuleRemoval> {
  try {
    await api.emailRouting.deleteRule(target.zoneId, target.ruleId);
    return "deleted";
  } catch (error) {
    if (isGone(error)) return "gone";
    throw error;
  }
}

/** What restoring a recorded catch-all did. */
export type CatchAllReset = "restored" | "not-ours";

/**
 * Puts the zone's catch-all back as it was before the install (`previous`;
 * without a record of it, drop and off, as Cloudflare starts a zone), if it
 * still delivers to `workerName`; one changed since is left alone.
 */
export async function resetEmailCatchAll(
  api: CloudflareClient,
  target: { zoneId: string; workerName: string; previous: SavedCatchAll | null },
): Promise<CatchAllReset> {
  const current = await api.emailRouting.getCatchAll(target.zoneId);
  if (!deliversTo(current.actions, target.workerName)) return "not-ours";
  const previous = target.previous ?? DEFAULT_CATCH_ALL;
  await api.emailRouting.updateCatchAll(target.zoneId, {
    actions: previous.actions.length > 0 ? previous.actions : DEFAULT_CATCH_ALL.actions,
    matchers: [{ type: "all" }],
    enabled: previous.enabled,
  });
  return "restored";
}

/** What turning routing back off did. */
export type RoutingRelease =
  | { outcome: "disabled" }
  | { outcome: "already-off" }
  | { outcome: "in-use"; rules: number; catchAll: boolean };

/**
 * Turns Email Routing off for a zone Appflare turned it on for, unless other
 * rules remain there or the catch-all still delivers somewhere (another app,
 * or rules the admin added since). Runs after the install's own rules are gone.
 */
export async function releaseEmailRouting(
  api: CloudflareClient,
  zoneId: string,
): Promise<RoutingRelease> {
  let settings: Awaited<ReturnType<typeof api.emailRouting.getSettings>>;
  try {
    settings = await api.emailRouting.getSettings(zoneId);
  } catch (error) {
    if (isGone(error)) return { outcome: "already-off" };
    throw error;
  }
  if (!settings.enabled) return { outcome: "already-off" };
  const rules = regularRules(await api.emailRouting.listRules(zoneId));
  const catchAll = catchAllInUse(await api.emailRouting.getCatchAll(zoneId));
  if (rules.length > 0 || catchAll) {
    return { outcome: "in-use", rules: rules.length, catchAll };
  }
  await api.emailRouting.disableRouting(zoneId);
  return { outcome: "disabled" };
}
