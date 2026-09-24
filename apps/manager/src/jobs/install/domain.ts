import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Database } from "../../db/client";
import { resources } from "../../db/schema";
import { gatewayBindingName, gatewayHostname } from "../../gateway/gateway";
import { isGatewayReady, readGateway } from "../../gateway/gateway.server";
import type { ExternalDomainStatus } from "../../installs/external-domain-input";
import {
  claimExternalDomain,
  claimRefusal,
  externalDomainRef,
  releaseExternalDomain,
} from "../../installs/external-domains.server";
import type { InstallDomainInput } from "../../installs/install-input";
import {
  ADDRESS_KINDS,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
} from "../../installs/resource-kinds";
import { errorMessage, type JobSteps } from "../steps";
import { EXTERNAL_DOMAIN_MAX_POLLS, EXTERNAL_DOMAIN_MAX_POLLS_IN_PLACE } from "../units/domains";
import { settleUnit } from "../units/result";
import type { HealthCheck } from "./health";

/**
 * The install job's domain step, for an install whose form asked for a
 * custom domain or an external domain. It runs once the Worker serves and
 * its workers.dev check is done, and never fails the install: the app is
 * installed by then, so a domain that cannot be added is reported in the log
 * (with what to do) and can be added later from the app page.
 *
 * - Custom domain: one unit call attaches it. A hostname with DNS records of
 *   its own is not replaced here; the app page asks before replacing them.
 * - External domain: one unit call registers the custom hostname and routes
 *   it through the gateway, then one more waits (in its own invocation over
 *   `SELF`) for the hostname and its certificate to go active, which happens
 *   only once the owner's DNS records exist. When they do not yet, the log
 *   lists them and the app page keeps checking.
 *
 * Each is recorded as the app page records it (kind `domain` or
 * `custom_hostname`); a hostname another app records is refused, and an
 * external domain's name is claimed before anything is created, so a retried
 * step finds its own claim and takes over only what it created.
 */

