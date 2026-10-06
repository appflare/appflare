import type { CatalogEmailRouting } from "@appflare/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { appPlace } from "../../components/app-links";
import { resources } from "../../db/schema";
import {
  deliversTo,
  EMAIL_ROUTING_ADDRESS_MAX_LENGTH,
  type EmailRouteTarget,
  emailRoutingChangeNote,
  parseEmailRouteCfId,
} from "../../installs/email-routing";
import type { EmailRoutingInspection } from "../../installs/email-routing.server";
import { EMAIL_ROUTE_KIND } from "../../installs/resource-kinds";
import {
  type EmailRouteRecord,
  provisionEmailRoutingPhase,
  removeEmailRoutesPhase,
} from "../install/email-routing";
import { type EmailZone, emailZones } from "../reconfigure/plan";
import { errorMessage, type JobSteps, type StepTools } from "../steps";
import { settleUnit } from "../units/result";

/**
 * Email Routing across versions: an update or a rollback brings the app's
 * routing rules and catch-all in line with the version it moves to
 * (`install.emailRouting`), once that version serves.
 *
 * Where: the zone the app receives email for, the one the admin chose at
 * install (or moved it to since), read from the install's `email_route`
 * records. A version that receives no email removes every route, and the
 * records it marks removed still name the zone, so a rollback (or a later
 * update) sets the routes up there again. The install's records are the only
 * routes ever removed; a rule or catch-all something else set up is never
 * changed.
 *
 * What it adds goes through the install's own check first (one unit call),
 * with the install's rules: an address that already has a rule delivering
 * elsewhere, a catch-all that already sends mail somewhere, a zone whose mail
 * goes to another provider while routing is off, or a token without the
 * permissions is never overridden. The install refuses those outright; since
 * the version already serves here, the job leaves that part out with a
 * warning and sets up the rest, and the next update or rollback tries it
 * again. A version that receives email for an install with no zone on record
 * needs the admin's choice, which only the app's settings ask for.
 *
 * New routes are set up before old ones are removed, so mail that both
 * versions receive is never unrouted; removing goes through the uninstall's
 * phase (rules, then the catch-all put back, then routing turned off where
 * Appflare turned it on and nothing else uses it). Each step is idempotent,
 * and the plan is read again from the records each time, so running it again
 * after a failure finishes what is left.
 */

/** An `email_route` record of the install, live or removed. */
export interface EmailRouteRow {
  id: string;
  name: string;
  cfId: string | null;
  createdAt: number;
  /** Marked removed (an uninstall, a move, or a version that dropped it). */
  deleted: boolean;
}

/** What an update or rollback changes about Email Routing. Plain data (a step result). */
export interface EmailRoutingChange {
  /** The zone the app receives email for; null when Appflare has none on record. */
  zone: EmailZone | null;
  /** Full addresses that get a routing rule to the Worker. */
  addresses: string[];
  /** The zone's catch-all is pointed at the Worker. */
  catchAll: boolean;
  /**
   * The version keeps the catch-all the install recorded: whether it still
   * delivers to the Worker is read first. The record is written before the
   * call that points it there, so a call that kept failing leaves a record
   * of a catch-all that was never set; reading it lets the job set it then.
   */
  verifyCatchAll?: boolean;
  /** Records whose routes go, as an uninstall removes them. */
  remove: EmailRouteRecord[];
  /** Parts of the version's email that are not set up, one sentence each. */
  refused: string[];
}

function kindOf(row: EmailRouteRow): EmailRouteTarget["kind"] | null {
  return parseEmailRouteCfId(row.cfId)?.kind ?? null;
}

function zoneIdOf(row: EmailRouteRow): string | null {
  return parseEmailRouteCfId(row.cfId)?.zoneId ?? null;
}

const asRecord = (row: EmailRouteRow): EmailRouteRecord => ({
  id: row.id,
  name: row.name,
  cfId: row.cfId,
});

