import type { HttpApi } from "../http";

const enc = encodeURIComponent;

/**
 * Workers custom domains: a hostname in one of the account's zones that serves
 * a Worker, with a DNS record and a certificate Cloudflare manages. Attaching
 * needs Workers Scripts: Edit plus Zone > Workers Routes: Edit on the zone.
 *
 * Errors Cloudflare answers on attach: code 100117 when the hostname already
 * has DNS records Cloudflare does not manage for a Worker (retry with
 * `override_existing_dns_record` to replace them), 100116 when the hostname is
 * already a custom domain of another Worker (`override_existing_origin` moves
 * it).
 */

/** Attach refused: the hostname has other DNS records. */
export const DOMAIN_DNS_RECORD_CONFLICT = 100117;
/** Attach refused: the hostname already serves another Worker. */
export const DOMAIN_ORIGIN_CONFLICT = 100116;

/** One entry of `GET /accounts/{id}/workers/domains`. */
export interface WorkerDomain {
  id: string;
  hostname: string;
  /** The Worker it serves. */
  service: string;
  zone_id: string;
  zone_name: string;
  /** Deprecated by Cloudflare; always `production` for Workers without environments. */
  environment?: string;
  cert_id?: string;
}

export interface ListWorkerDomainsArgs {
  hostname?: string;
  /** The Worker name. */
  service?: string;
  zoneId?: string;
  zoneName?: string;
}

export interface AttachWorkerDomainArgs {
  zoneId: string;
  hostname: string;
  /** The Worker name. */
  service: string;
  /** Replace DNS records at the hostname that Cloudflare does not manage for a Worker. */
  overrideExistingDnsRecord?: boolean;
}

export function createWorkerDomains(http: HttpApi) {
  return {
    /**
     * `GET /accounts/{id}/workers/domains`. The endpoint answers every match in
     * one page (it reports `per_page: 0` and no page count).
     */
    listDomains(args: ListWorkerDomainsArgs = {}): Promise<WorkerDomain[]> {
      return http.result("GET", http.acct("/workers/domains"), {
        query: {
          hostname: args.hostname,
          service: args.service,
          zone_id: args.zoneId,
          zone_name: args.zoneName,
        },
      });
    },

    /**
     * `PUT /accounts/{id}/workers/domains` with `{ zone_id, hostname, service,
     * environment: "production", override_existing_dns_record? }`. Attaching a
     * hostname the Worker already has is a no-op that returns the domain.
     */
    attachDomain(args: AttachWorkerDomainArgs): Promise<WorkerDomain> {
      return http.result("PUT", http.acct("/workers/domains"), {
        json: {
          zone_id: args.zoneId,
          hostname: args.hostname,
          service: args.service,
          environment: "production",
          ...(args.overrideExistingDnsRecord === undefined
            ? {}
            : { override_existing_dns_record: args.overrideExistingDnsRecord }),
        },
      });
    },

    /** `DELETE /accounts/{id}/workers/domains/{domain_id}`. */
    detachDomain(domainId: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/workers/domains/${enc(domainId)}`));
    },
  };
}
