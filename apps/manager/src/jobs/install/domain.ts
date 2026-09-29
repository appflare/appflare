import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { appPlace } from "../../components/app-links";
import type { Database } from "../../db/client";
import { resources } from "../../db/schema";
import { GATEWAY_SETUP_PLACE, gatewayBindingName, gatewayHostname } from "../../gateway/gateway";
import { isGatewayReady, readGateway } from "../../gateway/gateway.server";
import type { ExternalDomainStatus } from "../../installs/external-domain-input";
import {
  claimExternalDomain,
  claimRefusal,
  externalDomainRef,
  releaseExternalDomain,
} from "../../installs/external-domains.server";
import type { InstallDomainInput } from "../../installs/install-input";
import { startVarsRefreshCore } from "../../installs/reconfigure.server";
import {
  ADDRESS_KINDS,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  WILDCARD_DOMAIN_KIND,
} from "../../installs/resource-kinds";
import { wildcardPattern } from "../../installs/wildcard-domain-input";
import { recordWildcardDomain } from "../../installs/wildcard-domains.server";
import { applyDomainLive, type DomainLiveResult } from "../../installs/workers-dev.server";
import { sandboxBinding } from "../../sandbox/binding";
import type { JobEnv } from "../run-job";
import { errorMessage, type JobSteps } from "../steps";
import {
  CUSTOM_DOMAIN_MAX_PROBES,
  CUSTOM_DOMAIN_MAX_PROBES_IN_PLACE,
  EXTERNAL_DOMAIN_MAX_POLLS,
  EXTERNAL_DOMAIN_MAX_POLLS_IN_PLACE,
} from "../units/domains";
import { settleUnit } from "../units/result";
import type { HealthCheck } from "./health";