/**
 * The zone an install receives email for, from its records: the one its
 * newest live record is on, else (every route was removed by a version
 * without email) the one its newest removed record names. Pure.
 */
export function emailZoneOnRecord(rows: readonly EmailRouteRow[]): EmailZone | null {
  const readable = rows.filter((r) => kindOf(r) !== null);
  return emailZones(readable.filter((r) => !r.deleted)).current ?? emailZones(readable).current;
}

/** The install's `email_route` records, live and removed, in insertion order. */
export async function readEmailRouteRows(
  orm: StepTools["orm"],
  installId: string,
): Promise<EmailRouteRow[]> {
  const rows = await orm
    .select({
      id: resources.id,
      name: resources.name,
      cfId: resources.cf_id,
      createdAt: resources.created_at,
      deletedAt: resources.deleted_at,
    })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        eq(resources.kind, EMAIL_ROUTE_KIND),
        isNull(resources.retained_at),
      ),
    )
    // Insertion order (created_at can tie within a millisecond).
    .orderBy(sql`rowid`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cfId: r.cfId,
    createdAt: r.createdAt.getTime(),
    deleted: r.deletedAt !== null,
  }));
}

/** A version's email as written, for a cheap first comparison (no zone). */
function writtenEmail(config: CatalogEmailRouting | null | undefined): string {
  if (config == null) return "";
  return JSON.stringify([[...(config.rules ?? [])].sort(), config.catchAll === true]);
}

/**
 * The note on how moving from `serving` to `next` changes the app's email
 * (`emailRoutingChangeNote`, on the zone on record); null when nothing
 * changes. The records are read only when the two versions' email is written
 * differently, so an update of an app without email costs no query.
 */
export async function readEmailChangeNote(
  orm: StepTools["orm"],
  installId: string,
  serving: CatalogEmailRouting | null | undefined,
  next: CatalogEmailRouting | null | undefined,
  version: string,
): Promise<string | null> {
  if (writtenEmail(serving) === writtenEmail(next)) return null;
  const zone = emailZoneOnRecord(await readEmailRouteRows(orm, installId));
  return emailRoutingChangeNote(serving, next, version, zone?.zoneName ?? null);
}

/**
 * Plans the change to `target` (null: the version receives no email) from
 * the install's records. Pure.
 */
export function planEmailRoutingChange(
  target: CatalogEmailRouting | null,
  rows: readonly EmailRouteRow[],
  installId: string,
): EmailRoutingChange {
  const live = rows.filter((r) => kindOf(r) !== null && !r.deleted);
  const zone = emailZoneOnRecord(rows);
  const change: EmailRoutingChange = {
    zone,
    addresses: [],
    catchAll: false,
    remove: [],
    refused: [],
  };
  if (target === null) {
    // Nothing of the app's email stays, on any zone it has routes on.
    change.remove = live.map(asRecord);
    return change;
  }
  if (zone === null) {
    change.refused.push(
      `This version receives email, and Appflare has no domain on record for this app to receive it at, so no Email Routing is set up. Choose the domain under ${appPlace(installId, "email-zone", "Email in the app's settings")}.`,
    );
    return change;
  }
  const zoneName = zone.zoneName.toLowerCase();
  const wanted: string[] = [];
  for (const rule of target.rules ?? []) {
    const at = rule.indexOf("@");
    const address = at === -1 ? `${rule}@${zoneName}` : rule;
    if (at !== -1 && rule.slice(at + 1) !== zoneName) {
      change.refused.push(
        `This version wants mail for ${rule}, which is not an address at ${zoneName}, the domain the app receives email for, so no rule is set up for it.`,
      );
      continue;
    }
    if (address.length > EMAIL_ROUTING_ADDRESS_MAX_LENGTH) {
      change.refused.push(
        `${address} is longer than the ${EMAIL_ROUTING_ADDRESS_MAX_LENGTH} characters an Email Routing rule can match, so no rule is set up for it.`,
      );
      continue;
    }
    if (!wanted.includes(address)) wanted.push(address);
  }
  // Routes on other zones belong to a move that did not finish; the app's
  // settings finish it. Only the current zone's are compared.
  const onZone = live.filter((r) => zoneIdOf(r) === zone.zoneId);
  const rules = onZone.filter((r) => kindOf(r) === "rule");
  change.addresses = wanted.filter((a) => !rules.some((r) => r.name === a));
  change.remove = rules.filter((r) => !wanted.includes(r.name)).map(asRecord);
  const catchAll = onZone.find((r) => kindOf(r) === "catch_all");
  if (target.catchAll === true && catchAll === undefined) change.catchAll = true;
  if (target.catchAll === true && catchAll !== undefined) change.verifyCatchAll = true;
  if (target.catchAll !== true && catchAll !== undefined) change.remove.push(asRecord(catchAll));
  return change;
}

