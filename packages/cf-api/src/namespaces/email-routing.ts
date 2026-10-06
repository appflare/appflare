import { z } from "zod";
import type { HttpApi } from "../http";

const enc = encodeURIComponent;

/**
 * Email Routing: a zone's routing settings and the MX, SPF and DKIM records
 * it needs, the zone's routing rules and catch-all rule, and the account's
 * destination addresses.
 *
 * Zone calls live under `/zones/{zone_id}/email/routing`, destination
 * addresses under the account. Turning routing on is `POST .../dns` (it adds
 * and locks the MX, SPF and DKIM records) and turning it off is `DELETE .../dns`
 * (it removes them again); the older `POST .../enable` and `POST .../disable`
 * are deprecated in Cloudflare's API schema and not used here.
 *
 * Permissions, as Cloudflare's API schema lists them per call: the settings
 * and the records need Zone Settings (Read to read, Edit to turn routing on or
 * off); rules and the catch-all need Email Routing Rules (Read or Edit);
 * destination addresses need the account's Email Routing Addresses (Read or
 * Edit).
 *
 * Every result is checked against the fields read here; unknown fields pass
 * through.
 */

/** A zone's Email Routing state (`status`), as Cloudflare reports it. */
export type EmailRoutingStatus =
  | "ready"
  | "unconfigured"
  | "misconfigured"
  | "misconfigured/locked"
  | "unlocked"
  | (string & {});

const settingsSchema = z.looseObject({
  id: z.string(),
  /** The zone's domain. */
  name: z.string(),
  enabled: z.boolean(),
  status: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  skip_wizard: z.boolean().optional(),
  support_subaddress: z.boolean().optional(),
});

/** `GET /zones/{zone_id}/email/routing`. */
export interface EmailRoutingSettings {
  id: string;
  /** The zone's domain. */
  name: string;
  /** Whether Email Routing is on for the zone. */
  enabled: boolean;
  status?: EmailRoutingStatus;
  created?: string;
  modified?: string;
  skip_wizard?: boolean;
  support_subaddress?: boolean;
  [key: string]: unknown;
}

const dnsRecordSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  priority: z.number().optional(),
  ttl: z.number().optional(),
});

/** One DNS record Email Routing needs on the zone (`GET .../email/routing/dns`). */
export interface EmailRoutingDnsRecord {
  /** `MX`, `TXT`. */
  type?: string;
  name?: string;
  content?: string;
  priority?: number;
  ttl?: number;
  [key: string]: unknown;
}

const matcherSchema = z.looseObject({
  /** `literal` (one address) or `all` (the catch-all). */
  type: z.string(),
  /** `to` for literal matchers. */
  field: z.string().optional(),
  /** The address a literal matcher matches. */
  value: z.string().optional(),
});

/** What a rule matches: `{ type: "literal", field: "to", value: <address> }` or `{ type: "all" }`. */
export interface EmailRoutingMatcher {
  type: "literal" | "all" | (string & {});
  field?: "to" | (string & {});
  value?: string;
  [key: string]: unknown;
}

const actionSchema = z.looseObject({
  /** `forward`, `worker`, or `drop`. */
  type: z.string(),
  /** A destination address (`forward`) or a Worker name (`worker`); one value at most. */
  value: z.array(z.string()).optional(),
});

/** What a rule does: `{ type: "worker", value: [<Worker name>] }`, `forward`, or `drop`. */
export interface EmailRoutingAction {
  type: "forward" | "worker" | "drop" | (string & {});
  value?: string[];
  [key: string]: unknown;
}

const ruleSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  matchers: z.array(matcherSchema).default([]),
  actions: z.array(actionSchema).default([]),
  /** `api` (dashboard, API, Terraform) or `wrangler` (managed by a Worker's config). */
  source: z.string().optional(),
});

/** One routing rule of a zone. */
export interface EmailRoutingRule {
  id: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers: EmailRoutingMatcher[];
  actions: EmailRoutingAction[];
  source?: string;
  [key: string]: unknown;
}

const catchAllSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().default(false),
  matchers: z.array(matcherSchema).default([]),
  actions: z.array(actionSchema).default([]),
});

