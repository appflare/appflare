import { z } from "zod";
import type { HealthStatus } from "../db/schema";
import type { OwnerRecord, ValidationMethod } from "../gateway/gateway";
import { VALIDATION_METHODS } from "../gateway/gateway";

/**
 * Client-safe input and answers of the external domain server functions
 * (app page, Domains and email tab), and how a custom hostname's state reads
 * in the UI.
 */

const installId = z.string().min(1).max(64);

export const addExternalDomainInput = z.object({
  installId,
  hostname: z.string().min(1).max(300),
  validation: z.enum(VALIDATION_METHODS),
});
export type AddExternalDomainInput = z.infer<typeof addExternalDomainInput>;

export const externalDomainInput = z.object({
  installId,
  /** The `resources` row of the external domain. */
  resourceId: z.string().min(1).max(200),
});

export const externalDomainStatusInput = externalDomainInput.extend({
  /** Also probe the app through the domain once it is active. */
  probe: z.boolean().optional(),
});

/** What the add dialog and the install form need to check a hostname before sending it. */
export interface ExternalDomainOptions {
  /** The gateway, when it is ready; null otherwise (Settings > Domains sets it up). */
  gateway: { zoneName: string; hostname: string } | null;
  /** Names of every zone in the account, which a custom domain serves instead. */
  accountZones: string[];
}

/** One external domain as Cloudflare reports it now. */
export interface ExternalDomainStatus {
  hostname: string;
  /** The custom hostname's status (`pending`, `active`, `moved`, ...); `missing` when Cloudflare has none. */
  status: string;
  /** The certificate's status (`initializing`, `pending_validation`, ..., `active`); null when unknown. */
  sslStatus: string | null;
  method: ValidationMethod;
  /** Hostname and certificate are both active. */
  active: boolean;
  /** What the domain's owner adds, from Cloudflare's answer. */
  records: OwnerRecord[];
  /** Why it is not active yet, in Cloudflare's words. */
  errors: string[];
  /** A probe of the app through the domain, when asked for and active. */
  health: { status: HealthStatus; detail: string; url: string } | null;
  /** ISO 8601 */
  checkedAt: string;
}

/** Custom hostname states in which it will not serve without someone acting. */
const FAILED_HOSTNAME_STATUSES = ["blocked", "moved", "deleted", "pending_deletion"];

/**
 * Certificate states in which Cloudflare has stopped trying: validation or
 * issuance timed out (it is retried only when someone asks), or the
 * certificate expired or was deleted.
 */
const FAILED_SSL_STATUSES = [
  "initializing_timed_out",
  "validation_timed_out",
  "issuance_timed_out",
  "deployment_timed_out",
  "expired",
  "deleted",
];

/** A short phrase for the domain's state, for its badge. */
export function externalDomainPhase(
  status: Pick<ExternalDomainStatus, "status" | "sslStatus" | "active">,
): {
  label: string;
  tone: "success" | "pending" | "problem";
} {
  if (status.active) return { label: "Active", tone: "success" };
  if (status.status === "missing") return { label: "Missing at Cloudflare", tone: "problem" };
  if (FAILED_HOSTNAME_STATUSES.includes(status.status)) {
    return { label: status.status.replace(/_/g, " "), tone: "problem" };
  }
  if (status.sslStatus !== null && FAILED_SSL_STATUSES.includes(status.sslStatus)) {
    return { label: `certificate ${status.sslStatus.replace(/_/g, " ")}`, tone: "problem" };
  }
  if (status.status === "active") return { label: "Issuing certificate", tone: "pending" };
  return { label: "Waiting for DNS records", tone: "pending" };
}

/**
 * Why a domain whose phase is a problem does not serve, as one sentence of
 * Appflare's own (Cloudflare's error text is not repeated: it can be long,
 * and it goes into notifications). Null when the phase is not a problem.
 */
export function externalDomainProblem(
  status: Pick<ExternalDomainStatus, "status" | "sslStatus" | "active">,
): string | null {
  if (externalDomainPhase(status).tone !== "problem") return null;
  if (status.status === "missing") {
    return "Cloudflare no longer has a custom hostname for it; remove the domain on the app's page and add it again.";
  }
  if (FAILED_HOSTNAME_STATUSES.includes(status.status)) {
    return `Cloudflare reports the hostname as ${status.status.replace(/_/g, " ")}.`;
  }
  if (status.sslStatus === "expired") {
    return "Its certificate expired and was not renewed. Check that its DNS records are still in place, then remove the domain and add it again.";
  }
  return `Its certificate was not issued: Cloudflare reports it as ${(status.sslStatus ?? "").replace(/_/g, " ")}. Remove the domain and add it again once its DNS records are in place.`;
}