/** One line on what the change does, for the job log. */
export function describeEmailRoutingChange(change: EmailRoutingChange): string {
  const zone = change.zone?.zoneName ?? "the app's domain";
  const parts: string[] = [];
  if (change.addresses.length > 0) {
    parts.push(`route ${change.addresses.join(", ")} to the Worker`);
  }
  if (change.catchAll) parts.push(`send every other address at ${zone} to the Worker`);
  const rules = change.remove.filter((r) => parseEmailRouteCfId(r.cfId)?.kind === "rule");
  if (rules.length > 0) parts.push(`stop routing ${rules.map((r) => r.name).join(", ")}`);
  if (change.remove.some((r) => parseEmailRouteCfId(r.cfId)?.kind === "catch_all")) {
    parts.push(`put the catch-all of ${zone} back as it was`);
  }
  if (change.remove.some((r) => parseEmailRouteCfId(r.cfId)?.kind === "routing")) {
    parts.push(
      `turn Email Routing off for ${zone} if nothing else uses it (Appflare turned it on)`,
    );
  }
  if (parts.length === 0) return `Email Routing on ${zone} already matches this version.`;
  return `Email Routing on ${zone}: ${parts.join(", then ")}.`;
}

/** What the log adds about a part left out: when it is tried again. */
const LATER = "The next update or rollback of the app sets it up once that is resolved.";

/** Where the admin chooses another domain for the app's email. */
function settingsPlace(installId: string): string {
  return appPlace(installId, "email-zone", "Email in the app's settings");
}

/**
 * Step "check Email Routing on <zone>": the install's check of what is to be
 * added (one unit call), keeping only what the install would go ahead with.
 * Null when nothing can be added.
 */
async function checkAdditionsPhase(
  steps: JobSteps,
  request: {
    installId: string;
    zone: EmailZone;
    addresses: string[];
    catchAll: boolean;
    workerName: string;
  },
): Promise<EmailRoutingInspection | null> {
  const { inspection } = await steps.run(
    `check Email Routing on ${request.zone.zoneName}`,
    async ({ log }) => {
      const found = settleUnit(
        await steps.units.api.inspectEmailRouting({
          accountId: steps.accountId(),
          zoneId: request.zone.zoneId,
          config: { rules: request.addresses, catchAll: request.catchAll },
          workerName: request.workerName,
        }),
        log,
      );
      if (found.zoneName === null) {
        log.warn(
          `Appflare cannot see ${request.zone.zoneName}, the domain the app receives email for: it may have been removed from Cloudflare, or the token lacks ${found.missing.join(", ") || "Zone: Read"}. Nothing new is set up for this version's email; choose another domain under ${settingsPlace(request.installId)}, or fix the token. ${LATER}`,
        );
        return { inspection: null };
      }
      if (found.missing.length > 0) {
        log.warn(
          `The Cloudflare token lacks ${found.missing.join(", ")}, which setting up this version's email needs, so nothing new is set up for it; add them to the token (for this zone). ${LATER}`,
        );
        return { inspection: null };
      }
      const partial = new Set<string>();
      for (const a of found.addresses) if (a.conflict !== undefined) partial.add(a.conflict);
      if (found.catchAll?.problem !== undefined) partial.add(found.catchAll.problem);
      const blocking = found.problems.filter((p) => !partial.has(p));
      if (blocking.length > 0) {
        log.warn(
          `${blocking.join(" ")} So nothing new is set up for this version's email; another domain can be chosen under ${settingsPlace(request.installId)}. ${LATER}`,
        );
        return { inspection: null };
      }
      for (const problem of partial) log.warn(`${problem} ${LATER}`);
      for (const warning of found.warnings) log.warn(warning);
      const kept: EmailRoutingInspection = {
        ...found,
        addresses: found.addresses.filter((a) => a.conflict === undefined),
        wantsCatchAll: found.wantsCatchAll && found.catchAll?.state !== "taken",
        problems: [],
      };
      if (kept.addresses.length === 0 && !kept.wantsCatchAll) return { inspection: null };
      return { inspection: kept };
    },
  );
  return inspection;
}

