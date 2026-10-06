import { createHmac } from "node:crypto";
import { assetHash, type FetchLike, type WorkerDomain } from "@appflare/cf-api";
import type { ReleaseFixture } from "./release-fixture";

/**
 * Test-only stand-in for everything the installer talks to: Cloudflare's API
 * for one account (a stateful fake), GitHub's release pages and the storage
 * host its downloads redirect to (Range requests included), a development
 * release host, and the new manager's handoff endpoint at its addresses.
 * Every request is recorded so tests can count subrequests and look for
 * leaked values.
 */

export const TOKEN = "cf-test-token-DO-NOT-LEAK-6f1d2a9c4b";
export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
export const SUBDOMAIN = "probe-sub";
export const ZONE_ID = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
export const DEV_RELEASE_URL = "https://dev-release.test/manager";

const API = "/client/v4";

export interface FakeScript {
  created_on: string;
  metadata: Record<string, unknown>;
  modules: Map<string, Uint8Array>;
  secrets: Map<string, string>;
  schedules: string[];
  workersDev: boolean;
  previews: boolean;
}

export type AddressAnswer = "tls" | "404-1042" | "unrelated-200" | "redirect" | "wrong-proof";

interface Session {
  hashes: Set<string>;
  routes: Map<string, string>;
}

