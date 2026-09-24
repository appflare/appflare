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

/** A short phrase for the domain's state, for its badge. */
export function externalDomainPhase(
  status: Pick<ExternalDomainStatus, "status" | "sslStatus" | "active">,
): {
  label: string;
  tone: "success" | "pending" | "problem";
} {
  if (status.active) return { label: "Active", tone: "success" };
  if (status.status === "missing") return { label: "Missing at Cloudflare", tone: "problem" };
  if (["blocked", "moved", "deleted", "pending_deletion"].includes(status.status)) {
    return { label: status.status.replace(/_/g, " "), tone: "problem" };
  }
  if (status.status === "active") return { label: "Issuing certificate", tone: "pending" };
  return { label: "Waiting for DNS records", tone: "pending" };
}