/** The zone's catch-all rule: what happens to mail no other rule matches. */
export interface EmailRoutingCatchAll {
  id?: string;
  name?: string;
  enabled: boolean;
  matchers: EmailRoutingMatcher[];
  actions: EmailRoutingAction[];
  [key: string]: unknown;
}

const addressSchema = z.looseObject({
  id: z.string(),
  email: z.string(),
  /** When the address was verified; null or absent while it waits for verification. */
  verified: z.string().nullable().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
});

/** One destination address of the account. */
export interface EmailRoutingAddress {
  id: string;
  email: string;
  verified?: string | null;
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

/** Body of `POST /zones/{zone_id}/email/routing/rules`. */
export interface CreateEmailRoutingRuleArgs {
  matchers: EmailRoutingMatcher[];
  actions: EmailRoutingAction[];
  name?: string;
  enabled?: boolean;
  priority?: number;
}

/**
 * Body of `PUT /zones/{zone_id}/email/routing/rules/{rule_id}`, which
 * replaces the rule: the whole rule is sent, not a change.
 */
export interface UpdateEmailRoutingRuleArgs {
  matchers: EmailRoutingMatcher[];
  actions: EmailRoutingAction[];
  name?: string;
  enabled?: boolean;
  priority?: number;
}

/** Body of `PUT /zones/{zone_id}/email/routing/rules/catch_all`. */
export interface UpdateEmailRoutingCatchAllArgs {
  actions: EmailRoutingAction[];
  /** Defaults to `[{ type: "all" }]`, the only matcher a catch-all takes. */
  matchers?: EmailRoutingMatcher[];
  name?: string;
  enabled?: boolean;
}

/** Thrown when Cloudflare answers an Email Routing call with a result of an unexpected shape. */
export class EmailRoutingShapeError extends Error {
  override name = "EmailRoutingShapeError";
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new EmailRoutingShapeError(`Cloudflare answered ${what} in an unexpected shape`);
  }
  return parsed.data;
}

/** `GET .../email/routing/dns` answers the records as a list, or inside `{ record: [...] }`. */
const dnsRecordsSchema = z.union([
  z.array(dnsRecordSchema),
  z.looseObject({ record: z.array(dnsRecordSchema) }).transform((r) => r.record),
]);

/** Rules and destination addresses page at most 50 per page. */
const EMAIL_ROUTING_PER_PAGE = 50;

/**
 * Page cap: a domain holds at most 200 rules and an account at most 200
 * destination addresses (Cloudflare's Email Routing limits), four pages of 50.
 * Ten pages leave room for a raised limit without looping forever.
 */
const EMAIL_ROUTING_MAX_PAGES = 10;