/**
 * Brings the install's Email Routing in line with `target`, the
 * `install.emailRouting` of the version that now serves (null: none). Run
 * once that version serves. See the top of this file. Never throws: the
 * version already serves, and a job that failed for this could not be run
 * again (an update to the installed version, or a rollback to the snapshot
 * being undone, is refused). A failure ends the change where it is, with a
 * warning that the next update or rollback finishes it; what was done is
 * recorded, and the plan is read from the records again then.
 */
export async function changeEmailRoutingPhase(
  steps: JobSteps,
  request: {
    installId: string;
    workerName: string;
    target: CatalogEmailRouting | null;
  },
): Promise<void> {
  const failedAt = steps.current;
  try {
    const change = await steps.run("plan Email Routing", async ({ log, orm }) => {
      const planned = planEmailRoutingChange(
        request.target,
        await readEmailRouteRows(orm, request.installId),
        request.installId,
      );
      for (const refused of planned.refused) log.warn(refused);
      if (planned.zone !== null || planned.remove.length > 0) {
        log.info(describeEmailRoutingChange(planned));
      }
      return planned;
    });

    const { zone } = change;
    if (zone !== null && change.verifyCatchAll === true) {
      const { missing } = await steps.run(
        `check the catch-all of ${zone.zoneName}`,
        async ({ log, cf }) => {
          const current = await cf().emailRouting.getCatchAll(zone.zoneId);
          if (current.enabled && deliversTo(current.actions, request.workerName)) {
            return { missing: false };
          }
          log.info(
            `The catch-all of ${zone.zoneName} does not deliver to the Worker, as Appflare recorded it should; it is set up again.`,
          );
          return { missing: true };
        },
      );
      if (missing) change.catchAll = true;
    }
    if (zone !== null && (change.addresses.length > 0 || change.catchAll)) {
      const inspection = await checkAdditionsPhase(steps, {
        installId: request.installId,
        zone,
        addresses: change.addresses,
        catchAll: change.catchAll,
        workerName: request.workerName,
      });
      if (inspection !== null) {
        await provisionEmailRoutingPhase(steps, request.installId, inspection, request.workerName);
      }
    }
    if (change.remove.length > 0) {
      await removeEmailRoutesPhase(steps, change.remove, request.workerName, {
        retry: "let the next update or rollback of the app finish the change",
        keepInUseRouting: true,
      });
    }
  } catch (error) {
    await steps
      .run("Email Routing not finished", async ({ log }) => {
        log.warn(
          `Appflare could not finish changing the app's Email Routing (${errorMessage(error)}). The version serves all the same, and what was set up or removed so far is recorded; the next update or rollback of the app finishes the rest. To finish it sooner, make the change in the Cloudflare dashboard (Email Service, Email Routing).`,
        );
        return {};
      })
      .catch(() => {});
  }
  steps.current = failedAt;
}
