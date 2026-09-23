import type { HttpApi } from "../http";

const enc = encodeURIComponent;

/**
 * Zones and the zone-scoped reads custom domains need. Zone calls live under
 * `/zones/{zone_id}`, not under the account. A token without Zone: Read gets
 * an empty zone list (not an error), and a zone-scoped read it lacks the
 * permission for answers 403 with code 10000.
 */

/** Zone statuses Cloudflare reports; only `active` zones serve traffic. */
export type ZoneStatus =
  | "initializing"
  | "pending"
  | "active"
  | "moved"
  | "deactivated"
  | "read only"
  | (string & {});

/** One entry of `GET /zones` (fields the manager reads). */
export interface Zone {
  id: string;
  /** The domain, e.g. `example.com`. */
  name: string;
  status: ZoneStatus;
  /** `full`, `partial`, `secondary`, `internal`. */
  type?: string;
  paused?: boolean;
  account?: { id: string; name?: string };
}

export interface ListZonesArgs {
  /** Only zones of this account (`account.id`). */
  accountId?: string;
  /** Only zones in this status. */
  status?: ZoneStatus;
  /** Only the zone with exactly this name. */
  name?: string;
}

/** One entry of `GET /zones/{zone_id}/dns_records` (fields the manager reads). */
export interface DnsRecord {
  id: string;
  /** `A`, `AAAA`, `CNAME`, `TXT`, ... */
  type: string;
  /** The full record name, in Punycode. */
  name: string;
  content?: string;
  proxied?: boolean;
}

/** One entry of `GET /zones/{zone_id}/workers/routes`. */
export interface WorkerRoute {
  id: string;
  pattern: string;
  script?: string;
}

/** `GET /zones` pages at most 50 zones per page. */
const ZONES_PER_PAGE = 50;

export function createZones(http: HttpApi) {
  return {
    /** `GET /zones`, every page, optionally filtered. */
    listZones(args: ListZonesArgs = {}): Promise<Zone[]> {
      return http.list<Zone>("GET", "/zones", {
        perPage: ZONES_PER_PAGE,
        query: {
          "account.id": args.accountId,
          status: args.status,
          name: args.name,
        },
      });
    },

    /** `GET /zones/{zone_id}`. */
    getZone(zoneId: string): Promise<Zone> {
      return http.result("GET", `/zones/${enc(zoneId)}`);
    },

    /**
     * `GET /zones/{zone_id}/dns_records?name.exact=<name>`: the records at
     * exactly this name (case-insensitive). Needs DNS: Read.
     */
    listDnsRecords(zoneId: string, args: { name: string }): Promise<DnsRecord[]> {
      return http.list<DnsRecord>("GET", `/zones/${enc(zoneId)}/dns_records`, {
        query: { "name.exact": args.name },
      });
    },

    /** `GET /zones/{zone_id}/workers/routes`. Needs Workers Routes: Read. */
    listWorkerRoutes(zoneId: string): Promise<WorkerRoute[]> {
      return http.result("GET", `/zones/${enc(zoneId)}/workers/routes`);
    },
  };
}
