import type { FetchLike } from "@appflare/cf-api";
import { z } from "zod";
import { GATEWAY_SETUP_PLACE, gatewayHostname } from "../../gateway/gateway";
import { GatewayError, gatewayStateSchema } from "../../gateway/gateway.server";
import { checkHostnameInZone } from "../../installs/custom-domain-input";
import {
  attachCheckedDomain,
  type ConflictingRecord,
  CustomDomainError,
  readZone,
} from "../../installs/custom-domains.server";
import type { ExternalDomainStatus } from "../../installs/external-domain-input";
import {
  attachExternalDomain,
  ExternalDomainError,
  externalDomainStatus,
} from "../../installs/external-domains.server";
import { installDomainInput } from "../../installs/install-input";
import {
  attachWildcardDomain,
  checkWildcardRequest,
  WildcardDomainError,
  type WildcardPart,
} from "../../installs/wildcard-domains.server";
import { domainServesApp } from "../../installs/workers-dev.server";
import { isNotFound, JobError } from "../errors";
import {
  type HealthMode,
  type HealthSettlement,
  probeHealth,
  settleHealthProbe,
} from "../install/health";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * The job units behind the install job's domain step, each in an invocation
 * of its own when the `SELF` binding exists:
 *
 * - `attachDomain`: a custom domain (zone read, domain list, DNS read,
 *   attach: 4 requests), an external domain (zone list, custom hostname
 *   list and create, gateway bindings read, version patch and deployment,
 *   routing entry: about 7), or a wildcard domain (zone read, domain list,
 *   route list, two DNS reads, one read of the names under the base per 100
 *   records, two records and two routes: 10 for most zones, plus up to four
 *   deletes when a create fails part way).
 * - `waitForExternalDomain`: reads the custom hostname every few seconds
 *   until it and its certificate are active, then asks the app through it
 *   (up to 24 reads and 3 probes).
 * - `waitForCustomDomain`: asks the app through a newly attached custom
 *   domain every few seconds until it answers (up to 24 probes), since its
 *   certificate and DNS record take a moment.
 *
 * Refusals (a name in another zone, a missing permission, Cloudflare for
 * SaaS off) end the step without retries; the install job reports them and
 * still finishes, since the app itself is installed by then.
 */

const gatewayInput = gatewayStateSchema.extend({
  kvId: z.string().min(1),
  readyAt: z.string().min(1),
});

export const attachDomainInputSchema = z.object({
  accountId: z.string().min(1),
  installId: z.string().min(1),
  workerName: z.string().min(1),
  domain: installDomainInput,
  /** The ready gateway, for an external domain. */
  gateway: gatewayInput.nullable(),
  /** When the install claimed an external domain's name (its row, epoch ms). */
  claimedAt: z.number().int().nonnegative().optional(),
});
export type AttachDomainInput = z.infer<typeof attachDomainInputSchema>;

export type AttachDomainResult =
  | { kind: "custom"; ok: true; hostname: string; domainId: string }
  | { kind: "custom"; ok: false; hostname: string; records: ConflictingRecord[] }
  | {
      kind: "external";
      ok: true;
      hostname: string;
      zoneId: string;
      customHostnameId: string;
      binding: string;
      created: boolean;
      status: ExternalDomainStatus;
    }
  /** Refused before anything was created (the job gives up its claim). */
  | { kind: "external"; ok: false; hostname: string; reason: string }
  | { kind: "wildcard"; ok: true; hostname: string; zoneId: string; parts: WildcardPart[] }
  /**
   * Not set up: refused before anything was created, or a create was refused
   * and what was created was removed again (the reason says which, and what
   * is left when removing it failed). A failure that may pass is not this:
   * it is thrown once the zone is as it was, so the step retries it.
   */
  | { kind: "wildcard"; ok: false; hostname: string; reason: string };

/** A refusal becomes final: retrying would be refused the same way. */
function refusal(error: unknown): unknown {
  if (
    error instanceof CustomDomainError ||
    error instanceof ExternalDomainError ||
    error instanceof GatewayError
  ) {
    return new JobError(error.message);
  }
  return error;
}

