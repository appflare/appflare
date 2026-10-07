import type { CatalogEmailRouting } from "@appflare/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TOKEN_REFUSALS } from "../../cloudflare/token-refusals";
import { appPlace } from "../../components/app-links";
import { resources } from "../../db/schema";
import {
  EMAIL_ROUTING_ADDRESS_MAX_LENGTH,
  EMAIL_ROUTING_PERMISSION,
  type EmailRouteTarget,
  emailRoutingChangeNote,
  parseEmailRouteCfId,
} from "../../installs/email-routing";
import {
  type EmailRoutingInspection,
  permissionMessage,
  repointEmailCatchAll,
  repointEmailRule,
} from "../../installs/email-routing.server";
import { EMAIL_ROUTE_KIND } from "../../installs/resource-kinds";
import {
  type EmailRouteRecord,
  provisionEmailRoutingPhase,
  removeEmailRoutesPhase,
} from "../install/email-routing";
import { type EmailZone, emailZones } from "../reconfigure/plan";
import { errorMessage, JobError, type JobSteps, type StepTools } from "../steps";
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
 * Which Worker: the one that receives the version's mail (an app of several
 * Workers may name one other than the primary, `install.emailRouting.worker`).
 * Routes the version keeps that deliver to another of the app's Workers (the
 * version before had that one receive mail) are pointed at it first, in
 * place, so they keep their ids and the install's records stay true.
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
  /**
   * Rules on record the version keeps (absent in a step output recorded
   * before it existed): an app of several Workers points them at the Worker
   * that receives its mail.
   */
  keep?: EmailRouteRecord[];
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
  change.keep = rules.filter((r) => wanted.includes(r.name)).map(asRecord);
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

/**
 * What the log adds about a part left out: when it is tried again, and how
 * to sooner when the app's settings offer it (`again`: the part is missing
 * from the records; a catch-all on record is checked again only by an update
 * or a rollback).
 */
function later(installId: string, again: boolean): string {
  const next = "The next update or rollback of the app sets it up once that is resolved";
  return again
    ? `${next}; to set it up sooner, select Set up email again under ${settingsPlace(installId)}.`
    : `${next}.`;
}

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
    /** The catch-all is on record, and was found not delivering to the Worker. */
    catchAllOnRecord: boolean;
    workerName: string;
  },
): Promise<EmailRoutingInspection | null> {
  const offered = request.addresses.length > 0 || (request.catchAll && !request.catchAllOnRecord);
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
        // In the token's words; the step runner rewords them for a Cloudflare sign-in.
        log.warn(
          `${TOKEN_REFUSALS.emailZoneGone(request.zone.zoneName, found.missing.join(", ") || "Zone: Read")} Nothing new is set up for this version's email; another domain can be chosen under ${settingsPlace(request.installId)}. ${later(request.installId, offered)}`,
        );
        return { inspection: null };
      }
      if (found.missing.length > 0) {
        const lacks = TOKEN_REFUSALS.emailPermissions(
          found.missing.join(", "),
          "setting up this version's email",
        );
        log.warn(
          `${lacks.charAt(0).toUpperCase()}${lacks.slice(1)}, so nothing new is set up for it. ${later(request.installId, offered)}`,
        );
        return { inspection: null };
      }
      const partial = new Map<string, boolean>();
      for (const a of found.addresses) if (a.conflict !== undefined) partial.set(a.conflict, true);
      if (found.catchAll?.problem !== undefined) {
        partial.set(found.catchAll.problem, !request.catchAllOnRecord);
      }
      const blocking = found.problems.filter((p) => !partial.has(p));
      if (blocking.length > 0) {
        log.warn(
          `${blocking.join(" ")} So nothing new is set up for this version's email; another domain can be chosen under ${settingsPlace(request.installId)}. ${later(request.installId, offered)}`,
        );
        return { inspection: null };
      }
      for (const [problem, again] of partial) {
        log.warn(`${problem} ${later(request.installId, again)}`);
      }
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
 * Steps "point <address> at the Worker <name>": for an app of several
 * Workers, each rule on record the version keeps that delivers to another of
 * its Workers is pointed at the one that receives its mail now
 * (`repointEmailRule`). One listing of the zone's rules per rule, and one
 * update for each that moves. Returns the addresses whose rule is gone, to set up again; a rule
 * changed since is left alone with a warning.
 */