/**
 * The install job's domain step, for an install whose form asked for a
 * custom, wildcard or external domain. It runs once the Worker serves and
 * its workers.dev check is done, and never fails the install: the app is
 * installed by then, so a domain that cannot be added is reported in the log
 * (with what to do) and can be added later from the app page.
 *
 * - Custom domain: one unit call attaches it, then one more asks the app
 *   through it (in its own invocation over `SELF`) until its certificate and
 *   record are live. A hostname with DNS records of its own is not replaced
 *   here; the app page asks before replacing them.
 * - Wildcard domain (an app that needs every name under one hostname): one
 *   unit call creates the proxied DNS records and Workers routes for the
 *   base and every name under it, then the base is asked like a custom
 *   domain. Records or routes that serve something else are not replaced.
 * - External domain: one unit call registers the custom hostname and routes
 *   it through the gateway, then one more waits (in its own invocation over
 *   `SELF`) for the hostname and its certificate to go active, which happens
 *   only once the owner's DNS records exist. When they do not yet, the log
 *   lists them and the app page keeps checking.
 *
 * Once the app answers through the domain, the domain is live and the
 * Worker's workers.dev URL is turned off (one more call), unless the Worker's
 * settings hold that URL; the app page's switch turns it back on.
 *
 * Each is recorded as the app page records it (kind `domain`,
 * `wildcard_domain` with its records and routes, or `custom_hostname`); a
 * hostname another app records is refused, and an external domain's name is claimed before anything is created, so a retried
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
  kind: typeof CUSTOM_DOMAIN_KIND | typeof CUSTOM_HOSTNAME_KIND | typeof WILDCARD_DOMAIN_KIND,
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
    /** The Worker's vars were filled in with its workers.dev URL (`{{workerUrl}}`). */
    settingsUseWorkerUrl: boolean;
  },
): Promise<{ servedBy: string | null }> {
  const { domain } = request;
  // Where the admin adds, retries and follows this domain.
  const domainsPlace = appPlace(
    request.installId,
    domain.kind === "external" ? "external-domains" : "domains",
    "the app's domains",
  );
  const label =
    domain.kind === "custom"
      ? "custom domain"
      : domain.kind === "wildcard"
        ? "wildcard domain"
        : "external domain";
  type Pending = {
    resourceId: string;
    zoneId: string;
    customHostnameId: string;
    hostname: string;
    target: string;
  };
  type Attached = { resourceId: string; hostname: string };
  let external: Pending | null = null;
  let custom: Attached | null = null;
  try {
    const added = await steps.run(`add ${label} ${domain.hostname}`, async ({ log, orm }) => {
      const none = { external: null as Pending | null, custom: null as Attached | null };
      const gateway = domain.kind === "external" ? await readGateway(orm) : null;
      if (domain.kind === "external" && !isGatewayReady(gateway)) {
        log.warn(
          `${domain.hostname} was not added: the external domains gateway is not set up any more. Set it up in ${GATEWAY_SETUP_PLACE}, then add the domain from ${domainsPlace}.`,
        );
        return none;
      }
      // No two installs share a hostname: another app's domain is refused
      // before anything is created.
      const taken = await heldElsewhere(orm, request.installId, domain.hostname);
      if (taken) {
        log.warn(
          `${domain.hostname} was not added: it is already a domain of another app. Remove it there first, then add it from ${domainsPlace}.`,
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
      if (result.kind === "wildcard") {
        if (!result.ok) {
          log.warn(
            `The app is installed, but ${wildcardPattern(result.hostname)} could not be set up: ${result.reason} Add it from ${domainsPlace} once that is fixed.`,
          );
          return none;
        }
        // A retried step finds what it recorded (records and routes in the same batch).
        let resourceId = await recordedId(
          orm,
          request.installId,
          WILDCARD_DOMAIN_KIND,
          result.hostname,
        );
        if (resourceId === null) {
          resourceId = await recordWildcardDomain(request.db, {
            installId: request.installId,
            attached: { hostname: result.hostname, zoneId: result.zoneId, parts: result.parts },
            at,
            newId: () => ulid(at.getTime()),
          });
        }
        if (resourceId === null) {
          throw new Error("the install is being removed, so the wildcard domain was not recorded");
        }
        log.info(
          `https://${result.hostname} and every name under it (${wildcardPattern(result.hostname)}) now reach the app.`,
        );
        return { ...none, custom: { resourceId, hostname: result.hostname } };
      }
      if (result.kind === "custom") {
        if (!result.ok) {
          log.warn(
            `${result.hostname} already has DNS records${result.records.length > 0 ? ` (${result.records.map((r) => (r.content === null ? r.type : `${r.type} ${r.content}`)).join(", ")})` : ""}, so the install did not replace them. Add the domain from ${domainsPlace}, where you can choose to replace them.`,
          );
          return none;
        }
        let resourceId = await recordedId(
          orm,
          request.installId,
          CUSTOM_DOMAIN_KIND,
          result.hostname,
        );
        if (resourceId === null) {
          resourceId = `${request.installId}:${CUSTOM_DOMAIN_KIND}:${ulid(at.getTime())}`;
          await orm.insert(resources).values({
            id: resourceId,
            install_id: request.installId,
            kind: CUSTOM_DOMAIN_KIND,
            binding: null,
            name: result.hostname,
            cf_id: result.domainId,
            created_at: at,
          });
        }
        log.info(
          `Attached https://${result.hostname} to the app; Cloudflare issues its certificate.`,
        );
        return { ...none, custom: { resourceId, hostname: result.hostname } };
      }
      if (claim === null) throw new Error("an external domain is attached only under a claim");
      if (!result.ok) {
        await releaseExternalDomain(request.db, claim.id, at);
        log.warn(
          `The app is installed, but ${result.hostname} could not be added: ${result.reason} Add it from ${domainsPlace} once that is fixed.`,
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
        ...none,
        external: {
          resourceId: claim.id,
          zoneId: result.zoneId,
          customHostnameId: result.customHostnameId,
          hostname: result.hostname,
          target,
        },
      };
    });
    external = added.external;
    custom = added.custom;
  } catch (error) {
    await steps.run(`${label} not added`, async ({ log }) => {
      log.warn(
        `The app is installed, but ${domain.hostname} could not be added: ${errorMessage(error)}. Add it from ${domainsPlace} once that is fixed.`,
      );
      return {};
    });
    return { servedBy: null };
  }
  if (custom !== null) {
    const attached = custom;
    let serves = false;
    try {
      const probed = await steps.run(`wait for ${attached.hostname}`, async ({ log }) => {
        const result = settleUnit(
          await steps.units.api.waitForCustomDomain({
            accountId: steps.accountId(),
            healthUrl: `https://${attached.hostname}${request.health.path}`,
            healthMode: request.health.mode,
            maxProbes: steps.units.remote
              ? CUSTOM_DOMAIN_MAX_PROBES
              : CUSTOM_DOMAIN_MAX_PROBES_IN_PLACE,
          }),
          log,
        );
        if (!result.serves) {
          log.info(
            `${attached.hostname} does not reach the app yet (${result.health.detail}); its certificate or DNS record may still be on the way. You can check it again from ${domainsPlace}.`,
          );
        }
        return { serves: result.serves };
      });
      serves = probed.serves;
    } catch (error) {
      await steps.run(`${attached.hostname} not checked`, async ({ log }) => {
        log.warn(
          `Could not check ${attached.hostname} (${errorMessage(error)}). You can check it again from ${domainsPlace}.`,
        );
        return {};
      });
    }
    return { servedBy: serves ? await domainLivePhase(steps, request, attached) : null };
  }
  if (external === null) return { servedBy: null };
  const waiting = external;

  let serves = false;
  try {
    const waited = await steps.run(`wait for ${waiting.hostname}`, async ({ log }) => {
      const { status, polls, serves } = settleUnit(
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
          `After ${polls} check(s), ${waiting.hostname} is still waiting for its DNS records (${[...status.errors].join(" ") || `hostname ${status.status}, certificate ${status.sslStatus ?? "unknown"}`}). Add them at the domain's DNS host: ${recordLines(status)}. Its progress shows under ${domainsPlace}.`,
        );
      }
      return { serves };
    });
    serves = waited.serves;
  } catch (error) {
    await steps.run(`${waiting.hostname} not checked`, async ({ log }) => {
      log.warn(
        `Could not check ${waiting.hostname} (${errorMessage(error)}). Its progress shows under ${domainsPlace}.`,
      );
      return {};
    });
  }
  return { servedBy: serves ? await domainLivePhase(steps, request, waiting) : null };
}

/**
 * After the install is recorded, for an install whose form asked for a
 * wildcard domain: the Worker was uploaded with `{{wildcardHostname}}`
 * filled in with the name asked for, before the domain step ran, so that a
 * domain that is set up (the usual case) needs no second deploy. When the
 * step did not set it up, the Worker names a hostname it does not have, so
 * this starts the settings change the app page starts after adding or
 * removing the domain: it deploys the settings again from what is recorded,
 * which is no wildcard domain. It never fails the install, which is recorded
 * by now; a refusal (another job runs, the sandbox Worker is not connected)
 * is logged with what to do.
 */
export async function unservedWildcardPhase(
  steps: JobSteps,
  env: Pick<JobEnv, "DB" | "JOBS" | "SANDBOX">,
  request: { installId: string; hostname: string },
): Promise<void> {
  const pattern = wildcardPattern(request.hostname);
  const later = `Save ${appPlace(request.installId, "settings", "the app's settings")} once to fill them in without ${pattern}, or add the domain from ${appPlace(request.installId, "domains", "the app's domains")}.`;
  try {
    await steps.run(`settings without ${pattern}`, async ({ log, orm }) => {
      if (
        (await recordedId(orm, request.installId, WILDCARD_DOMAIN_KIND, request.hostname)) !== null
      ) {
        return {};
      }
      const jobs = env.JOBS;
      if (jobs === undefined) {
        log.warn(
          `The app's settings may still name ${request.hostname}, which it does not serve. ${later}`,
        );
        return {};
      }
      try {
        const started = await startVarsRefreshCore(
          {
            db: env.DB,
            sandboxConnected: sandboxBinding(env) !== undefined,
            createJob: (id, params) => jobs.create({ id, params }),
            now: () => new Date(steps.now()),
            // Nobody clicked: the jobs list shows it as automatic.
            startedBy: "schedule",
          },
          request.installId,
          ["wildcardHostname"],
        );
        if (started !== null) {
          log.info(
            `The app's settings named ${request.hostname}, which it does not serve, so a settings change (job ${started.jobId}) deploys them again without it.`,
          );
        }
      } catch (error) {
        log.warn(
          `The app's settings name ${request.hostname}, which it does not serve, and could not be deployed again (${errorMessage(error)}). ${later}`,
        );
      }
      return {};
    });
  } catch (error) {
    await steps
      .run(`settings without ${pattern} not checked`, async ({ log }) => {
        log.warn(`Could not check the app's settings (${errorMessage(error)}). ${later}`);
        return {};
      })
      // Only the log line is lost; the install is recorded either way.
      .catch(() => undefined);
  }
}

/**
 * After the install is recorded, for an install whose domain step turned
 * workers.dev off: the Worker was uploaded with `{{appUrl}}` filled in with
 * its workers.dev URL, where it was served then, so this starts the settings
 * change the app page starts when the app's address moves: it deploys the
 * settings again, filled in with the domain. Nothing starts when no setting
 * uses the address. It never fails the install; a refusal is logged with
 * what to do.
 */
export async function servedAddressPhase(
  steps: JobSteps,
  env: Pick<JobEnv, "DB" | "JOBS" | "SANDBOX">,
  request: { installId: string; hostname: string },
): Promise<void> {
  const later = `Save ${appPlace(request.installId, "settings", "the app's settings")} once to fill in https://${request.hostname}.`;
  await steps
    .run(`settings for https://${request.hostname}`, async ({ log }) => {
      const jobs = env.JOBS;
      // Without the job Workflow binding no job can start; the app page's
      // settings refresh then follows the address instead.
      if (jobs === undefined) return {};
      try {
        const started = await startVarsRefreshCore(
          {
            db: env.DB,
            sandboxConnected: sandboxBinding(env) !== undefined,
            createJob: (id, params) => jobs.create({ id, params }),
            now: () => new Date(steps.now()),
            // Nobody clicked: the jobs list shows it as automatic.
            startedBy: "schedule",
          },
          request.installId,
          ["appUrl"],
        );
        if (started !== null) {
          log.info(
            `The app's settings use its address, which is https://${request.hostname} now, so a settings change (job ${started.jobId}) deploys them again with it.`,
          );
        }
      } catch (error) {
        log.warn(
          `The app's settings use its address and could not be deployed again with https://${request.hostname} (${errorMessage(error)}). ${later}`,
        );
      }
      return {};
    })
    // Only the log line is lost; the install is recorded either way.
    .catch(() => undefined);
}

/** The job log line for what a domain going live did to workers.dev. */
export function domainLiveMessage(
  installId: string,
  hostname: string,
  result: DomainLiveResult,
): string {
  const workersDev = appPlace(installId, "workers-dev", "Serve on workers.dev");
  if (result.turnedOff) {
    return `Turned off the workers.dev URL: https://${hostname} serves the app. Turn it back on with ${workersDev} on the app's page.`;
  }
  switch (result.kept) {
    case "settings":
      return `https://${hostname} serves the app. The workers.dev URL stays on because the app's settings use it; change ${appPlace(installId, "settings", "the app's settings")} to use the app's address, then turn off ${workersDev}.`;
    case "manual":
      return `https://${hostname} serves the app. The workers.dev URL stays as an admin set it.`;
    default:
      return `https://${hostname} serves the app.`;
  }
}

/**
 * The domain answered as the app: it is recorded as live and, unless an
 * admin set the switch or the Worker's settings hold its workers.dev URL,
 * workers.dev is turned off (version previews stay on). A failure here
 * leaves workers.dev on, which never fails the install. Returns the hostname
 * when workers.dev was turned off, else null.
 */
async function domainLivePhase(
  steps: JobSteps,
  request: { db: D1Database; installId: string; settingsUseWorkerUrl: boolean },
  domain: { resourceId: string; hostname: string },
): Promise<string | null> {
  try {
    const done = await steps.run(`${domain.hostname} is live`, async ({ log, cf }) => {
      const result = await applyDomainLive(
        { db: request.db, api: async () => cf(), now: () => new Date(steps.now()) },
        {
          installId: request.installId,
          resourceId: domain.resourceId,
          hostname: domain.hostname,
          job: { settingsUseWorkerUrl: request.settingsUseWorkerUrl },
        },
      );
      log.info(domainLiveMessage(request.installId, domain.hostname, result));
      return { turnedOff: result.turnedOff };
    });
    return done.turnedOff ? domain.hostname : null;
  } catch (error) {
    await steps.run(`workers.dev left on for ${domain.hostname}`, async ({ log }) => {
      log.warn(
        `https://${domain.hostname} serves the app, but the workers.dev URL could not be turned off (${errorMessage(error)}). Turn it off with ${appPlace(request.installId, "workers-dev", "Serve on workers.dev")} on the app's page.`,
      );
      return {};
    });
    return null;
  }
}