export function createEmailRouting(http: HttpApi) {
  const zone = (zoneId: string, suffix = "") => `/zones/${enc(zoneId)}/email/routing${suffix}`;

  /**
   * Pages through a list whose `result_info` reports `total_count` (and for
   * some lists no `total_pages`), until a short page or the total is reached.
   */
  async function pages<S extends z.ZodType>(
    path: string,
    item: S,
    what: string,
    query: Record<string, string | boolean | undefined> = {},
  ): Promise<Array<z.infer<S>>> {
    const out: Array<z.infer<S>> = [];
    for (let page = 1; page <= EMAIL_ROUTING_MAX_PAGES; page++) {
      const envelope = await http.send("GET", path, {
        query: { ...query, page, per_page: EMAIL_ROUTING_PER_PAGE },
      });
      const rows = parse(z.array(item), envelope.result ?? [], what);
      out.push(...rows);
      const info = envelope.result_info;
      if (rows.length < EMAIL_ROUTING_PER_PAGE) break;
      if (info?.total_count !== undefined && out.length >= info.total_count) break;
      if (info?.total_pages !== undefined && page >= info.total_pages) break;
    }
    return out;
  }

  return {
    /** `GET /zones/{zone_id}/email/routing`: whether routing is on, and its state. */
    async getSettings(zoneId: string): Promise<EmailRoutingSettings> {
      const result = await http.result("GET", zone(zoneId));
      return parse(settingsSchema, result, "the Email Routing settings");
    },

    /**
     * `POST /zones/{zone_id}/email/routing/dns`: turns Email Routing on and
     * adds (and locks) the MX, SPF and DKIM records it needs. `name` is a subdomain
     * to set up instead of the zone itself.
     */
    async enableRouting(
      zoneId: string,
      args: { name?: string } = {},
    ): Promise<EmailRoutingSettings> {
      const result = await http.result("POST", zone(zoneId, "/dns"), {
        json: args.name === undefined ? {} : { name: args.name },
      });
      return parse(settingsSchema, result, "turning Email Routing on");
    },

    /**
     * `DELETE /zones/{zone_id}/email/routing/dns`: turns Email Routing off and
     * removes the MX records it added.
     */
    async disableRouting(zoneId: string): Promise<EmailRoutingSettings> {
      const result = await http.result("DELETE", zone(zoneId, "/dns"), { json: {} });
      return parse(settingsSchema, result, "turning Email Routing off");
    },

    /** `GET /zones/{zone_id}/email/routing/dns`: the records Email Routing needs on the zone. */
    async getDnsRecords(zoneId: string): Promise<EmailRoutingDnsRecord[]> {
      const result = await http.result("GET", zone(zoneId, "/dns"));
      return parse(dnsRecordsSchema, result ?? [], "the Email Routing DNS records");
    },

    /** `GET /zones/{zone_id}/email/routing/rules`, every page. The catch-all is read separately. */
    listRules(zoneId: string): Promise<EmailRoutingRule[]> {
      return pages(zone(zoneId, "/rules"), ruleSchema, "the routing rules");
    },

    /** `POST /zones/{zone_id}/email/routing/rules`. */
    async createRule(zoneId: string, args: CreateEmailRoutingRuleArgs): Promise<EmailRoutingRule> {
      const result = await http.result("POST", zone(zoneId, "/rules"), { json: args });
      return parse(ruleSchema, result, "the new routing rule");
    },

    /** `PUT /zones/{zone_id}/email/routing/rules/{rule_id}`: replaces the rule, keeping its id. */
    async updateRule(
      zoneId: string,
      ruleId: string,
      args: UpdateEmailRoutingRuleArgs,
    ): Promise<EmailRoutingRule> {
      const result = await http.result("PUT", zone(zoneId, `/rules/${enc(ruleId)}`), {
        json: args,
      });
      return parse(ruleSchema, result, "the updated routing rule");
    },

    /** `DELETE /zones/{zone_id}/email/routing/rules/{rule_id}`. */
    async deleteRule(zoneId: string, ruleId: string): Promise<void> {
      await http.result("DELETE", zone(zoneId, `/rules/${enc(ruleId)}`));
    },

    /** `GET /zones/{zone_id}/email/routing/rules/catch_all`. */
    async getCatchAll(zoneId: string): Promise<EmailRoutingCatchAll> {
      const result = await http.result("GET", zone(zoneId, "/rules/catch_all"));
      return parse(catchAllSchema, result, "the catch-all rule");
    },

    /** `PUT /zones/{zone_id}/email/routing/rules/catch_all`: replaces the catch-all rule. */
    async updateCatchAll(
      zoneId: string,
      args: UpdateEmailRoutingCatchAllArgs,
    ): Promise<EmailRoutingCatchAll> {
      const result = await http.result("PUT", zone(zoneId, "/rules/catch_all"), {
        json: {
          actions: args.actions,
          matchers: args.matchers ?? [{ type: "all" }],
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
        },
      });
      return parse(catchAllSchema, result, "the updated catch-all rule");
    },

    /**
     * `GET /accounts/{id}/email/routing/addresses`, every page. Cloudflare
     * lists only verified addresses unless `verified: false` asks for the
     * others; `undefined` keeps Cloudflare's default.
     */
    listDestinationAddresses(args: { verified?: boolean } = {}): Promise<EmailRoutingAddress[]> {
      return pages(
        http.acct("/email/routing/addresses"),
        addressSchema,
        "the destination addresses",
        {
          verified: args.verified,
        },
      );
    },
  };
}