/** Whether another install records `hostname` as a custom or external domain. */
async function heldElsewhere(orm: Database, installId: string, hostname: string): Promise<boolean> {
  const [row] = await orm
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        inArray(resources.kind, [...ADDRESS_KINDS]),
        eq(resources.name, hostname),
        ne(resources.install_id, installId),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function recordedId(
  orm: Database,
  installId: string,
  kind: typeof CUSTOM_DOMAIN_KIND | typeof CUSTOM_HOSTNAME_KIND,
  hostname: string,
): Promise<string | null> {
  const [row] = await orm
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        eq(resources.kind, kind),
        eq(resources.name, hostname),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function recordLines(status: ExternalDomainStatus): string {
  return status.records.map((r) => `${r.type} ${r.name} -> ${r.value}`).join("; ");
}

export async function installDomainPhase(
  steps: JobSteps,
  request: {
    /** The manager's D1, for the claim (one conditional statement). */
    db: D1Database;
    installId: string;
    workerName: string;
    domain: InstallDomainInput;
    health: HealthCheck;
  },
): Promise<void> {
  const { domain } = request;
  const label = domain.kind === "custom" ? "custom domain" : "external domain";
  type Pending = { zoneId: string; customHostnameId: string; hostname: string; target: string };
  let external: Pending | null = null;
  try {
    const added = await steps.run(`add ${label} ${domain.hostname}`, async ({ log, orm }) => {
      const none = { external: null as Pending | null };
      const gateway = domain.kind === "external" ? await readGateway(orm) : null;
      if (domain.kind === "external" && !isGatewayReady(gateway)) {
        log.warn(
          `${domain.hostname} was not added: the external domains gateway is not set up any more. Set it up in Settings, Domains, then add the domain on the app's Domains and email tab.`,
        );
        return none;
      }
      // No two installs share a hostname: another app's domain is refused
      // before anything is created.
      const taken = await heldElsewhere(orm, request.installId, domain.hostname);
      if (taken) {
        log.warn(
          `${domain.hostname} was not added: it is already a domain of another app. Remove it there first, then add it on this app's Domains and email tab.`,
        );
        return none;
      }
      // An external domain's name is claimed (recorded without an id) before
      // anything is created; a retried step finds its own claim.
      let claim: { id: string; claimedAt: number } | null = null;
      if (domain.kind === "external") {
        const claimed = await claimExternalDomain(request.db, {
          id: `${request.installId}:${CUSTOM_HOSTNAME_KIND}:${ulid(steps.now())}`,
          installId: request.installId,
          hostname: domain.hostname,
          binding: gatewayBindingName(request.installId),
          at: new Date(steps.now()),
        });
        const refusal = claimRefusal(domain.hostname, claimed, request.installId);
        if (refusal !== null || (claimed.kind !== "claimed" && claimed.kind !== "mine")) {
          log.warn(`${domain.hostname} was not added: ${refusal ?? "it could not be claimed"}`);
          return none;
        }
        claim = { id: claimed.id, claimedAt: claimed.claimedAt };
      }
      const result = settleUnit(
        await steps.units.api.attachDomain({
          accountId: steps.accountId(),
          installId: request.installId,
          workerName: request.workerName,
          domain,
          gateway: isGatewayReady(gateway) ? gateway : null,
          ...(claim === null ? {} : { claimedAt: claim.claimedAt }),
        }),
        log,
      );
      const at = new Date(steps.now());
      if (result.kind === "custom") {
        if (!result.ok) {
          log.warn(
            `${result.hostname} already has DNS records${result.records.length > 0 ? ` (${result.records.map((r) => (r.content === null ? r.type : `${r.type} ${r.content}`)).join(", ")})` : ""}, so the install did not replace them. Add the domain on the app's Domains and email tab, where you can choose to replace them.`,
          );
          return none;
        }
        if (
          (await recordedId(orm, request.installId, CUSTOM_DOMAIN_KIND, result.hostname)) === null
        ) {
          await orm.insert(resources).values({
            id: `${request.installId}:${CUSTOM_DOMAIN_KIND}:${ulid(at.getTime())}`,
            install_id: request.installId,
            kind: CUSTOM_DOMAIN_KIND,
            binding: null,
            name: result.hostname,
            cf_id: result.domainId,
            created_at: at,
          });
        }
        log.info(`https://${result.hostname} serves the app; Cloudflare issues its certificate.`);
        return none;
      }
      if (claim === null) throw new Error("an external domain is attached only under a claim");
      if (!result.ok) {
        await releaseExternalDomain(request.db, claim.id, at);
        log.warn(
          `The app is installed, but ${result.hostname} could not be added: ${result.reason} Add it on the app's Domains and email tab once that is fixed.`,
        );
        return none;
      }
      await orm
        .update(resources)
        .set({ cf_id: externalDomainRef(result.zoneId, result.customHostnameId) })
        .where(eq(resources.id, claim.id));
      const target = gatewayHostname(gateway?.zoneName ?? "");
      if (!result.status.active) {
        log.info(
          `${result.hostname} is registered and waits for its DNS records: ${recordLines(result.status)}.`,
        );
      }
      return {
        external: {
          zoneId: result.zoneId,
          customHostnameId: result.customHostnameId,
          hostname: result.hostname,
          target,
        },
      };
    });
    external = added.external;
  } catch (error) {
    await steps.run(`${label} not added`, async ({ log }) => {
      log.warn(
        `The app is installed, but ${domain.hostname} could not be added: ${errorMessage(error)}. Add it on the app's Domains and email tab once that is fixed.`,
      );
      return {};
    });
    return;
  }
  if (external === null) return;
  const waiting = external;

  try {
    await steps.run(`wait for ${waiting.hostname}`, async ({ log }) => {
      const { status, polls } = settleUnit(
        await steps.units.api.waitForExternalDomain({
          accountId: steps.accountId(),
          zoneId: waiting.zoneId,
          customHostnameId: waiting.customHostnameId,
          target: waiting.target,
          healthUrl: `https://${waiting.hostname}${request.health.path}`,
          healthMode: request.health.mode,
          maxPolls: steps.units.remote
            ? EXTERNAL_DOMAIN_MAX_POLLS
            : EXTERNAL_DOMAIN_MAX_POLLS_IN_PLACE,
        }),
        log,
      );
      if (!status.active) {
        log.info(
          `After ${polls} check(s), ${waiting.hostname} is still waiting for its DNS records (${[...status.errors].join(" ") || `hostname ${status.status}, certificate ${status.sslStatus ?? "unknown"}`}). Add them at the domain's DNS host: ${recordLines(status)}. The app's Domains and email tab shows its progress.`,
        );
      }
      return {};
    });
  } catch (error) {
    await steps.run(`${waiting.hostname} not checked`, async ({ log }) => {
      log.warn(
        `Could not check ${waiting.hostname} (${errorMessage(error)}). The app's Domains and email tab shows its progress.`,
      );
      return {};
    });
  }
}