export function runAttachDomain(
  env: UnitEnv,
  deps: UnitDeps,
  input: AttachDomainInput,
): Promise<UnitResult<AttachDomainResult>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    const api = cf();
    try {
      const { domain } = input;
      if (domain.kind === "wildcard") {
        try {
          const { zone, hostname, wholeDomain } = await checkWildcardRequest(api, {
            zoneId: domain.zoneId,
            hostname: domain.hostname,
            ...(domain.wholeDomain === undefined ? {} : { wholeDomain: domain.wholeDomain }),
          });
          const attached = await attachWildcardDomain(api, {
            zone,
            hostname,
            workerName: input.workerName,
            wholeDomain,
          });
          log.info(
            `Set up ${hostname} and every name under it for "${input.workerName}": ${attached.parts.map((p) => `${p.created ? "created" : p.owned ? "found" : "used the existing"} ${p.name}`).join(", ")}.`,
          );
          const byHand = attached.parts.filter((p) => !p.owned).map((p) => p.name);
          if (byHand.length > 0) {
            const one = byHand.length === 1;
            log.info(
              `The route${one ? "" : "s"} ${byHand.join(" and ")} already sent requests to "${input.workerName}" and ${one ? "was" : "were"} not made by Appflare, so removing the domain leaves ${one ? "it" : "them"} in place.`,
            );
          }
          return {
            kind: "wildcard",
            ok: true,
            hostname,
            zoneId: attached.zoneId,
            parts: attached.parts,
          };
        } catch (error) {
          if (error instanceof WildcardDomainError) {
            return {
              kind: "wildcard",
              ok: false,
              hostname: domain.hostname,
              reason: error.message,
            };
          }
          throw error;
        }
      }
      if (domain.kind === "custom") {
        const zone = await readZone(api, domain.zoneId);
        const checked = checkHostnameInZone(domain.hostname, zone.name);
        if (!checked.ok) throw new CustomDomainError(checked.error);
        const attached = await attachCheckedDomain(api, {
          zone,
          hostname: checked.hostname,
          workerName: input.workerName,
          overrideExistingDnsRecord: false,
        });
        if (!attached.ok) {
          return {
            kind: "custom",
            ok: false,
            hostname: attached.hostname,
            records: attached.records,
          };
        }
        log.info(`Attached custom domain ${attached.hostname} to "${input.workerName}".`);
        return {
          kind: "custom",
          ok: true,
          hostname: attached.hostname,
          domainId: attached.domainId,
        };
      }
      if (input.gateway === null || input.claimedAt === undefined) {
        throw new ExternalDomainError(
          `External domains need the gateway and a claimed name; it is not set up (see ${GATEWAY_SETUP_PLACE}).`,
        );
      }
      let attached: Awaited<ReturnType<typeof attachExternalDomain>>;
      try {
        attached = await attachExternalDomain(api, {
          gateway: input.gateway,
          installId: input.installId,
          workerName: input.workerName,
          hostname: domain.hostname,
          method: domain.validation,
          claimedAt: input.claimedAt,
        });
      } catch (error) {
        if (error instanceof ExternalDomainError || error instanceof GatewayError) {
          return { kind: "external", ok: false, hostname: domain.hostname, reason: error.message };
        }
        throw error;
      }
      log.info(
        `${attached.created ? "Registered" : "Found"} external domain ${attached.hostname} on ${input.gateway.zoneName} and routed it to "${input.workerName}".`,
      );
      return {
        kind: "external",
        ok: true,
        hostname: attached.hostname,
        zoneId: attached.zoneId,
        customHostnameId: attached.customHostnameId,
        binding: attached.binding,
        created: attached.created,
        status: externalDomainStatus(
          attached.customHostname,
          gatewayHostname(input.gateway.zoneName),
          new Date((deps.now ?? Date.now)()),
        ),
      };
    } catch (error) {
      throw refusal(error);
    }
  });
}

/** Between two reads of a custom hostname that is not active yet. */
export const EXTERNAL_DOMAIN_POLL_MS = 5_000;
/** Reads at most, over `SELF`: about two minutes, what a pre-made CNAME needs (80 s live). */
export const EXTERNAL_DOMAIN_MAX_POLLS = 24;
/** Reads at most in the job's own invocation (no `SELF`). */
export const EXTERNAL_DOMAIN_MAX_POLLS_IN_PLACE = 3;
/** Probes through the domain once it is active (a new route can answer 1104 for a few seconds). */
const HEALTH_PROBES = 3;
/** Between two probes through a domain that does not reach the app yet. */
const DOMAIN_PROBE_MS = 5_000;

export const waitForExternalDomainInputSchema = z.object({
  accountId: z.string().min(1),
  zoneId: z.string().min(1),
  customHostnameId: z.string().min(1),
  /** The gateway's hostname, for the records shown while it is pending. */
  target: z.string().min(1),
  /** The app's health URL on the domain. */
  healthUrl: z.string().url(),
  healthMode: z.enum(["default", "status-only"]),
  maxPolls: z.number().int().min(1).max(EXTERNAL_DOMAIN_MAX_POLLS),
});
export type WaitForExternalDomainInput = z.infer<typeof waitForExternalDomainInputSchema>;

