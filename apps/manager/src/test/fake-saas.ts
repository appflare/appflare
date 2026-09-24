import { type CloudflareClient, createClient } from "@appflare/cf-api";
import { ACC, TOKEN } from "./fake-account";

/**
 * Test-only stateful fake of what external domains touch at Cloudflare: the
 * account's zones, a zone's DNS records, Worker routes, Cloudflare for SaaS
 * custom hostnames and fallback origin, KV namespaces and values, and the
 * gateway Worker's upload, bindings, version patches and deployments. It
 * answers like the live API did (codes 1404, 10000, 1406, 1551), and each
 * custom hostname goes active once `activate` is called for it.
 */

export const GATEWAY_ZONE = { id: "z-gw", name: "gateway.example" };

export interface SaasWorld {
  zones: Array<{ id: string; name: string; status: string; account: { id: string } }>;
  records: Array<{
    id: string;
    zone: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
  }>;
  routes: Array<{ id: string; zone: string; pattern: string; script?: string }>;
  hostnames: Array<{
    id: string;
    zone: string;
    hostname: string;
    status: string;
    ssl: { method: string; status: string; validation_records?: unknown[] };
    ownership_verification?: { type: string; name: string; value: string };
    verification_errors?: string[];
    created_at?: string;
  }>;
  fallback: Record<string, { origin: string; status: string }>;
  kv: Array<{ id: string; title: string }>;
  values: Record<string, Record<string, string>>;
  /** Scripts by name: their bindings, as `GET .../bindings` lists them. */
  scripts: Record<string, Array<Record<string, unknown>>>;
  /** Merge patches of `PATCH /workers/workers/<name>/versions/latest`, in order. */
  patches: Array<{ name: string; env: Record<string, unknown> }>;
  deployments: Array<{ name: string; version: string }>;
  uploads: Array<{ name: string; metadata: Record<string, unknown>; modules: string[] }>;
  /** Zones with Cloudflare for SaaS off (1404/1456). */
  saasOff: Set<string>;
  /** The token lacks SSL and Certificates (403 10000 on custom hostname calls). */
  noSsl: boolean;
  /** Hostnames registered on another account's zone (a create answers 1406). */
  elsewhere: Set<string>;
  /** KV value writes answer 500. */
  failValues: boolean;
  /** DNS record deletes answer 400 this many times (a fallback origin still being deleted). */
  recordBusy: number;
  calls: string[];
}