export class FakeWorld {
  accounts = [{ id: ACCOUNT, name: "Probe account" }];
  subdomain: string | null = SUBDOMAIN;
  scripts = new Map<string, FakeScript>();
  d1: Array<{ uuid: string; name: string; created_at: string }> = [];
  kv: Array<{ id: string; title: string }> = [];
  workflows = new Map<string, { script_name: string; class_name: string }>();
  zones = [
    { id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT } },
    {
      id: "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
      name: "pending.example",
      status: "pending",
      account: { id: ACCOUNT },
    },
  ];
  dns: Array<{ zone_id: string; id: string; name: string; type: string; content: string }> = [];
  /** The `name` of every zone list request (`*` for a list of all). */
  zoneLookups: string[] = [];
  routes: Array<{ zone_id: string; id: string; pattern: string; script?: string }> = [];
  domains: WorkerDomain[] = [];
  storedAssets = new Set<string>();
  sessions = new Map<string, Session>();
  completions = new Set<string>();
  singleAssetUploads = false;
  bucketSize = 2;
  cronLimit = false;
  acceptedToken = TOKEN;
  /** `METHOD /suffix` (the path after `/accounts/<id>`) answered once with this status, nothing done. */
  failOnce = new Map<string, number>();
  /** `METHOD /suffix`: the work is done, then the answer is lost (500) once. */
  loseOnce = new Set<string>();
  /** Every request, in order: `METHOD url-without-query`. */
  calls: string[] = [];
  /** Request bodies sent to Cloudflare, for leak checks. */
  bodies: string[] = [];
  /** Answers an address gives before the manager answers there, in order. */
  addressAnswers = new Map<string, AddressAnswer[]>();
  handoffState: "waiting" | "received" | "done" = "waiting";
  /** The tag github.com's latest-release page points at, instead of the release's own. */
  latestTag: string | null = null;
  /** Serve this zip instead of the release's (a tampered file). */
  zipOverride: Uint8Array | null = null;
  private seq = 0;

  constructor(public release: ReleaseFixture) {}

  readonly fetch: FetchLike = (input, init) => this.serve(new Request(input, init));

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(32 - prefix.length, "0")}`;
  }

  private async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.calls.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.hostname === "github.com") return this.github(url);
    if (url.hostname === "release-assets.test" || url.hostname === "dev-release.test") {
      return this.releaseFile(url, request);
    }
    if (url.hostname === "api.cloudflare.com") return this.cloudflare(request, url);
    return this.address(url);
  }

  // GitHub ---------------------------------------------------------------

  private github(url: URL): Response {
    const tag = `manager@${this.release.version}`;
    if (url.pathname === "/appflare/appflare/releases/latest") {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://github.com/appflare/appflare/releases/tag/${encodeURIComponent(this.latestTag ?? tag)}`,
        },
      });
    }
    const download = /^\/appflare\/appflare\/releases\/download\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
    if (download?.[1] !== undefined && decodeURIComponent(download[1]) === tag) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://release-assets.test/${download[2]}?signature=test` },
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  private releaseFile(url: URL, request: Request): Response {
    const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (name === "manifest.json") return new Response(this.release.manifestBytes);
    if (name === "manifest.sig") return new Response(this.release.signature);
    if (name === `appflare-${this.release.version}.zip`) {
      const zip = this.zipOverride ?? this.release.zip;
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (range === null) return new Response(zip);
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), zip.byteLength - 1);
      return new Response(zip.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${zip.byteLength}` },
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  // The manager at its addresses ------------------------------------------

  private scriptAt(hostname: string): FakeScript | null {
    if (this.subdomain !== null && hostname.endsWith(`.${this.subdomain}.workers.dev`)) {
      const name = hostname.slice(0, -`.${this.subdomain}.workers.dev`.length);
      const script = this.scripts.get(name);
      return script?.workersDev ? script : null;
    }
    const domain = this.domains.find((d) => d.hostname === hostname);
    return domain === undefined ? null : (this.scripts.get(domain.service) ?? null);
  }

  private address(url: URL): Response {
    const queued = this.addressAnswers.get(url.hostname)?.shift();
    if (queued === "tls") throw new TypeError("Network connection lost.");
    if (queued === "404-1042") return new Response("error code: 1042", { status: 404 });
    if (queued === "unrelated-200") {
      return new Response("<html>Welcome to nginx</html>", { status: 200 });
    }
    if (queued === "redirect") {
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    }
    const script = this.scriptAt(url.hostname);
    if (script === null) throw new TypeError("getaddrinfo ENOTFOUND");
    const secret = script.secrets.get("APPFLARE_HANDOFF");
    if (url.pathname !== "/api/handoff" || secret === undefined) {
      return new Response("Not found", { status: 404 });
    }
    const challenge = url.searchParams.get("challenge") ?? "";
    // Computed here independently of the installer's own code.
    const proof =
      queued === "wrong-proof"
        ? "AAAA"
        : createHmac("sha256", Buffer.from(secret.slice("v1.".length), "hex"))
            .update(`appflare-handoff:${challenge}`)
            .digest("base64url");
    return Response.json({
      app: "appflare",
      version: this.release.version,
      state: this.handoffState,
      proof,
    });
  }

  // Cloudflare -------------------------------------------------------------

  private ok(result: unknown, resultInfo?: unknown): Response {
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    });
  }

  private fail(status: number, code: number, message: string): Response {
    return Response.json(
      { success: false, errors: [{ code, message }], messages: [], result: null },
      { status },
    );
  }

  private async cloudflare(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.slice(API.length);
    const method = request.method;
    const body =
      method === "GET" || method === "DELETE"
        ? ""
        : new TextDecoder().decode(await request.clone().arrayBuffer());
    this.bodies.push(body);
    const auth = request.headers.get("authorization") ?? "";
    const assetUpload = path.includes("/workers/assets/upload");
    if (assetUpload) {
      if (!this.sessions.has(auth.replace(/^Bearer /, ""))) {
        return this.fail(401, 10000, "Authentication error");
      }
    } else if (auth !== `Bearer ${this.acceptedToken}`) {
      return this.fail(401, 9109, "Invalid access token");
    }
    const account = /^\/accounts\/([^/]+)(.*)$/.exec(path);
    if (account !== null && !this.accounts.some((a) => a.id === account[1])) {
      return this.fail(403, 10000, "Authentication error");
    }
    const suffix = account?.[2] ?? path;
    const key = `${method} ${suffix}`;
    const failure = this.failOnce.get(key);
    if (failure !== undefined) {
      this.failOnce.delete(key);
      return this.fail(failure, failure === 503 ? 0 : 10000, "failed on purpose");
    }
    const response = await this.route(method, path, suffix, url, request);
    if (this.loseOnce.has(key)) {
      this.loseOnce.delete(key);
      return this.fail(500, 0, "the answer was lost");
    }
    return response;
  }

  private async route(
    method: string,
    path: string,
    suffix: string,
    url: URL,
    request: Request,
  ): Promise<Response> {
    if (path === "/accounts" && method === "GET") {
      return this.ok(this.accounts, { page: 1, per_page: 50, total_pages: 1 });
    }
    if (path.startsWith("/zones")) return this.zonesRoute(method, path, url);
    if (suffix === "" && method === "GET") {
      const id = path.split("/")[2];
      return this.ok(this.accounts.find((a) => a.id === id));
    }
    if (suffix === "/workers/subdomain" && method === "GET") {
      return this.subdomain === null
        ? this.fail(404, 10007, "workers.dev subdomain not registered")
        : this.ok({ subdomain: this.subdomain });
    }
    if (suffix === "/workers/scripts" && method === "GET") {
      return this.ok([...this.scripts].map(([id, s]) => ({ id, created_on: s.created_on })));
    }
    const script = /^\/workers\/scripts\/([^/]+)(\/.*)?$/.exec(suffix);
    if (script?.[1] !== undefined) {
      return this.scriptRoute(method, decodeURIComponent(script[1]), script[2] ?? "", request);
    }
    if (suffix === "/workers/assets/upload" && method === "POST") return this.uploadBulk(request);
    const single = /^\/workers\/assets\/upload\/([0-9a-f]+)$/.exec(suffix);
    if (single?.[1] !== undefined && method === "POST") return this.uploadOne(request, single[1]);
    if (suffix.startsWith("/d1/database")) return this.d1Route(method, suffix, request);
    if (suffix.startsWith("/storage/kv/namespaces")) return this.kvRoute(method, suffix, request);
    const workflow = /^\/workflows\/([^/]+)$/.exec(suffix);
    if (workflow?.[1] !== undefined) {
      return this.workflowRoute(method, decodeURIComponent(workflow[1]), request);
    }
    if (suffix.startsWith("/workers/domains"))
      return this.domainsRoute(method, suffix, url, request);
    return this.fail(404, 7003, `no route for ${method} ${suffix}`);
  }

  private zonesRoute(method: string, path: string, url: URL): Response {
    if (method !== "GET") return this.fail(405, 0, "method");
    if (path === "/zones") {
      const accountId = url.searchParams.get("account.id");
      const status = url.searchParams.get("status");
      const name = url.searchParams.get("name");
      this.zoneLookups.push(name ?? "*");
      const zones = this.zones.filter(
        (z) =>
          (accountId === null || z.account.id === accountId) &&
          (status === null || z.status === status) &&
          (name === null || z.name === name),
      );
      return this.ok(zones, { page: 1, per_page: 50, total_pages: 1 });
    }
    const zone = /^\/zones\/([^/]+)(\/.*)?$/.exec(path);
    const found = this.zones.find((z) => z.id === zone?.[1]);
    if (found === undefined) return this.fail(404, 1001, "zone not found");
    if (zone?.[2] === undefined) return this.ok(found);
    if (zone[2] === "/dns_records") {
      const name = url.searchParams.get("name.exact");
      return this.ok(
        this.dns.filter((r) => r.zone_id === found.id && r.name === name),
        { page: 1, per_page: 100, total_pages: 1 },
      );
    }
    if (zone[2] === "/workers/routes")
      return this.ok(this.routes.filter((r) => r.zone_id === found.id));
    return this.fail(404, 7003, "no route");
  }

  private async scriptRoute(
    method: string,
    name: string,
    rest: string,
    request: Request,
  ): Promise<Response> {
    const script = this.scripts.get(name);
    if (rest === "" && method === "PUT") return this.uploadScript(name, request);
    if (rest === "" && method === "DELETE") {
      if (!this.scripts.delete(name)) return this.fail(404, 10007, "script not found");
      this.domains = this.domains.filter((d) => d.service !== name);
      return this.ok(null);
    }
    if (rest === "/assets-upload-session" && method === "POST") {
      return this.uploadSession(
        (await request.json()) as { manifest: Record<string, { hash: string }> },
      );
    }
    if (script === undefined) return this.fail(404, 10007, "script not found");
    if (rest === "/secrets" && method === "GET") {
      return this.ok([...script.secrets.keys()].map((n) => ({ name: n, type: "secret_text" })));
    }
    if (rest === "/secrets" && method === "PUT") {
      const secret = (await request.json()) as { name: string; text: string };
      script.secrets.set(secret.name, secret.text);
      return this.ok({ name: secret.name, type: "secret_text" });
    }
    if (rest === "/schedules" && method === "PUT") {
      const schedules = (await request.json()) as Array<{ cron: string }>;
      if (this.cronLimit) return this.fail(400, 10072, "cron trigger limit reached");
      script.schedules = schedules.map((s) => s.cron);
      return this.ok({ schedules });
    }
    if (rest === "/subdomain" && method === "POST") {
      const sub = (await request.json()) as { enabled: boolean; previews_enabled?: boolean };
      script.workersDev = sub.enabled;
      script.previews = sub.previews_enabled ?? false;
      return this.ok(sub);
    }
    return this.fail(404, 7003, "no route");
  }

  private async uploadScript(name: string, request: Request): Promise<Response> {
    const form = await request.formData();
    const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
    const modules = new Map<string, Uint8Array>();
    for (const [field, value] of form.entries()) {
      if (field === "metadata" || typeof value === "string") continue;
      modules.set(field, new Uint8Array(await (value as Blob).arrayBuffer()));
    }
    const assets = metadata.assets as { jwt?: string } | undefined;
    if (assets?.jwt !== undefined && !this.completions.has(assets.jwt)) {
      return this.fail(400, 10237, "assets jwt is not a completion token");
    }
    const bindings = (metadata.bindings ?? []) as Array<Record<string, unknown>>;
    for (const b of bindings) {
      if (b.type === "d1" && !this.d1.some((d) => d.uuid === b.id)) {
        return this.fail(400, 10021, "d1 database not found");
      }
      if (b.type === "kv_namespace" && !this.kv.some((n) => n.id === b.namespace_id)) {
        return this.fail(400, 10041, "kv namespace not found");
      }
    }
    const previous = this.scripts.get(name);
    const secrets = new Map<string, string>(
      (metadata.keep_bindings as string[] | undefined)?.includes("secret_text")
        ? (previous?.secrets ?? [])
        : [],
    );
    for (const b of bindings) {
      if (b.type === "secret_text") secrets.set(String(b.name), String(b.text));
    }
    this.scripts.set(name, {
      created_on: previous?.created_on ?? new Date().toISOString(),
      metadata,
      modules,
      secrets,
      schedules: previous?.schedules ?? [],
      workersDev: previous?.workersDev ?? false,
      previews: previous?.previews ?? false,
    });
    return this.ok({ id: name, deployment_id: "0123456789abcdef0123456789abcdef" });
  }

  private uploadSession(body: { manifest: Record<string, { hash: string }> }): Response {
    const routes = new Map<string, string>();
    for (const [route, { hash }] of Object.entries(body.manifest)) routes.set(hash, route);
    const missing = [...routes.keys()].filter((h) => !this.storedAssets.has(h));
    const buckets: string[][] = [];
    for (let i = 0; i < missing.length; i += this.bucketSize) {
      buckets.push(missing.slice(i, i + this.bucketSize));
    }
    this.seq += 1;
    const claims = btoa(
      JSON.stringify({ session: this.seq, wrangler_single_asset_uploads: this.singleAssetUploads }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jwt = `eyJhbGciOiJub25lIn0.${claims}.sig`;
    this.sessions.set(jwt, { hashes: new Set(routes.keys()), routes });
    if (missing.length === 0) this.completions.add(jwt);
    return this.ok({ jwt, buckets });
  }

  private store(session: Session, hash: string, bytes: Uint8Array): Response | null {
    const route = session.routes.get(hash);
    if (route === undefined || assetHash(bytes, route) !== hash) {
      return this.fail(400, 10239, "asset does not match its hash");
    }
    this.storedAssets.add(hash);
    return null;
  }

  private finished(session: Session): Response {
    if ([...session.hashes].every((h) => this.storedAssets.has(h))) {
      const jwt = `completion-${this.seq}`;
      this.completions.add(jwt);
      return this.ok({ jwt });
    }
    return this.ok({});
  }

  private async uploadBulk(request: Request): Promise<Response> {
    const session = this.sessions.get((request.headers.get("authorization") ?? "").slice(7));
    if (session === undefined) return this.fail(401, 10000, "no session");
    const form = await request.formData();
    for (const [hash, value] of form.entries()) {
      const base64 = typeof value === "string" ? value : await (value as Blob).text();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const refused = this.store(session, hash, bytes);
      if (refused !== null) return refused;
    }
    return this.finished(session);
  }

  private async uploadOne(request: Request, hash: string): Promise<Response> {
    const session = this.sessions.get((request.headers.get("authorization") ?? "").slice(7));
    if (session === undefined) return this.fail(401, 10000, "no session");
    const refused = this.store(session, hash, new Uint8Array(await request.arrayBuffer()));
    return refused ?? this.finished(session);
  }

  private async d1Route(method: string, suffix: string, request: Request): Promise<Response> {
    if (suffix === "/d1/database" && method === "GET") {
      return this.ok(this.d1, { page: 1, per_page: 100, total_pages: 1 });
    }
    if (suffix === "/d1/database" && method === "POST") {
      const { name } = (await request.json()) as { name: string };
      if (this.d1.some((d) => d.name === name)) return this.fail(400, 7502, "database exists");
      const db = { uuid: crypto.randomUUID(), name, created_at: new Date().toISOString() };
      this.d1.push(db);
      return this.ok(db);
    }
    const id = /^\/d1\/database\/([^/]+)$/.exec(suffix)?.[1];
    if (id !== undefined && method === "DELETE") {
      const before = this.d1.length;
      this.d1 = this.d1.filter((d) => d.uuid !== id);
      return before === this.d1.length ? this.fail(404, 7404, "not found") : this.ok(null);
    }
    return this.fail(404, 7003, "no route");
  }

  private async kvRoute(method: string, suffix: string, request: Request): Promise<Response> {
    if (suffix === "/storage/kv/namespaces" && method === "GET") {
      return this.ok(this.kv, { page: 1, per_page: 100, total_pages: 1 });
    }
    if (suffix === "/storage/kv/namespaces" && method === "POST") {
      const { title } = (await request.json()) as { title: string };
      if (this.kv.some((n) => n.title === title)) return this.fail(400, 10014, "title exists");
      const ns = { id: this.id("kv"), title };
      this.kv.push(ns);
      return this.ok(ns);
    }
    const id = /^\/storage\/kv\/namespaces\/([^/]+)$/.exec(suffix)?.[1];
    if (id !== undefined && method === "DELETE") {
      const before = this.kv.length;
      this.kv = this.kv.filter((n) => n.id !== id);
      return before === this.kv.length ? this.fail(404, 10013, "not found") : this.ok(null);
    }
    return this.fail(404, 7003, "no route");
  }

  private async workflowRoute(method: string, name: string, request: Request): Promise<Response> {
    const workflow = this.workflows.get(name);
    if (method === "GET") {
      return workflow === undefined
        ? this.fail(404, 10200, "workflow.not_found")
        : this.ok({ id: name, name, ...workflow });
    }
    if (method === "PUT") {
      const body = (await request.json()) as { script_name: string; class_name: string };
      this.workflows.set(name, { script_name: body.script_name, class_name: body.class_name });
      return this.ok({ id: name, name, ...body });
    }
    if (method === "DELETE") {
      return this.workflows.delete(name)
        ? this.ok(null)
        : this.fail(404, 10200, "workflow.not_found");
    }
    return this.fail(405, 0, "method");
  }

  private async domainsRoute(
    method: string,
    suffix: string,
    url: URL,
    request: Request,
  ): Promise<Response> {
    if (suffix === "/workers/domains" && method === "GET") {
      const hostname = url.searchParams.get("hostname");
      return this.ok(this.domains.filter((d) => hostname === null || d.hostname === hostname));
    }
    if (suffix === "/workers/domains" && method === "PUT") {
      const body = (await request.json()) as { zone_id: string; hostname: string; service: string };
      const existing = this.domains.find((d) => d.hostname === body.hostname);
      if (existing !== undefined) {
        return existing.service === body.service
          ? this.ok(existing)
          : this.fail(409, 100116, "hostname already serves another Worker");
      }
      if (this.dns.some((r) => r.name === body.hostname)) {
        return this.fail(409, 100117, "hostname has DNS records");
      }
      const zone = this.zones.find((z) => z.id === body.zone_id);
      const domain: WorkerDomain = {
        id: this.id("dom"),
        hostname: body.hostname,
        service: body.service,
        zone_id: body.zone_id,
        zone_name: zone?.name ?? "",
      };
      this.domains.push(domain);
      return this.ok(domain);
    }
    const id = /^\/workers\/domains\/([^/]+)$/.exec(suffix)?.[1];
    if (id !== undefined && method === "DELETE") {
      const before = this.domains.length;
      this.domains = this.domains.filter((d) => d.id !== id);
      return before === this.domains.length ? this.fail(404, 100114, "not found") : this.ok(null);
    }
    return this.fail(404, 7003, "no route");
  }
}
