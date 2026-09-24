import { z } from "zod";
import { gatewayHostname } from "../../gateway/gateway";
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
import { isNotFound, JobError } from "../errors";
import { probeHealth, settleHealthProbe } from "../install/health";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * The job units behind the install job's domain step, each in an invocation
 * of its own when the `SELF` binding exists:
 *
 * - `attachDomain`: a custom domain (zone read, domain list, DNS read,
 *   attach: 4 requests) or an external domain (zone list, custom hostname
 *   list and create, gateway bindings read, version patch and deployment,
 *   routing entry: about 7).
 * - `waitForExternalDomain`: reads the custom hostname every few seconds
 *   until it and its certificate are active, then asks the app through it
 *   (up to 24 reads and 3 probes).
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
  | { kind: "external"; ok: false; hostname: string; reason: string };

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
          "External domains need the gateway and a claimed name; it is not set up (Settings, Domains).",
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
        let settled = settleHealthProbe(
          await probeHealth(fetch, input.healthUrl),
          input.healthMode,
        );
        for (let probe = 2; probe <= HEALTH_PROBES && settled.status !== "verified"; probe++) {
          await sleep(3_000);
          settled = settleHealthProbe(await probeHealth(fetch, input.healthUrl), input.healthMode);
        }
        status.health = { ...settled, url: input.healthUrl };
        log.info(
          `${status.hostname} is active with its certificate; the app answered ${settled.detail}.`,
        );
        return { status, polls: poll };
      }
      if (poll >= input.maxPolls) {
        log.info(
          `${status.hostname} is not active yet (hostname ${status.status}, certificate ${status.sslStatus ?? "unknown"}).`,
        );
        return { status, polls: poll };
      }
      await sleep(EXTERNAL_DOMAIN_POLL_MS);
    }
  });
}
