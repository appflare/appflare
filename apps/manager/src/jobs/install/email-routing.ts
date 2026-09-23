import { CloudflareApiError } from "@appflare/cf-api";
import type { CatalogEmailRouting } from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { resources } from "../../db/schema";
import {
  DEFAULT_CATCH_ALL,
  describeCatchAll,
  EMAIL_ROUTING_PERMISSION,
  type EmailRouteTarget,
  emailRouteCfId,
  emailRouteKey,
  emailRouteName,
  emailRuleName,
  parseEmailRouteCfId,
  workerAction,
} from "../../installs/email-routing";
import {
  type EmailRoutingInspection,
  permissionMessage,
  releaseEmailRouting,
  removeEmailRule,
  resetEmailCatchAll,
} from "../../installs/email-routing.server";
import { EMAIL_ROUTE_KIND } from "../../installs/resource-kinds";
import { JobError, type JobSteps } from "../steps";
import { zoneIdSchema } from "../units/email-routing";
import { settleUnit } from "../units/result";
import { type ResourceRecord, recordResource, resourceId } from "./phases";

/**
 * The install job's Email Routing phases, for apps whose catalog manifest
 * sets `install.emailRouting`, on the zone the admin chose:
 *
 * 1. Check, before anything is created: the job unit `inspectEmailRouting`
 *    reads the zone, its routing settings, its MX records (when routing is
 *    off), its rules and catch-all (3 to about 8 requests in the unit's own
 *    invocation, one for the job), and the job stops on any problem or
 *    missing permission.
 * 2. Provision, once the Worker exists: make sure Email Routing is on (one
 *    settings read on every attempt, then `POST .../email/routing/dns`, which
 *    also adds its MX, SPF and DKIM records, only when it is off), one routing
 *    rule per address, and the catch-all when asked. One or two requests per
 *    step in the job's invocation, each recorded as a resource of kind
 *    `email_route`; the catch-all's record keeps the catch-all as it was, so
 *    the uninstall can put it back.
 *
 * What is recorded before its call (Email Routing turned on, the catch-all)
 * is recorded first, like the Worker: a call whose answer is lost has still
 * changed the zone, and the uninstall must undo it.
 */

/** The zone the admin chose for an app that receives email; part of the install job's payload. */
export const emailRoutingJobInput = z.object({ zoneId: zoneIdSchema });
export type EmailRoutingJobInput = z.infer<typeof emailRoutingJobInput>;

/** One line on what the install will set up, for the job log. */
function summary(inspection: EmailRoutingInspection): string {
  const zone = inspection.zoneName ?? inspection.zoneId;
  const parts: string[] = [];
  if (inspection.routing?.enabled === false) {
    parts.push(`turn Email Routing on for ${zone} (Cloudflare adds its MX, SPF and DKIM records)`);
  }
  if (inspection.addresses.length > 0) {
    parts.push(`route ${inspection.addresses.map((a) => a.address).join(", ")} to the Worker`);
  }
  if (inspection.wantsCatchAll) parts.push(`send every other address at ${zone} to the Worker`);
  return `Email Routing on ${zone} is ${inspection.routing?.enabled ? "on" : "off"}. The install will ${parts.join(", then ")}.`;
}

/**
 * Step "check Email Routing": one unit call. Fails the job, before anything
 * is created, when the token lacks a permission the install needs or the zone
 * has a conflict (see `inspectEmailRouting`).
 */
export async function checkEmailRoutingPhase(
  steps: JobSteps,
  request: { zoneId: string; config: CatalogEmailRouting; workerName: string },
): Promise<EmailRoutingInspection> {
  return steps.run("check Email Routing", async ({ log }) => {
    const inspection = settleUnit(
      await steps.units.api.inspectEmailRouting({
        accountId: steps.accountId(),
        zoneId: request.zoneId,
        config: request.config,
        workerName: request.workerName,
      }),
      log,
    );
    if (inspection.missing.length > 0) {
      throw new JobError(
        `the Cloudflare token lacks ${inspection.missing.join(", ")}, which receiving email needs; add them to the token (for this zone) and install again`,
      );
    }
    if (inspection.problems.length > 0) throw new JobError(inspection.problems.join(" "));
    for (const warning of inspection.warnings) log.warn(warning);
    log.info(summary(inspection));
    return inspection;
  });
}

/** A refusal (4xx other than 429): the call changed nothing and a retry would not help. */
function refused(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status < 500 && error.status !== 429;
}

/**
 * Makes sure Email Routing is on, then creates the routing rules and points
 * the catch-all at the Worker, recording each. Runs after the Worker is
 * uploaded: a rule names an existing Worker.
 *
 * The settings are read again on every attempt of the routing step, not
 * taken from the check: another install on the zone may have turned routing
 * on since (then it is theirs to turn off, and this install records nothing),
 * or an uninstall may have turned it off (then this install turns it on and
 * records that it did).
 */
