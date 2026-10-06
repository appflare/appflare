/**
 * Test-only stateful fake of one zone's Cloudflare Email Routing: the zone,
 * its apex DNS records, the routing settings (`POST`/`DELETE .../dns` turn it
 * on and off and add or remove the MX records), rules (created, replaced and
 * deleted), the catch-all, and the
 * account's destination addresses. `handle` answers the requests it knows and
 * returns null for the rest, so a test can put it in front of another fake.
 */

export const ZONE_ID = "0123456789abcdef0123456789abcdef";
export const ZONE_NAME = "example.com";

export interface FakeRule {
  id: string;
  name?: string;
  enabled: boolean;
  matchers: Array<{ type: string; field?: string; value?: string }>;
  actions: Array<{ type: string; value?: string[] }>;
}

export interface EmailWorld {
  zone: { id: string; name: string; status: string; type: string; account: { id: string } };
  routingEnabled: boolean;
  /** Apex DNS records (MX and others). */
  records: Array<{ id: string; type: string; name: string; content: string }>;
  rules: FakeRule[];
  catchAll: {
    enabled: boolean;
    matchers: Array<{ type: string }>;
    actions: Array<{ type: string; value?: string[] }>;
  };
  addresses: Array<{ id: string; email: string; verified: string | null }>;
  /** Path prefixes answered 403 (a token without the permission). */
  forbidden: string[];
  /** `METHOD /path` keys whose next call does its work and then answers 500. */
  failAfter: Set<string>;
  calls: string[];
}

const CLOUDFLARE_MX = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
];

export function fakeEmailRouting(accountId: string, over: Partial<EmailWorld> = {}) {
  const world: EmailWorld = {
    zone: {
      id: ZONE_ID,
      name: ZONE_NAME,
      status: "active",
      type: "full",
      account: { id: accountId },
    },
    routingEnabled: false,
    records: [{ id: "rec-a", type: "A", name: ZONE_NAME, content: "192.0.2.1" }],
    rules: [],
    catchAll: { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
    addresses: [],
    forbidden: [],
    failAfter: new Set(),
    calls: [],
    ...over,
  };
  let nextRule = 1;
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });
  const settings = () => ({
    id: "settings",
    name: world.zone.name,
    enabled: world.routingEnabled,
    status: world.routingEnabled ? "ready" : "unconfigured",
  });

  async function route(request: Request, path: string): Promise<Response | null> {
    const key = `${request.method} ${path}`;
    const zone = `/zones/${world.zone.id}`;
    const er = `${zone}/email/routing`;
    switch (key) {
      case `GET ${zone}`:
        return ok(world.zone);
      case `GET ${zone}/dns_records`:
        return ok(world.records, { result_info: { page: 1, total_pages: 1 } });
      case `GET ${er}`:
        return ok(settings());
      case `POST ${er}/dns`:
        world.routingEnabled = true;
        world.records = world.records.filter((r) => r.type !== "MX");
        for (const [i, content] of CLOUDFLARE_MX.entries()) {
          world.records.push({ id: `mx-${i}`, type: "MX", name: world.zone.name, content });
        }
        return ok(settings());
      case `DELETE ${er}/dns`:
        world.routingEnabled = false;
        world.records = world.records.filter((r) => !CLOUDFLARE_MX.includes(r.content));
        return ok(settings());
      case `GET ${er}/rules`: {
        const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
        const perPage = Number(new URL(request.url).searchParams.get("per_page") ?? 20);
        const slice = world.rules.slice((page - 1) * perPage, page * perPage);
        return ok(slice, {
          result_info: {
            page,
            per_page: perPage,
            count: slice.length,
            total_count: world.rules.length,
          },
        });
      }
      case `POST ${er}/rules`: {
        const body = (await request.json()) as Omit<FakeRule, "id">;
        const rule: FakeRule = { ...body, id: `rule${String(nextRule++).padStart(28, "0")}` };
        world.rules.push(rule);
        return ok(rule);
      }
      case `GET ${er}/rules/catch_all`:
        return ok({ id: "catchall", ...world.catchAll });
      case `PUT ${er}/rules/catch_all`: {
        const body = (await request.json()) as EmailWorld["catchAll"];
        world.catchAll = {
          enabled: body.enabled,
          matchers: body.matchers,
          actions: body.actions,
        };
        return ok({ id: "catchall", ...world.catchAll });
      }
      case `GET /accounts/${accountId}/email/routing/addresses`: {
        const verified = new URL(request.url).searchParams.get("verified");
        const list = world.addresses.filter((a) =>
          verified === "false" ? true : a.verified !== null,
        );
        return ok(list, { result_info: { page: 1, total_count: list.length } });
      }
    }
    const replaced = new RegExp(`^PUT ${er}/rules/([^/]+)$`).exec(key);
    if (replaced?.[1] !== undefined) {
      const id = replaced[1];
      const at = world.rules.findIndex((r) => r.id === id);
      if (at === -1) return fail(404, 2020, "Rule not found");
      const body = (await request.json()) as Omit<FakeRule, "id">;
      const rule: FakeRule = { ...body, id };
      world.rules[at] = rule;
      return ok(rule);
    }
    const rule = new RegExp(`^DELETE ${er}/rules/([^/]+)$`).exec(key);
    if (rule?.[1] !== undefined) {
      const id = rule[1];
      const before = world.rules.length;
      world.rules = world.rules.filter((r) => r.id !== id);
      return world.rules.length < before ? ok({ id }) : fail(404, 2020, "Rule not found");
    }
    return null;
  }

  /** Answers a Cloudflare API request this fake knows; null for any other. */
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.origin !== "https://api.cloudflare.com") return null;
    const path = url.pathname.replace("/client/v4", "");
    const known =
      path.startsWith(`/zones/${world.zone.id}`) ||
      path.startsWith(`/accounts/${accountId}/email/routing`);
    if (!known) return null;
    const key = `${request.method} ${path}`;
    world.calls.push(key);
    if (world.forbidden.some((prefix) => path.startsWith(prefix))) {
      return fail(403, 10000, "Authentication error");
    }
    const response = await route(request, path);
    if (response !== null && world.failAfter.delete(key)) {
      return fail(500, 10013, "internal error");
    }
    return response ?? fail(404, 7003, `no route ${key}`);
  }

  return { world, handle };
}