export function fakeSaas(over: Partial<SaasWorld> = {}) {
  const world: SaasWorld = {
    zones: [
      { ...GATEWAY_ZONE, status: "active", account: { id: ACC } },
      { id: "z-own", name: "own.example", status: "active", account: { id: ACC } },
    ],
    records: [],
    routes: [],
    hostnames: [],
    fallback: {},
    kv: [],
    values: {},
    scripts: {},
    patches: [],
    deployments: [],
    uploads: [],
    saasOff: new Set(),
    noSsl: false,
    elsewhere: new Set(),
    failValues: false,
    recordBusy: 0,
    calls: [],
    ...over,
  };
  let n = 0;
  const id = (prefix: string) => `${prefix}-${++n}`;
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });
  const page = { result_info: { page: 1, per_page: 50, total_pages: 1 } };

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "").replace(`/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    world.calls.push(key);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(403, 10000, "auth");

    if (key === "GET /zones") {
      return ok(url.searchParams.get("page") === "1" ? world.zones : [], page);
    }
    let m = /^GET \/zones\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const zone = world.zones.find((z) => z.id === m?.[1]);
      return zone === undefined ? fail(404, 1001, "Invalid zone") : ok(zone);
    }

    m = /^(GET|POST|PUT|DELETE) \/zones\/([^/]+)\/custom_hostnames(\/.*)?$/.exec(key);
    if (m?.[2]) {
      const [, method, zone, rest = ""] = m;
      if (world.noSsl) return fail(403, 10000, "Authentication error");
      if (rest === "/fallback_origin") {
        if (world.saasOff.has(zone)) return fail(401, 1456, "not granted");
        if (method === "PUT") {
          const { origin } = (await request.json()) as { origin: string };
          world.fallback[zone] = { origin, status: "initializing" };
          return ok(world.fallback[zone]);
        }
        const current = world.fallback[zone];
        if (current === undefined) return fail(404, 1551, "No fallback origin");
        if (method === "DELETE") {
          delete world.fallback[zone];
          return ok({ ...current, status: "pending_deletion" });
        }
        // Active on the second read, as it was within seconds live.
        const answer = { ...current };
        current.status = "active";
        return ok(answer);
      }
      if (world.saasOff.has(zone)) return fail(403, 1404, "No quota has been allocated");
      if (rest === "/quota") {
        return ok({
          allocated: 50000,
          used: world.hostnames.filter((h) => h.zone === zone).length,
          exceeded: false,
        });
      }
      if (rest === "" && method === "GET") {
        const hostname = url.searchParams.get("hostname");
        return ok(
          world.hostnames.filter(
            (h) => h.zone === zone && (hostname === null || h.hostname === hostname),
          ),
          page,
        );
      }
      if (rest === "" && method === "POST") {
        const body = (await request.json()) as { hostname: string; ssl: { method: string } };
        if (
          world.elsewhere.has(body.hostname) ||
          world.hostnames.some((h) => h.hostname === body.hostname)
        ) {
          return fail(409, 1406, "Duplicate custom hostname found.");
        }
        const chId = id("ch");
        const created = {
          id: chId,
          zone,
          hostname: body.hostname,
          status: "pending",
          ssl: {
            method: body.ssl.method,
            status: "pending_validation",
            ...(body.ssl.method === "txt"
              ? {
                  validation_records: [
                    { txt_name: `_acme-challenge.${body.hostname}`, txt_value: "acme-1" },
                  ],
                }
              : {}),
          },
          ownership_verification: {
            type: "txt",
            name: `_cf-custom-hostname.${body.hostname}`,
            value: `own-${chId}`,
          },
          verification_errors: ["custom hostname does not CNAME to this zone."],
          created_at: new Date().toISOString(),
        };
        world.hostnames.push(created);
        return ok(created);
      }
      const one = /^\/([^/]+)$/.exec(rest)?.[1];
      const found = world.hostnames.find((h) => h.zone === zone && h.id === one);
      if (found === undefined) return fail(404, 1436, "custom hostname not found");
      if (method === "DELETE") {
        world.hostnames = world.hostnames.filter((h) => h !== found);
        return ok({ id: found.id });
      }
      return ok(found);
    }

    m = /^(GET|POST) \/zones\/([^/]+)\/dns_records$/.exec(key);
    if (m?.[2]) {
      const zone = m[2];
      if (m[1] === "GET") {
        const name = url.searchParams.get("name.exact");
        return ok(
          world.records.filter((r) => r.zone === zone && r.name === name),
          page,
        );
      }
      const body = (await request.json()) as Omit<SaasWorld["records"][number], "id" | "zone">;
      const record = { ...body, id: id("rec"), zone };
      world.records.push(record);
      return ok(record);
    }
    m = /^DELETE \/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(key);
    if (m?.[2] && world.recordBusy > 0) {
      world.recordBusy -= 1;
      return fail(400, 1000, "record is in use");
    }
    if (m?.[2]) {
      const before = world.records.length;
      world.records = world.records.filter((r) => r.id !== m?.[2]);
      return world.records.length < before ? ok({ id: m[2] }) : fail(404, 81044, "not found");
    }
    m = /^(GET|POST) \/zones\/([^/]+)\/workers\/routes$/.exec(key);
    if (m?.[2]) {
      const zone = m[2];
      if (m[1] === "GET") return ok(world.routes.filter((r) => r.zone === zone));
      const body = (await request.json()) as { pattern: string; script?: string };
      if (body.pattern === "*/*" && world.saasOff.has(zone)) {
        return fail(400, 100327, "You cannot use a wildcard host without Cloudflare for SaaS");
      }
      const route = { id: id("route"), zone, ...body };
      world.routes.push(route);
      return ok(route);
    }
    m = /^DELETE \/zones\/([^/]+)\/workers\/routes\/([^/]+)$/.exec(key);
    if (m?.[2]) {
      const before = world.routes.length;
      world.routes = world.routes.filter((r) => r.id !== m?.[2]);
      return world.routes.length < before ? ok(null) : fail(404, 10020, "not found");
    }

    if (key === "GET /storage/kv/namespaces") return ok(world.kv, page);
    if (key === "POST /storage/kv/namespaces") {
      const { title } = (await request.json()) as { title: string };
      const ns = { id: id("kv"), title };
      world.kv.push(ns);
      return ok(ns);
    }
    m = /^(GET|PUT|DELETE) \/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/.exec(key);
    if (m?.[1] === "GET" && m[2] && m[3]) {
      const value = world.values[m[2]]?.[decodeURIComponent(m[3])];
      return value === undefined ? fail(404, 10009, "key not found") : new Response(value);
    }
    if (m?.[2] && m[3]) {
      const ns = m[2];
      if (world.failValues) return fail(500, 10001, "internal error");
      const valueKey = decodeURIComponent(m[3]);
      world.values[ns] ??= {};
      if (m[1] === "PUT") world.values[ns][valueKey] = await request.text();
      else delete world.values[ns][valueKey];
      return ok(null);
    }
    m = /^DELETE \/storage\/kv\/namespaces\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const before = world.kv.length;
      world.kv = world.kv.filter((ns) => ns.id !== m?.[1]);
      return world.kv.length < before ? ok(null) : fail(404, 10013, "namespace not found");
    }

    m = /^(PUT|DELETE) \/workers\/scripts\/([^/]+)$/.exec(key);
    if (m?.[2]) {
      const name = m[2];
      if (m[1] === "DELETE") {
        if (world.scripts[name] === undefined) return fail(404, 10007, "not found");
        delete world.scripts[name];
        return ok(null);
      }
      const form = await request.formData();
      const metadata = JSON.parse(String(form.get("metadata"))) as {
        bindings?: Array<Record<string, unknown>>;
      };
      world.uploads.push({
        name,
        metadata,
        modules: [...form.keys()].filter((k) => k !== "metadata"),
      });
      world.scripts[name] = metadata.bindings ?? [];
      return ok({ id: name });
    }
    m = /^GET \/workers\/scripts\/([^/]+)\/bindings$/.exec(key);
    if (m?.[1]) {
      const bindings = world.scripts[m[1]];
      return bindings === undefined ? fail(404, 10007, "not found") : ok(bindings);
    }
    m = /^PATCH \/workers\/workers\/([^/]+)\/versions\/latest$/.exec(key);
    if (m?.[1]) {
      const name = m[1];
      const body = JSON.parse(await request.text()) as { env: Record<string, unknown> };
      world.patches.push({ name, env: body.env });
      return ok({ id: `v-${world.patches.length}` });
    }
    m = /^POST \/workers\/scripts\/([^/]+)\/deployments$/.exec(key);
    if (m?.[1]) {
      const name = m[1];
      const body = (await request.json()) as { versions: Array<{ version_id: string }> };
      const version = body.versions[0]?.version_id ?? "";
      // The deployment applies the patch it names to the script's bindings.
      const patch = world.patches[Number(version.replace("v-", "")) - 1];
      if (patch !== undefined) {
        let bindings = world.scripts[name] ?? [];
        for (const [binding, value] of Object.entries(patch.env)) {
          bindings = bindings.filter((b) => b.name !== binding);
          if (value !== null) bindings.push({ name: binding, ...(value as object) });
        }
        world.scripts[name] = bindings;
      }
      world.deployments.push({ name, version });
      return ok({ id: `dep-${world.deployments.length}` });
    }
    return fail(404, 7003, `no route ${key}`);
  };

  /** Validation passed: the hostname and its certificate are active. */
  function activate(hostname: string) {
    const found = world.hostnames.find((h) => h.hostname === hostname);
    if (found === undefined) throw new Error(`no custom hostname ${hostname}`);
    found.status = "active";
    found.ssl.status = "active";
    found.verification_errors = [];
  }

  const api: CloudflareClient = createClient({ accountId: ACC, token: TOKEN, fetch });
  return { world, api, fetch, activate };
}