export async function provisionEmailRoutingPhase(
  steps: JobSteps,
  installId: string,
  inspection: EmailRoutingInspection,
  workerName: string,
): Promise<void> {
  const { zoneId } = inspection;
  const zoneName = inspection.zoneName ?? zoneId;
  const now = () => new Date(steps.now());
  const record = (kind: EmailRouteTarget["kind"], target: EmailRouteTarget, address?: string) => {
    const name = emailRouteName(kind, { zoneName, ...(address === undefined ? {} : { address }) });
    const row: ResourceRecord = {
      kind: EMAIL_ROUTE_KIND,
      key: emailRouteKey(kind, name),
      binding: null,
      name,
      cfId: emailRouteCfId(target),
    };
    return row;
  };

  await steps.run(`make sure Email Routing is on for ${zoneName}`, async ({ log, cf, orm }) => {
    const row = record("routing", { kind: "routing", zoneId });
    const rowId = resourceId(installId, row.kind, row.key);
    const api = cf();
    let enabled: boolean;
    try {
      enabled = (await api.emailRouting.getSettings(zoneId)).enabled;
    } catch (error) {
      const denied = permissionMessage(
        error,
        `read Email Routing on ${zoneName}`,
        EMAIL_ROUTING_PERMISSION.zoneSettings,
      );
      throw denied === null ? error : new JobError(denied);
    }
    if (enabled) {
      const [earlier] = await orm
        .select({ id: resources.id })
        .from(resources)
        .where(and(eq(resources.id, rowId), isNull(resources.deleted_at)))
        .limit(1);
      if (earlier !== undefined) {
        log.info(`Email Routing is on for ${zoneName} (turned on by an earlier attempt).`);
      } else if (inspection.routing?.enabled === true) {
        log.info(`Email Routing is on for ${zoneName}.`);
      } else {
        log.warn(
          `Email Routing for ${zoneName} was turned on by something else since the check (another install, or the dashboard), so this install will not turn it off when it is uninstalled.`,
        );
      }
      return {};
    }
    if (inspection.routing?.enabled === true) {
      log.warn(
        `Email Routing for ${zoneName} was turned off since the check (another app's uninstall may have released it); turning it on again.`,
      );
    }
    // Recorded before the call: an answer lost after Cloudflare turned it on
    // still leaves a record for the uninstall.
    await recordResource(orm, installId, row, now());
    try {
      await api.emailRouting.enableRouting(zoneId);
    } catch (error) {
      if (refused(error)) {
        // Nothing was turned on: the uninstall must not turn it off later.
        await orm.update(resources).set({ deleted_at: now() }).where(eq(resources.id, rowId));
      }
      const denied = permissionMessage(
        error,
        `turn Email Routing on for ${zoneName}`,
        EMAIL_ROUTING_PERMISSION.zoneSettings,
      );
      throw denied === null ? error : new JobError(denied);
    }
    log.info(
      `Turned Email Routing on for ${zoneName}; Cloudflare added and locked its MX, SPF and DKIM records.`,
    );
    return {};
  });

  for (const { address, existingRuleId } of inspection.addresses) {
    await steps.run(`route ${address} to the Worker`, async ({ log, cf, orm, attempt }) => {
      const api = cf();
      let ruleId = existingRuleId;
      if (ruleId === null && attempt > 1) {
        // An earlier attempt may have created the rule before its answer was lost.
        const found = (await api.emailRouting.listRules(zoneId)).find(
          (r) =>
            r.matchers.some((m) => m.type === "literal" && m.value?.toLowerCase() === address) &&
            r.actions[0]?.type === "worker" &&
            r.actions[0].value?.[0] === workerName,
        );
        ruleId = found?.id ?? null;
      }
      if (ruleId === null) {
        try {
          ruleId = (
            await api.emailRouting.createRule(zoneId, {
              name: emailRuleName(workerName),
              enabled: true,
              matchers: [{ type: "literal", field: "to", value: address }],
              actions: [workerAction(workerName)],
            })
          ).id;
        } catch (error) {
          const denied = permissionMessage(
            error,
            `create the routing rule for ${address}`,
            EMAIL_ROUTING_PERMISSION.rules,
          );
          throw denied === null ? error : new JobError(denied);
        }
        log.info(`Mail to ${address} now goes to the Worker "${workerName}".`);
      } else {
        log.info(`Mail to ${address} already goes to the Worker "${workerName}".`);
      }
      await recordResource(
        orm,
        installId,
        record("rule", { kind: "rule", zoneId, ruleId }, address),
        now(),
      );
      return {};
    });
  }

  if (inspection.wantsCatchAll) {
    await steps.run(`send other mail at ${zoneName} to the Worker`, async ({ log, cf, orm }) => {
      // The catch-all as the check found it, which the uninstall puts back.
      const previous = inspection.catchAll?.state === "free" ? inspection.catchAll.previous : null;
      const row = record("catch_all", { kind: "catch_all", zoneId, previous });
      await recordResource(orm, installId, row, now());
      if (inspection.catchAll?.state === "ours") {
        log.info(`The catch-all of ${zoneName} already goes to the Worker "${workerName}".`);
        return {};
      }
      try {
        await cf().emailRouting.updateCatchAll(zoneId, {
          name: emailRuleName(workerName),
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [workerAction(workerName)],
        });
      } catch (error) {
        if (refused(error)) {
          await orm
            .update(resources)
            .set({ deleted_at: now() })
            .where(eq(resources.id, resourceId(installId, row.kind, row.key)));
        }
        const denied = permissionMessage(
          error,
          `set the catch-all of ${zoneName}`,
          EMAIL_ROUTING_PERMISSION.rules,
        );
        throw denied === null ? error : new JobError(denied);
      }
      log.info(
        `Mail to every other address at ${zoneName} now goes to the Worker "${workerName}" (it was ${describeCatchAll(previous ?? DEFAULT_CATCH_ALL)} before).`,
      );
      return {};
    });
  }
}