async function pointRulesPhase(
  steps: JobSteps,
  request: {
    zone: EmailZone;
    rules: readonly EmailRouteRecord[];
    workerName: string;
    formerWorkers: readonly string[];
  },
): Promise<{ gone: string[] }> {
  const gone: string[] = [];
  for (const rule of request.rules) {
    const target = parseEmailRouteCfId(rule.cfId);
    if (target?.kind !== "rule") continue;
    const result = await steps.run(
      `point ${rule.name} at the Worker "${request.workerName}"`,
      async ({ log, cf, orm }) => {
        let found: Awaited<ReturnType<typeof repointEmailRule>>;
        try {
          found = await repointEmailRule(cf(), {
            zoneId: target.zoneId,
            ruleId: target.ruleId,
            address: rule.name,
            workerName: request.workerName,
            formerWorkers: request.formerWorkers,
          });
        } catch (error) {
          const denied = permissionMessage(
            error,
            `point the routing rule for ${rule.name} at the Worker "${request.workerName}"`,
            EMAIL_ROUTING_PERMISSION.rules,
          );
          throw denied === null ? error : new JobError(denied);
        }
        switch (found.outcome) {
          case "pointed":
            log.info(
              `Mail to ${rule.name} now goes to the Worker "${request.workerName}", which receives this version's mail (it went to "${found.from}").`,
            );
            return { gone: false };
          case "already":
            return { gone: false };
          case "gone":
            // Set up again below, recorded anew.
            await orm
              .update(resources)
              .set({ deleted_at: new Date(steps.now()) })
              .where(eq(resources.id, rule.id));
            log.info(`The routing rule for ${rule.name} is gone; it is set up again.`);
            return { gone: true };
          case "not-ours":
            log.warn(
              `The routing rule for ${rule.name} was changed since Appflare set it up (it is ${found.action} now), so it was left alone and mail to ${rule.name} does not reach the Worker "${request.workerName}".`,
            );
            return { gone: false };
        }
      },
    );
    if (result.gone) gone.push(rule.name);
  }
  return { gone };
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
    /** The Worker that receives the version's mail (`emailScriptName`). */
    workerName: string;
    target: CatalogEmailRouting | null;
    /**
     * The app's other Workers, of the version it moves to and the one it
     * leaves (an app of several): routes that deliver to one of them are the
     * app's, and those the version keeps are pointed at `workerName`.
     */
    otherWorkers?: readonly string[];
  },
): Promise<void> {
  const failedAt = steps.current;
  const formerWorkers = [...new Set(request.otherWorkers ?? [])].filter(
    (n) => n !== request.workerName,
  );
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
    const keep = change.keep ?? [];
    if (zone !== null && formerWorkers.length > 0 && keep.length > 0) {
      const { gone } = await pointRulesPhase(steps, {
        zone,
        rules: keep,
        workerName: request.workerName,
        formerWorkers,
      });
      // A rule deleted since is set up again, through the same check as a new one.
      for (const address of gone)
        if (!change.addresses.includes(address)) change.addresses.push(address);
    }
    if (zone !== null && change.verifyCatchAll === true) {
      const { missing } = await steps.run(
        `check the catch-all of ${zone.zoneName}`,
        async ({ log, cf }) => {
          const found = await repointEmailCatchAll(cf(), {
            zoneId: zone.zoneId,
            workerName: request.workerName,
            formerWorkers,
          });
          if (found.outcome === "already") return { missing: false };
          if (found.outcome === "pointed") {
            log.info(
              `The catch-all of ${zone.zoneName} now delivers to the Worker "${request.workerName}", which receives this version's mail (it delivered to "${found.from}").`,
            );
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
        catchAllOnRecord: change.verifyCatchAll === true,
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
        otherWorkers: formerWorkers,
      });
    }
  } catch (error) {
    await steps
      .run("Email Routing not finished", async ({ log }) => {
        log.warn(
          `Appflare could not finish changing the app's Email Routing (${errorMessage(error)}). The version serves all the same, and what was set up or removed so far is recorded; the next update or rollback of the app finishes the rest. ${request.target === null ? "To finish it sooner, make the change in the Cloudflare dashboard (Email Service, Email Routing)." : `To finish it sooner, select Set up email again under ${settingsPlace(request.installId)} if the app's settings offer it.`}`,
        );
        return {};
      })
      .catch(() => {});
  }
  steps.current = failedAt;
}
