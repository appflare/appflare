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
  /** The record's note, as the dashboard shows it; null or absent when it has none. */
  comment?: string | null;
}

/** One entry of `GET /zones/{zone_id}/workers/routes`. */
export interface WorkerRoute {
  id: string;
  pattern: string;
  script?: string;
}

/** A new DNS record (`POST /zones/{zone_id}/dns_records`). */
export interface CreateDnsRecordArgs {
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  /** Seconds; 1 means automatic. */
  ttl?: number;
  comment?: string;
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

    /**
     * `GET /zones?account.id=<this client's account>[&status=]&page=&per_page=`:
     * ONE page of the account's zones, optionally only those in one status. A
     * one-zone page is the cheapest way to learn whether the token can see
     * such a zone at all.
     */
    async listAccountZonesPage(
      opts: { status?: ZoneStatus; page?: number; perPage?: number } = {},
    ): Promise<{ items: Zone[]; totalCount: number | null }> {
      const envelope = await http.send("GET", "/zones", {
        query: {
          "account.id": http.accountId,
          status: opts.status,
          page: opts.page,
          per_page: opts.perPage,
        },
      });
      // An answer without the list must not read as "no zones".
      if (!Array.isArray(envelope.result)) {
        throw Object.assign(new Error("the zone list answer holds no list"), {
          name: "UnreadableZones",
        });
      }
      return {
        items: envelope.result as Zone[],
        totalCount: envelope.result_info?.total_count ?? null,
      };
    },

    /** `GET /zones/{zone_id}`. */
    getZone(zoneId: string): Promise<Zone> {
      return http.result("GET", `/zones/${enc(zoneId)}`);
    },

    /**
     * `GET /zones/{zone_id}/dns_records?name.exact=<name>`: the records at
     * exactly this name (case-insensitive). With `nameEndsWith` instead,
     * `name.endswith=<suffix>`: every record whose name ends in the suffix
     * (case-insensitive), every page. Needs DNS: Read.
     */
    listDnsRecords(
      zoneId: string,
      args: { name: string } | { nameEndsWith: string },
    ): Promise<DnsRecord[]> {
      return http.list<DnsRecord>("GET", `/zones/${enc(zoneId)}/dns_records`, {
        query:
          "name" in args ? { "name.exact": args.name } : { "name.endswith": args.nameEndsWith },
      });
    },

    /** `POST /zones/{zone_id}/dns_records`. Needs DNS: Edit. */
    createDnsRecord(zoneId: string, args: CreateDnsRecordArgs): Promise<DnsRecord> {
      return http.result("POST", `/zones/${enc(zoneId)}/dns_records`, {
        json: { ttl: 1, ...args },
      });
    },

    /** `DELETE /zones/{zone_id}/dns_records/{id}`. Needs DNS: Edit. */
    deleteDnsRecord(zoneId: string, recordId: string): Promise<unknown> {
      return http.result("DELETE", `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`);
    },

    /** `GET /zones/{zone_id}/workers/routes`. Needs Workers Routes: Read. */
    listWorkerRoutes(zoneId: string): Promise<WorkerRoute[]> {
      return http.result("GET", `/zones/${enc(zoneId)}/workers/routes`);
    },

    /**
     * `POST /zones/{zone_id}/workers/routes` with `{ pattern, script }`; a
     * route without a script excludes the pattern from broader routes. The
     * catch-all pattern (any host, any path) is accepted only on a zone with
     * Cloudflare for SaaS on (400 code 100327 otherwise). Needs Workers
     * Routes: Edit.
     */
    createWorkerRoute(
      zoneId: string,
      args: { pattern: string; script?: string },
    ): Promise<WorkerRoute> {
      return http.result("POST", `/zones/${enc(zoneId)}/workers/routes`, { json: args });
    },

    /** `DELETE /zones/{zone_id}/workers/routes/{route_id}`. Needs Workers Routes: Edit. */
    deleteWorkerRoute(zoneId: string, routeId: string): Promise<unknown> {
      return http.result("DELETE", `/zones/${enc(zoneId)}/workers/routes/${enc(routeId)}`);
    },
  };
}
