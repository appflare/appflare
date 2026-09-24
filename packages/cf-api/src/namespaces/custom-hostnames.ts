import type { HttpApi } from "../http";

const enc = encodeURIComponent;

/**
 * Cloudflare for SaaS custom hostnames on a zone of the account (the "SaaS
 * zone"): a hostname in someone else's DNS that Cloudflare serves through
 * this zone, with a certificate it issues once the hostname is validated.
 * Every call here needs Zone > SSL and Certificates: Edit (read for the
 * reads) on the zone, and Cloudflare for SaaS switched on for it, which only
 * a person can do in the dashboard (it asks for a payment method).
 *
 * How Cloudflare refuses (observed live on free zones, 2026-09-24):
 * - SaaS off: the list, the quota and a create answer 403 code 1404 ("No
 *   quota has been allocated for this zone or for this account"); the
 *   fallback origin answers 401 code 1456.
 * - Token without SSL and Certificates: 403 code 10000 ("Authentication
 *   error") on every call here.
 * - A hostname already registered on any zone: 409 code 1406.
 * - No fallback origin set yet: its read answers 404 code 1551.
 */

/** SaaS is not switched on for the zone (403 on the list, the quota and a create). */
export const CUSTOM_HOSTNAMES_NOT_ENABLED = 1404;
/** SaaS is not switched on for the zone, as the fallback origin calls say it (401). */
export const FALLBACK_ORIGIN_NOT_GRANTED = 1456;
/** The hostname is already a custom hostname (of this or another zone). */
export const CUSTOM_HOSTNAME_DUPLICATE = 1406;
/** The zone has no fallback origin. */
export const FALLBACK_ORIGIN_NOT_SET = 1551;

/**
 * How the certificate's domain control is validated: `http` answers
 * Cloudflare's challenge itself once the hostname's CNAME points at the zone;
 * `txt` asks the owner to add `_acme-challenge` TXT records first, so the
 * certificate can be ready before any traffic moves.
 */
export type CustomHostnameSslMethod = "http" | "txt";

/** One record of `ssl.validation_records` (fields depend on the method). */
export interface SslValidationRecord {
  status?: string;
  txt_name?: string;
  txt_value?: string;
  http_url?: string;
  http_body?: string;
  cname?: string;
  cname_target?: string;
  emails?: string[];
}

/** One entry of `GET /zones/{zone_id}/custom_hostnames` (fields the manager reads). */
export interface CustomHostname {
  id: string;
  hostname: string;
  /**
   * The hostname's own status: `pending` until it is validated, then
   * `active`; also `moved`, `deleted`, `blocked`, `pending_deletion`,
   * `test_pending`, ...
   */
  status: string;
  ssl?: {
    id?: string;
    /**
     * `initializing`, `pending_validation`, `pending_issuance`,
     * `pending_deployment`, `active`, `pending_deletion`, `deleted`, ...
     */
    status?: string;
    method?: string;
    type?: string;
    certificate_authority?: string;
    validation_records?: SslValidationRecord[];
    validation_errors?: Array<{ message: string }>;
  };
  /** The TXT record that proves ownership before any CNAME exists. */
  ownership_verification?: { type?: string; name?: string; value?: string };
  /** The same proof over HTTP. */
  ownership_verification_http?: { http_url?: string; http_body?: string };
  /** Why the hostname is not active yet, in Cloudflare's words. */
  verification_errors?: string[];
  created_at?: string;
}

/** `GET /zones/{zone_id}/custom_hostnames/quota` (not in the public reference; the `cf` CLI uses it). */
export interface CustomHostnameQuota {
  allocated?: number;
  used?: number;
  exceeded?: boolean;
  hard_cap?: number;
}

/** The zone's fallback origin: where custom hostnames go when nothing else serves them. */
export interface FallbackOrigin {
  origin?: string;
  /** `initializing`, `pending_deployment`, `active`, `pending_deletion`, `deleted`. */
  status?: string;
  errors?: string[];
}

export interface CreateCustomHostnameArgs {
  hostname: string;
  sslMethod: CustomHostnameSslMethod;
}

export function createCustomHostnames(http: HttpApi) {
  const base = (zoneId: string) => `/zones/${enc(zoneId)}/custom_hostnames`;
  return {
    /** `GET /zones/{zone_id}/custom_hostnames/quota`: answers only when SaaS is on. */
    quota(zoneId: string): Promise<CustomHostnameQuota> {
      return http.result("GET", `${base(zoneId)}/quota`);
    },

    /** `GET /zones/{zone_id}/custom_hostnames?hostname=`, every page. */
    list(zoneId: string, args: { hostname?: string } = {}): Promise<CustomHostname[]> {
      return http.list<CustomHostname>("GET", base(zoneId), {
        perPage: 50,
        query: { hostname: args.hostname },
      });
    },

    /** `GET /zones/{zone_id}/custom_hostnames/{id}`. */
    get(zoneId: string, id: string): Promise<CustomHostname> {
      return http.result("GET", `${base(zoneId)}/${enc(id)}`);
    },

    /**
     * `POST /zones/{zone_id}/custom_hostnames` with `{ hostname, ssl: {
     * method, type: "dv" } }`. The answer already carries the ownership TXT
     * record; the certificate's validation records follow within seconds.
     */
    create(zoneId: string, args: CreateCustomHostnameArgs): Promise<CustomHostname> {
      return http.result("POST", base(zoneId), {
        json: { hostname: args.hostname, ssl: { method: args.sslMethod, type: "dv" } },
      });
    },

    /** `DELETE /zones/{zone_id}/custom_hostnames/{id}`: visitors get an error page at once. */
    delete(zoneId: string, id: string): Promise<unknown> {
      return http.result("DELETE", `${base(zoneId)}/${enc(id)}`);
    },

    /** `GET /zones/{zone_id}/custom_hostnames/fallback_origin` (404 code 1551 when none is set). */
    getFallbackOrigin(zoneId: string): Promise<FallbackOrigin> {
      return http.result("GET", `${base(zoneId)}/fallback_origin`);
    },

    /** `PUT /zones/{zone_id}/custom_hostnames/fallback_origin` with `{ origin }`. */
    setFallbackOrigin(zoneId: string, origin: string): Promise<FallbackOrigin> {
      return http.result("PUT", `${base(zoneId)}/fallback_origin`, { json: { origin } });
    },

    /** `DELETE /zones/{zone_id}/custom_hostnames/fallback_origin`. */
    deleteFallbackOrigin(zoneId: string): Promise<unknown> {
      return http.result("DELETE", `${base(zoneId)}/fallback_origin`);
    },
  };
}