/** A recorded `email_route` resource, as the uninstall job reads it. */
export interface EmailRouteRecord {
  /** The `resources` row id. */
  id: string;
  name: string;
  cfId: string | null;
}

/**
 * The uninstall job's Email Routing phase, before the Worker is deleted: each
 * routing rule the install created is deleted, the catch-all is set back to
 * drop (if it still delivers to the Worker), and then Email Routing is turned
 * off for each zone Appflare turned it on for, unless another rule or an
 * active catch-all remains there. One step per record; a rule is one request,
 * the catch-all two, routing up to four. Each record is marked deleted when
 * its step ends, whatever it found.
 */
export async function removeEmailRoutesPhase(
  steps: JobSteps,
  routes: readonly EmailRouteRecord[],
  workerName: string,
): Promise<void> {
  const now = () => new Date(steps.now());
  const parsed = routes.map((r) => ({ ...r, target: parseEmailRouteCfId(r.cfId) }));
  const order: Record<EmailRouteTarget["kind"], number> = { rule: 0, catch_all: 1, routing: 2 };
  parsed.sort(
    (a, b) => (a.target ? order[a.target.kind] : -1) - (b.target ? order[b.target.kind] : -1),
  );

  for (const route of parsed) {
    const { target } = route;
    const stepName =
      target === null
        ? `forget email route ${route.name}`
        : target.kind === "rule"
          ? `remove email route ${route.name}`
          : target.kind === "catch_all"
            ? `restore catch-all ${route.name}`
            : `release Email Routing for ${route.name}`;
    await steps.run(stepName, async ({ log, cf, orm }) => {
      const denied = (error: unknown, what: string, permission: string): never => {
        const message = permissionMessage(error, what, permission);
        if (message === null) throw error;
        throw new JobError(`${message}, then retry the uninstall`);
      };
      if (target === null) {
        log.warn(
          `The email route "${route.name}" has no record Appflare can read; check Email Routing in the Cloudflare dashboard for it.`,
        );
      } else if (target.kind === "rule") {
        try {
          const outcome = await removeEmailRule(cf(), target);
          log.info(
            outcome === "deleted"
              ? `Deleted the routing rule for ${route.name}.`
              : `The routing rule for ${route.name} was already gone.`,
          );
        } catch (error) {
          denied(
            error,
            `delete the routing rule for ${route.name}`,
            EMAIL_ROUTING_PERMISSION.rules,
          );
        }
      } else if (target.kind === "catch_all") {
        try {
          const outcome = await resetEmailCatchAll(cf(), {
            zoneId: target.zoneId,
            workerName,
            previous: target.previous,
          });
          log.info(
            outcome === "restored"
              ? `Put the catch-all (${route.name}) back as it was before the install: ${describeCatchAll(target.previous ?? DEFAULT_CATCH_ALL)}.`
              : `The catch-all (${route.name}) no longer delivers to "${workerName}", so it was left alone.`,
          );
        } catch (error) {
          denied(error, `reset the catch-all ${route.name}`, EMAIL_ROUTING_PERMISSION.rules);
        }
      } else {
        try {
          const released = await releaseEmailRouting(cf(), target.zoneId);
          switch (released.outcome) {
            case "disabled":
              log.info(
                `Turned Email Routing off for ${route.name}; Cloudflare removed its MX records.`,
              );
              break;
            case "already-off":
              log.info(`Email Routing was already off for ${route.name}.`);
              break;
            case "in-use":
              log.info(
                `Left Email Routing on for ${route.name}: ${released.rules} other routing rule(s)${released.catchAll ? " and an active catch-all" : ""} still use it.`,
              );
              break;
          }
        } catch (error) {
          denied(
            error,
            `turn Email Routing off for ${route.name}`,
            `${EMAIL_ROUTING_PERMISSION.zoneSettings} and ${EMAIL_ROUTING_PERMISSION.rules}`,
          );
        }
      }
      await orm.update(resources).set({ deleted_at: now() }).where(eq(resources.id, route.id));
      return {};
    });
  }
}