export interface WaitForExternalDomainResult {
  status: ExternalDomainStatus;
  polls: number;
  /** The app itself answered through the domain (not an edge error page). */
  serves: boolean;
}

/**
 * Probes `url` until the app answers through it (`domainServesApp`), every
 * `gapMs`, at most `max` times. A new domain answers with a TLS failure or an
 * edge error page until its certificate and record are live.
 */
async function probeUntilServed(
  fetch: FetchLike,
  sleep: (ms: number) => Promise<void>,
  input: { url: string; mode: HealthMode; max: number; gapMs: number },
): Promise<{ settled: HealthSettlement; serves: boolean; probes: number }> {
  for (let probes = 1; ; probes++) {
    const probe = await probeHealth(fetch, input.url);
    const serves = domainServesApp(probe, input.mode);
    if (serves || probes >= input.max) {
      return { settled: settleHealthProbe(probe, input.mode), serves, probes };
    }
    await sleep(input.gapMs);
  }
}

export function runWaitForExternalDomain(
  env: UnitEnv,
  deps: UnitDeps,
  input: WaitForExternalDomainInput,
): Promise<UnitResult<WaitForExternalDomainResult>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  return runUnit(env, deps, input.accountId, async ({ log, cf, fetch }) => {
    const api = cf();
    for (let poll = 1; ; poll++) {
      let status: ExternalDomainStatus;
      try {
        status = externalDomainStatus(
          await api.customHostnames.get(input.zoneId, input.customHostnameId),
          input.target,
          new Date(now()),
        );
      } catch (error) {
        if (isNotFound(error)) {
          throw new JobError("the custom hostname is gone at Cloudflare; add the domain again");
        }
        throw error;
      }
      if (status.active) {
        const { settled, serves } = await probeUntilServed(fetch, sleep, {
          url: input.healthUrl,
          mode: input.healthMode,
          max: HEALTH_PROBES,
          gapMs: 3_000,
        });
        status.health = { ...settled, url: input.healthUrl };
        log.info(
          `${status.hostname} is active with its certificate; the app answered ${settled.detail}.`,
        );
        return { status, polls: poll, serves };
      }
      if (poll >= input.maxPolls) {
        log.info(
          `${status.hostname} is not active yet (hostname ${status.status}, certificate ${status.sslStatus ?? "unknown"}).`,
        );
        return { status, polls: poll, serves: false };
      }
      await sleep(EXTERNAL_DOMAIN_POLL_MS);
    }
  });
}

/** Probes at most, over `SELF`: about two minutes, for the certificate and DNS record. */
export const CUSTOM_DOMAIN_MAX_PROBES = 24;
/** Probes at most in the job's own invocation (no `SELF`). */
export const CUSTOM_DOMAIN_MAX_PROBES_IN_PLACE = 3;

export const waitForCustomDomainInputSchema = z.object({
  accountId: z.string().min(1),
  /** The app's health URL on the domain. */
  healthUrl: z.string().url(),
  healthMode: z.enum(["default", "status-only"]),
  maxProbes: z.number().int().min(1).max(CUSTOM_DOMAIN_MAX_PROBES),
});
export type WaitForCustomDomainInput = z.infer<typeof waitForCustomDomainInputSchema>;

export interface WaitForCustomDomainResult {
  health: HealthSettlement & { url: string };
  probes: number;
  /** The app itself answered through the domain (not an edge error page). */
  serves: boolean;
}

/** Asks the app through a newly attached custom domain until it answers. */
export function runWaitForCustomDomain(
  env: UnitEnv,
  deps: UnitDeps,
  input: WaitForCustomDomainInput,
): Promise<UnitResult<WaitForCustomDomainResult>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return runUnit(env, deps, input.accountId, async ({ log, fetch }) => {
    const { settled, serves, probes } = await probeUntilServed(fetch, sleep, {
      url: input.healthUrl,
      mode: input.healthMode,
      max: input.maxProbes,
      gapMs: DOMAIN_PROBE_MS,
    });
    log.info(
      serves
        ? `${input.healthUrl} reached the app (${settled.detail}).`
        : `${input.healthUrl} did not reach the app after ${probes} probe(s) (${settled.detail}).`,
    );
    return { health: { ...settled, url: input.healthUrl }, probes, serves };
  });
}
