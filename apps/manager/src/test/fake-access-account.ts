import { createClient, type FetchLike } from "@appflare/cf-api";

/**
 * Test-only: the Access objects protected apps use (service tokens, reusable
 * policies, applications with their own policies), kept in memory and
 * answered the way the Cloudflare API answers them, plus the account's zone
 * list, its Zero Trust organization, its Workers (name and script tag) and
 * its workers.dev subdomain. Tests delete things "in the dashboard" by
 * editing the maps.
 */

/** The team domain the fake organization answers with. */
export const FAKE_TEAM_DOMAIN = "appflare-test.cloudflareaccess.com";

export const FAKE_ACC = "acc0000000000000000000000000000a";
const A = `/accounts/${FAKE_ACC}`;

export interface FakeToken {
  id: string;
  name: string;
  client_id: string;
  client_secret: string;
  expires_at: string;
}

export interface FakePolicy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
}

export interface FakeApp {
  id: string;
  aud: string;
  [key: string]: unknown;
  policies: Array<{ id: string; name?: string; decision?: string; precedence?: number }>;
}

export interface FakeAccessCall {
  key: string;
  body: unknown;
}

export function fakeAccessAccount(opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date("2026-09-30T12:00:00.000Z"));
  const tokens = new Map<string, FakeToken>();
  /** Reusable policies. */
  const policies = new Map<string, FakePolicy>();
  /** Policies that belong to one application. */
  const appPolicies = new Map<string, FakePolicy & { appId: string }>();
  const apps = new Map<string, FakeApp>();
  const zones: Array<{ id: string; name: string; status: string; account: { id: string } }> = [];
  /** The account's Workers, as `GET /workers/scripts` lists them. */
  const scripts: Array<{ id: string; tag: string }> = [];
  /** The Zero Trust organization; null answers 404 (the account has none). */
  const organization: { current: { auth_domain: string; name: string } | null } = {
    current: { auth_domain: FAKE_TEAM_DOMAIN, name: "Appflare test" },
  };
  const calls: FakeAccessCall[] = [];
  /** `METHOD /path` keys (a trailing `*` matches a prefix) answered with a 403. */
  const forbidden = new Set<string>();
  let n = 0;
  const yearFrom = (d: Date) => new Date(d.getTime() + 365 * 24 * 3600 * 1000).toISOString();

  const json = (status: number, result: unknown, errors: unknown[] = [], info?: unknown) =>
    Response.json(
      {
        success: status < 400,
        errors,
        messages: [],
        result,
        ...(info === undefined ? {} : { result_info: info }),
      },
      { status },
    );
  const notFound = () => json(404, null, [{ code: 12130, message: "access.api.error.not_found" }]);
  const publicToken = ({ client_secret: _secret, ...rest }: FakeToken) => rest;
  const appCount = (id: string) =>
    [...apps.values()].filter((a) => a.policies.some((p) => p.id === id)).length;
  const policyLinks = (appId: string, body: unknown[]) =>
    body.map((entry, i) => {
      const e = entry as { id?: string; precedence?: number } & Partial<FakePolicy>;
      if (e.id !== undefined) {
        const known = policies.get(e.id) ?? appPolicies.get(e.id);
        return {
          id: e.id,
          name: known?.name,
          decision: known?.decision,
          precedence: e.precedence ?? i + 1,
        };
      }
      n += 1;
      const inline = {
        id: `apol-${n}`,
        appId,
        name: e.name ?? "",
        decision: e.decision ?? "",
        include: e.include ?? [],
      };
      appPolicies.set(inline.id, inline);
      return {
        id: inline.id,
        name: inline.name,
        decision: inline.decision,
        precedence: e.precedence ?? i + 1,
      };
    });

  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const key = `${request.method} ${path}`;
    const text = request.body === null ? "" : await request.text();
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    calls.push({ key, body });
    const refused = [...forbidden].some((f) =>
      f.endsWith("*") ? key.startsWith(f.slice(0, -1)) : f === key,
    );
    if (refused) return json(403, null, [{ code: 10000, message: "Authentication error" }]);
    const one = { page: 1, total_pages: 1 };

    if (key === `GET ${A}/access/organizations`) {
      return organization.current === null
        ? json(404, null, [{ code: 12130, message: "access.api.error.not_found" }])
        : json(200, organization.current);
    }
    if (key === `GET ${A}/access/apps`) return json(200, [...apps.values()], [], one);
    if (key === `GET ${A}/workers/scripts`) return json(200, scripts);
    if (key === `GET ${A}/workers/subdomain`) return json(200, { subdomain: "appflare-dev" });
    if (key === `GET ${A}/access/service_tokens`) {
      return json(200, [...tokens.values()].map(publicToken), [], one);
    }
    if (key === `POST ${A}/access/service_tokens`) {
      n += 1;
      const b = body as { name: string };
      const t: FakeToken = {
        id: `tok-${n}`,
        name: b.name,
        client_id: `client-${n}.access`,
        client_secret: `secret-${n}-DO-NOT-LEAK`,
        expires_at: yearFrom(now()),
      };
      tokens.set(t.id, t);
      return json(200, t);
    }
    const tokenOp = path.match(
      new RegExp(`^${A}/access/service_tokens/([^/]+)(?:/(rotate|refresh))?$`),
    );
    if (tokenOp !== null) {
      const id = decodeURIComponent(tokenOp[1] ?? "");
      const t = tokens.get(id);
      if (t === undefined) return notFound();
      if (request.method === "POST" && tokenOp[2] === "rotate") {
        n += 1;
        t.client_secret = `secret-${n}-DO-NOT-LEAK`;
        return json(200, t);
      }
      if (request.method === "POST" && tokenOp[2] === "refresh") {
        t.expires_at = yearFrom(now());
        return json(200, publicToken(t));
      }
      if (request.method === "DELETE" && tokenOp[2] === undefined) {
        const named = [...policies.values(), ...appPolicies.values()].some((p) =>
          JSON.stringify(p.include).includes(`"${id}"`),
        );
        if (named) {
          return json(400, null, [
            { code: 12139, message: "access.api.error.service_token_in_use" },
          ]);
        }
        tokens.delete(id);
        return json(200, publicToken(t));
      }
    }
    if (key === `GET ${A}/access/policies`) {
      return json(
        200,
        [...policies.values()].map((p) => ({ ...p, reusable: true, app_count: appCount(p.id) })),
        [],
        one,
      );
    }
    if (key === `POST ${A}/access/policies`) {
      n += 1;
      const p = { ...(body as Omit<FakePolicy, "id">), id: `pol-${n}` };
      policies.set(p.id, p);
      return json(200, p);
    }
    const policyOp = path.match(new RegExp(`^${A}/access/policies/([^/]+)$`));
    if (policyOp !== null) {
      const id = decodeURIComponent(policyOp[1] ?? "");
      const p = policies.get(id);
      if (p === undefined) return notFound();
      if (request.method === "PUT") {
        const next = { ...(body as Omit<FakePolicy, "id">), id };
        policies.set(id, next);
        return json(200, { ...next, app_count: appCount(id) });
      }
      if (request.method === "DELETE") {
        policies.delete(id);
        return json(200, { id });
      }
    }
    if (key === `POST ${A}/access/apps`) {
      n += 1;
      const b = body as Record<string, unknown> & { policies?: unknown[] };
      const app: FakeApp = { ...b, id: `app-${n}`, aud: `aud-${n}`, domain: null, policies: [] };
      app.policies = policyLinks(app.id, b.policies ?? []);
      apps.set(app.id, app);
      return json(200, app);
    }
    const appPolicyOp = path.match(new RegExp(`^${A}/access/apps/([^/]+)/policies/([^/]+)$`));
    if (appPolicyOp !== null && request.method === "PUT") {
      const p = appPolicies.get(decodeURIComponent(appPolicyOp[2] ?? ""));
      if (p === undefined || !apps.has(decodeURIComponent(appPolicyOp[1] ?? ""))) {
        return notFound();
      }
      Object.assign(p, body as object);
      return json(200, p);
    }
    const appOp = path.match(new RegExp(`^${A}/access/apps/([^/]+)$`));
    if (appOp !== null) {
      const id = decodeURIComponent(appOp[1] ?? "");
      const app = apps.get(id);
      if (app === undefined) return notFound();
      if (request.method === "GET") return json(200, app);
      if (request.method === "PUT") {
        const b = body as Record<string, unknown> & { policies?: unknown[] };
        const kept = app.policies;
        const next: FakeApp = { ...b, id, aud: app.aud, domain: null, policies: kept };
        if (b.policies !== undefined) {
          next.policies = policyLinks(id, b.policies);
          // App-scoped policies an update leaves out are gone with it.
          for (const p of kept) {
            if (appPolicies.has(p.id) && !next.policies.some((q) => q.id === p.id)) {
              appPolicies.delete(p.id);
            }
          }
        }
        apps.set(id, next);
        return json(200, next);
      }
      if (request.method === "DELETE") {
        apps.delete(id);
        for (const [pid, p] of appPolicies) if (p.appId === id) appPolicies.delete(pid);
        return json(200, { id });
      }
    }
    if (key === "GET /zones") return json(200, zones, [], one);
    return json(404, null, [{ code: 7003, message: "No route for that URI" }]);
  };

  const client = createClient({ accountId: FAKE_ACC, token: "cf-token-DO-NOT-LEAK", fetch });
  return {
    fetch,
    client,
    tokens,
    policies,
    appPolicies,
    apps,
    zones,
    scripts,
    organization,
    calls,
    forbidden,
    /** `METHOD /path` of every call, account prefix removed. */
    keys: () => calls.map((c) => c.key.replace(A, "")),
  };
}
