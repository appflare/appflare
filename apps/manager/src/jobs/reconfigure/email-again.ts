import type { CatalogEmailRouting } from "@appflare/schema";
import { parseEmailRouteCfId } from "../../installs/email-routing";
import { provisionEmailRoutingPhase, removeEmailRoutesPhase } from "../install/email-routing";
import { JobError, type JobSteps } from "../steps";
import { settleUnit } from "../units/result";
import {
  describeEmailRoutingChange,
  type EmailRouteRow,
  planEmailRoutingChange,
  readEmailRouteRows,
} from "../update/email-routing";

/**
 * Setting an email app's Email Routing up again, on the domain it receives
 * email for, so that it matches the version that serves. An update or a
 * rollback leaves out a part it cannot set up (an address that already has a
 * rule Appflare did not set up, a catch-all that already sends mail
 * somewhere, a refused call) and leaves the next update or rollback to
 * finish it; this finishes it now, from the app's settings, with the
 * settings change job.
 *
 * Strict where the update is lenient: the parts to set up are checked first,
 * all together, and anything in the way stops the job before it changes
 * anything, naming what to delete or change in the Cloudflare dashboard.
 * Only routes the version declares and Appflare would record are set up, and
 * only routes Appflare recorded are removed (a rule the version no longer
 * has, the catch-all it no longer wants), and only while they still deliver
 * to the Worker; a rule or catch-all something else set up, or changed since,
 * is never changed. Each part is read from the install's records, the same
 * reading the confirmation showed, so running it again once everything is
 * set up changes nothing.
 */

/** What setting the app's email up again would do. Plain data (shown in the confirmation). */
export interface EmailAgainParts {
  zoneId: string;
  zoneName: string;
  /** Full addresses that get a routing rule to the Worker. */
  addresses: string[];
  /** The zone's catch-all is pointed at the Worker. */
  catchAll: boolean;
  /** Routes Appflare set up that the version no longer has, by name (an address, or the zone for its catch-all). */
  remove: Array<{ kind: "rule" | "catch_all"; name: string }>;
}

/**
 * What the records say is left out of the email of the version that serves
 * (`target`, its `install.emailRouting`), on the zone on record; null when
 * nothing is, or when it is not this action's to set up (a version without
 * email, an app without a zone on record, which the zone choice in the
 * app's settings sets up). Pure.
 */
export function emailLeftOut(
  target: CatalogEmailRouting | null | undefined,
  rows: readonly EmailRouteRow[],
  installId: string,
): EmailAgainParts | null {
  if (target == null) return null;
  const change = planEmailRoutingChange(target, rows, installId);
  if (change.zone === null) return null;
  const remove = change.remove.flatMap((r) => {
    const kind = parseEmailRouteCfId(r.cfId)?.kind;
    return kind === "rule" || kind === "catch_all" ? [{ kind, name: r.name }] : [];
  });
  if (change.addresses.length === 0 && !change.catchAll && remove.length === 0) return null;
  return {
    zoneId: change.zone.zoneId,
    zoneName: change.zone.zoneName,
    addresses: change.addresses,
    catchAll: change.catchAll,
    remove,
  };
}

/** What the end of a refusal says: nothing changed, and how to go on. */
const NOTHING_CHANGED =
  "Nothing was changed. Once that is done, set up the app's email again from its settings.";

/**
 * The email part of the settings change job when it sets the app's email up
 * again (`emailAgain`): plan from the records, check every part to set up,
 * set them up, then remove what Appflare set up that the version no longer
 * has. Throws a `JobError` that says why when something is in the way; the
 * routes set up before a later step failed are recorded, so running it
 * again finishes the rest. Returns whether anything changed.
 */
export async function setUpEmailAgainPhase(
  steps: JobSteps,
  request: {
    installId: string;
    /** The Worker that receives the app's mail (`emailScriptName`). */
    workerName: string;
    target: CatalogEmailRouting | null;
    /** The app's other Workers (an app of several), whose routes are the app's too. */
    otherWorkers?: readonly string[];
  },
): Promise<boolean> {
  const { target } = request;
  const change = await steps.run("plan Email Routing again", async ({ log, orm }) => {
    if (target === null) {
      throw new JobError(
        "the installed version receives no email, so there is nothing to set up again",
      );
    }
    const planned = planEmailRoutingChange(
      target,
      await readEmailRouteRows(orm, request.installId),
      request.installId,
    );
    if (planned.zone === null) throw new JobError(planned.refused.join(" "));
    // Addresses the version names that no domain the app uses can take:
    // nothing the dashboard could change, so they do not stop the rest.
    for (const refused of planned.refused) log.warn(refused);
    log.info(describeEmailRoutingChange(planned));
    return planned;
  });
  const { zone } = change;
  if (zone === null) return false;

  // Only what the records say, which is what the confirmation listed: a
  // recorded catch-all is not read again here (an update or a rollback
  // does), so this never acts on a catch-all the admin was not shown.
  const adds = change.addresses.length > 0 || change.catchAll;
  if (adds) {
    const inspection = await steps.run(
      `check Email Routing on ${zone.zoneName}`,
      async ({ log }) => {
        const found = settleUnit(
          await steps.units.api.inspectEmailRouting({
            accountId: steps.accountId(),
            zoneId: zone.zoneId,
            config: { rules: change.addresses, catchAll: change.catchAll },
            workerName: request.workerName,
          }),
          log,
        );
        if (found.zoneName === null) {
          throw new JobError(
            `Appflare cannot see ${zone.zoneName}, the domain the app receives email for: it may have been removed from Cloudflare, or the token lacks ${found.missing.join(", ") || "Zone: Read"}. ${NOTHING_CHANGED}`,
          );
        }
        if (found.missing.length > 0) {
          throw new JobError(
            `the Cloudflare token lacks ${found.missing.join(", ")}, which setting up the app's email needs; add them to the token (for this zone). ${NOTHING_CHANGED}`,
          );
        }
        if (found.problems.length > 0) {
          throw new JobError(`${found.problems.join(" ")} ${NOTHING_CHANGED}`);
        }
        for (const warning of found.warnings) log.warn(warning);
        return found;
      },
    );
    await provisionEmailRoutingPhase(steps, request.installId, inspection, request.workerName);
  }
  if (change.remove.length > 0) {
    await removeEmailRoutesPhase(steps, change.remove, request.workerName, {
      retry: "set up the app's email again from its settings",
      keepInUseRouting: true,
      onlyDelivering: true,
      otherWorkers: request.otherWorkers ?? [],
    });
  }
  return adds || change.remove.length > 0;
}
