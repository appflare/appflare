import type { WorkflowPutBody } from "@appflare/cf-api";
import type { ArtifactFixture } from "./artifact-fixture";

/**
 * Test-only stateful fake of the Cloudflare API for jobs that change an
 * installed Worker: versions, deployments, D1 Time Travel, the assets upload,
 * and the resource calls an update may make. It also answers the Worker's
 * workers.dev URLs (canonical and version previews) from `health` and
 * `previews`, and serves the artifact through the fixture.
 */

export const ACC = "acc0000000000000000000000000000a";
export const TOKEN = "cf-test-token-DO-NOT-LEAK";
export const SUBDOMAIN = "appflare-dev";

/** One answer of a workers.dev URL or a domain; `location` becomes the `Location` header. */
export interface UrlAnswer {
  status: number;
  body: string;
  location?: string;
}

export interface FakeAccount {
  /** Newest first, as Cloudflare lists them. */
  deployments: Array<{ id: string; versions: Array<{ version_id: string; percentage: number }> }>;
  versions: Array<{
    id: string;
    metadata: Record<string, unknown>;
    modules: string[];
    annotations?: Record<string, string>;
  }>;
  /** `?force=true` of each deployment request, in order. */
  deployForced: boolean[];
  kv: Array<{ id: string; title: string }>;
  d1: Array<{ uuid: string; name: string }>;
  /** Applied D1 migration names per database id. */
  applied: Record<string, string[]>;
  /** Tables the queries created per database id, `d1_migrations` aside. */
  tables: Record<string, number>;
  queries: string[];
  /** The `params` sent with each of `queries`, in order; null for a query sent without. */
  queryParams: Array<unknown[] | null>;
  /** Current bookmark per database id. */
  bookmarks: Record<string, string>;
  restores: Array<{ databaseId: string; bookmark: string }>;
  uploadedAssets: Set<string>;
  schedules: string[] | null;
  subdomainCalls: unknown[];
  /**
   * Workflows that exist in the account (those listed up front belong to
   * another script). As on Cloudflare, no upload creates one: `PUT
   * /workflows/{name}` creates or updates it (`workflowDefs` keeps what each
   * last set), and until then `GET` and starting an instance answer 404
   * (code 10200).
   */
  workflows: string[];
  workflowDefs: Record<string, WorkflowPutBody>;
  /** Instances started, by Workflow name. */
  workflowInstances: Record<string, number>;
  calls: string[];
  /** Answers of the canonical URL, in order (the last one repeats). */
  health: Array<UrlAnswer>;
  /** Answers of any version preview URL, in order (the last one repeats). */
  previews: Array<UrlAnswer>;
  previewHosts: string[];
  /** `has_preview` of uploaded versions. */
  hasPreview: boolean;
  /** Keys (`METHOD /path`) answered once with this status instead of doing the work. */
  failOnce: Map<string, number>;
  /**
   * The query that applies this migration file answers `status`, `times`
   * times: without running, or after running when `after` is set (an answer
   * lost on the way back).
   */
  failMigration?: { file: string; status: number; times: number; after?: boolean };
  /** The Worker whose script routes and workers.dev hosts this fake serves. */
  worker: string;
  /** What `GET /workers/scripts/<worker>/bindings` answers. */
  bindings: unknown[];
  /** Other Workers in the account (`GET /workers/scripts` also lists `worker` once deployed). */
  otherScripts: string[];
  /** Handlers `GET /workers/scripts` lists per Worker; a Worker not named lists none. */
  handlers: Record<string, string[]>;
  /** Cron triggers of the other Workers, by name. */
  otherCrons: Record<string, string[]>;
  /**
   * `PUT .../schedules` answers like a Workers Free account at its cron
   * trigger limit when the other Workers' triggers plus the new ones pass 5.
   */
  freeCronLimit: boolean;
  /** Bodies of `PATCH /workers/workers/<worker>/versions/latest`, in order. */
  versionPatches: unknown[];
  queues: Array<{ queue_id: string; queue_name: string }>;
  /** Worker consumers per queue id, as their last create or update body left them. */
  consumers: Record<string, Array<Record<string, unknown> & { consumer_id: string }>>;
  /** The sandbox Worker's version at 100% (`GET /workers/scripts/appflare-sandbox/deployments`). */
  sandboxDeployed: string;
  /** Answers of custom domain hosts, in order per host (the last one repeats). */
  domainHealth: Record<string, Array<UrlAnswer>>;
  /** Custom domain hosts probed, in order. */
  domainProbes: string[];
  /** A version upload answers without the new version's id (the version is made all the same). */
  uploadWithoutId: boolean;
  /** Secret names a version has (`GET .../versions/<id>` lists them as `secret_text` bindings). */
  versionSecrets: Record<string, string[]>;
  /**
   * The bindings of versions this fake did not upload (the one serving when
   * a test starts), as `GET .../versions/<id>` lists them.
   */
  versionBindings: Record<string, unknown[]>;
  /** Metadata indexes by Vectorize index, as listed (created ones are added). */
  metadataIndexes: Record<string, Array<{ propertyName: string; indexType: string }>>;
  /** Lifecycle rules by R2 bucket, as last put (a bucket never put has Cloudflare's default). */
  lifecycle: Record<string, unknown[]>;
  /** Keys (`METHOD /path`) whose next call does its work and then answers 500 (a lost answer). */
  failAfter: Set<string>;
}

/** The rule Cloudflare gives every new R2 bucket. */
export const DEFAULT_MULTIPART_RULE = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
};

/** The sandbox Worker's deployed version, unless a test sets another. */
export const SANDBOX_DEPLOYED_VERSION = "5a5d0000-0000-4000-8000-00000000d001";

export const NEW_VERSION = "0a1b2c3d-4e5f-4789-8bcd-ef0123456789";

export function fakeAccount(fixture: ArtifactFixture | null, over: Partial<FakeAccount> = {}) {
  const state: FakeAccount = {
    deployments: [],
    versions: [],
    deployForced: [],
    kv: [],
    d1: [],
    applied: {},
    tables: {},
    queries: [],
    queryParams: [],
    bookmarks: {},
    restores: [],
    uploadedAssets: new Set(),
    schedules: null,
    subdomainCalls: [],
    workflows: [],
    workflowDefs: {},
    workflowInstances: {},
    calls: [],
    health: [{ status: 200, body: "ok" }],
    previews: [
      { status: 404, body: "error code: 1042" },
      { status: 200, body: "new version" },
    ],
    previewHosts: [],
    hasPreview: true,
    failOnce: new Map(),
    worker: "cut",
    bindings: [],
    otherScripts: [],
    handlers: {},
    otherCrons: {},
    freeCronLimit: false,
    versionPatches: [],
    queues: [],
    consumers: {},
    sandboxDeployed: SANDBOX_DEPLOYED_VERSION,
    versionSecrets: {},
    versionBindings: {},
    domainHealth: {},
    domainProbes: [],
    uploadWithoutId: false,
    metadataIndexes: {},
    lifecycle: {},
    failAfter: new Set(),
    ...over,
  };
  const script = `/workers/scripts/${state.worker}`;
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, message: string) =>
    Response.json({ success: false, errors: [{ code: 10000, message }] }, { status });
  const workflowNotFound = () =>
    Response.json(
      {
        success: false,
        errors: [{ code: 10200, message: "workflows.api.error.workflow.not_found" }],
      },
      { status: 404 },
    );
  const next = (list: Array<UrlAnswer>) => {
    const answer = list.length > 1 ? list.shift() : list[0];
    return new Response(answer?.body ?? "", {
      status: answer?.status ?? 500,
      ...(answer?.location === undefined ? {} : { headers: { location: answer.location } }),
    });
  };

  async function cloudflare(request: Request): Promise<Response> {
    const answer = await cloudflareAnswer(request);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname.replace(`/client/v4/accounts/${ACC}`, "")}`;
    if (answer.ok && state.failAfter.delete(key)) return fail(500, "answer lost after the work");
    return answer;
  }

  async function cloudflareAnswer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    state.calls.push(key);
    const auth = request.headers.get("authorization");
    if (path !== "/workers/assets/upload" && auth !== `Bearer ${TOKEN}`) return fail(403, "auth");
    const failing = state.failOnce.get(key);
    if (failing !== undefined) {
      state.failOnce.delete(key);
      return fail(failing, "injected failure");
    }
    switch (key) {
      case "GET /workers/scripts/appflare-sandbox/deployments":
        return ok({
          deployments: [
            {
              id: "sandbox-dep",
              versions: [{ version_id: state.sandboxDeployed, percentage: 100 }],
            },
          ],
        });
      case "GET /workers/subdomain":
        return ok({ subdomain: SUBDOMAIN });
      case "GET /workers/scripts":
        return ok(
          [...(state.deployments.length > 0 ? [state.worker] : []), ...state.otherScripts].map(
            (id) => ({
              id,
              ...(state.handlers[id] === undefined ? {} : { handlers: state.handlers[id] }),
            }),
          ),
          { result_info: { page: 1, total_pages: 1 } },
        );
      case `GET ${script}/versions`: {
        // Newest first; the serving version counts as uploaded first.
        const serving = state.deployments.at(-1)?.versions[0]?.version_id;
        const items = [
          ...state.versions
            .map((v, i) => ({
              id: v.id,
              number: i + 2,
              ...(v.annotations === undefined ? {} : { annotations: v.annotations }),
            }))
            .reverse(),
          ...(serving === undefined ? [] : [{ id: serving, number: 1 }]),
        ];
        return ok({ items });
      }
      case `PATCH /workers/workers/${state.worker}/versions/latest`: {
        const body = (await request.json()) as { annotations?: Record<string, string> };
        state.versionPatches.push(body);
        const id = state.versions.length === 0 ? NEW_VERSION : `version-${state.versions.length}`;
        state.versions.push({
          id,
          metadata: { patch: body },
          modules: [],
          ...(body.annotations === undefined ? {} : { annotations: body.annotations }),
        });
        return ok({ id, number: state.versions.length + 1 });
      }
      case `GET ${script}/bindings`:
        return ok(state.bindings);
      case `GET ${script}/deployments`:
        return ok({ deployments: state.deployments });
      case `POST ${script}/deployments`: {
        state.deployForced.push(url.searchParams.get("force") === "true");
        const body = (await request.json()) as {
          versions: Array<{ version_id: string; percentage: number }>;
        };
        const known = new Set([
          ...state.versions.map((v) => v.id),
          ...state.deployments.flatMap((d) => d.versions.map((v) => v.version_id)),
        ]);
        if (body.versions.some((v) => !known.has(v.version_id))) {
          return fail(400, "no such version");
        }
        const deployment = { id: `dep-${state.deployments.length + 1}`, versions: body.versions };
        state.deployments.unshift(deployment);
        return ok(deployment);
      }
      case `POST ${script}/versions`: {
        const form = await request.formData();
        const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
        const id = state.versions.length === 0 ? NEW_VERSION : `version-${state.versions.length}`;
        const annotations = metadata.annotations as Record<string, string> | undefined;
        state.versions.push({
          id,
          metadata,
          modules: [...form.keys()].filter((k) => k !== "metadata"),
          ...(annotations === undefined ? {} : { annotations }),
        });
        return ok({
          ...(state.uploadWithoutId ? {} : { id }),
          number: state.versions.length,
          metadata: { has_preview: state.hasPreview },
        });
      }
      case `PUT ${script}`: {
        // A full deploy: the new version serves at once.
        const form = await request.formData();
        const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
        const id = state.versions.length === 0 ? NEW_VERSION : `version-${state.versions.length}`;
        state.versions.push({
          id,
          metadata,
          modules: [...form.keys()].filter((k) => k !== "metadata"),
        });
        state.deployments.unshift({
          id: `dep-${state.deployments.length + 1}`,
          versions: [{ version_id: id, percentage: 100 }],
        });
        return ok({ id: state.worker, deployment_id: id.replace(/-/g, "") });
      }
      case `DELETE ${script}`:
        // The Worker and its deployments go; uploading it again starts over.
        state.deployments = [];
        state.versions = [];
        return ok(null);
      case `POST ${script}/subdomain`:
        state.subdomainCalls.push(await request.json());
        return ok({ enabled: true, previews_enabled: true });
      case `PUT ${script}/schedules`: {
        const body = (await request.json()) as Array<{ cron: string }>;
        const others = Object.values(state.otherCrons).flat().length;
        if (state.freeCronLimit && others + body.length > 5) {
          // Cloudflare's answer, as a free account got it (account id replaced).
          return Response.json(
            {
              result: null,
              success: false,
              errors: [
                {
                  code: 10072,
                  message:
                    "This account has reached the Workers Free limit of 5 cron triggers per account. Upgrade to Workers Paid to increase this limit to 1,000: https://dash.cloudflare.com/<account>/workers/plans",
                },
              ],
              messages: [],
            },
            { status: 400 },
          );
        }
        state.schedules = body.map((s) => s.cron);
        return ok({ schedules: body });
      }
      case "GET /storage/kv/namespaces":
        return ok(state.kv, { result_info: { page: 1, total_pages: 1 } });
      case "POST /storage/kv/namespaces": {
        const { title } = (await request.json()) as { title: string };
        const ns = { id: `kv-new-${state.kv.length + 1}`, title };
        state.kv.push(ns);
        return ok(ns);
      }
      case "GET /d1/database":
        return ok(state.d1, { result_info: { page: 1, total_pages: 1 } });
      case "POST /d1/database": {
        const { name } = (await request.json()) as { name: string };
        const db = { uuid: `d1-new-${state.d1.length + 1}`, name };
        state.d1.push(db);
        return ok(db);
      }
      case "GET /queues":
        return ok(state.queues);
      case "POST /queues": {
        const { queue_name } = (await request.json()) as { queue_name: string };
        const queue = { queue_id: `q-new-${state.queues.length + 1}`, queue_name };
        state.queues.push(queue);
        return ok(queue);
      }
      case `POST ${script}/assets-upload-session`: {
        const { manifest } = (await request.json()) as {
          manifest: Record<string, { hash: string }>;
        };
        const needed = Object.values(manifest)
          .map((e) => e.hash)
          .filter((h) => !state.uploadedAssets.has(h));
        return ok({ jwt: "session-jwt", buckets: needed.length === 0 ? [] : [needed] });
      }
      case "POST /workers/assets/upload": {
        if (auth !== "Bearer session-jwt") return fail(401, "bad jwt");
        const form = await request.formData();
        for (const hash of form.keys()) state.uploadedAssets.add(hash);
        return ok({ jwt: "completion-jwt" });
      }
    }
    const metadataIndex =
      /^(GET|POST) \/vectorize\/v2\/indexes\/([^/]+)\/metadata_index\/(list|create)$/.exec(key);
    if (metadataIndex?.[2] !== undefined) {
      state.metadataIndexes[metadataIndex[2]] ??= [];
      const list = state.metadataIndexes[metadataIndex[2]] ?? [];
      if (metadataIndex[3] === "list") return ok({ metadataIndexes: list });
      const body = (await request.json()) as { propertyName: string; indexType: string };
      if (list.some((m) => m.propertyName === body.propertyName)) {
        return fail(409, "a metadata index on this property already exists");
      }
      list.push(body);
      return ok({ mutationId: `m${list.length}` });
    }
    const lifecycle = /^(GET|PUT) \/r2\/buckets\/([^/]+)\/lifecycle$/.exec(key);
    if (lifecycle?.[2] !== undefined) {
      const bucket = lifecycle[2];
      if (lifecycle[1] === "GET") {
        return ok({ rules: state.lifecycle[bucket] ?? [DEFAULT_MULTIPART_RULE] });
      }
      state.lifecycle[bucket] = ((await request.json()) as { rules: unknown[] }).rules;
      return ok({});
    }
    const consumers = /^(GET|POST) \/queues\/([^/]+)\/consumers$/.exec(key);
    if (consumers?.[2] !== undefined) {
      const queueId = consumers[2];
      state.consumers[queueId] ??= [];
      const list = state.consumers[queueId];
      if (consumers[1] === "GET") return ok(list);
      const consumer = {
        ...((await request.json()) as Record<string, unknown>),
        consumer_id: `c-${queueId}-${list.length + 1}`,
      };
      list.push(consumer);
      return ok(consumer);
    }
    const consumer = /^(PUT|DELETE) \/queues\/([^/]+)\/consumers\/([^/]+)$/.exec(key);
    if (consumer?.[2] !== undefined && consumer[3] !== undefined) {
      const list = state.consumers[consumer[2]] ?? [];
      const at = list.findIndex((c) => c.consumer_id === consumer[3]);
      if (at === -1) return fail(404, "consumer not found");
      if (consumer[1] === "DELETE") {
        list.splice(at, 1);
        return ok(null);
      }
      const updated = {
        ...((await request.json()) as Record<string, unknown>),
        consumer_id: consumer[3],
      };
      list[at] = updated;
      return ok(updated);
    }
    const version = new RegExp(`^GET ${script}/versions/([^/]+)$`).exec(key);
    if (version?.[1] !== undefined) {
      const id = version[1];
      const uploaded = state.versions.find((v) => v.id === id);
      const secrets = state.versionSecrets[id];
      const given = state.versionBindings[id];
      if (uploaded === undefined && secrets === undefined && given === undefined) {
        return fail(404, "version not found");
      }
      const bindings = [
        ...(((uploaded?.metadata.bindings as unknown[] | undefined) ?? []) as unknown[]),
        ...(given ?? []),
        ...(secrets ?? []).map((name) => ({ type: "secret_text", name })),
      ];
      return ok({ id, resources: { bindings } });
    }
    const schedules = /^GET \/workers\/scripts\/([^/]+)\/schedules$/.exec(key);
    if (schedules?.[1] !== undefined) {
      const name = schedules[1];
      if (name === state.worker) {
        return ok({ schedules: (state.schedules ?? []).map((cron) => ({ cron })) });
      }
      if (state.otherScripts.includes(name)) {
        return ok({ schedules: (state.otherCrons[name] ?? []).map((cron) => ({ cron })) });
      }
      return fail(404, "This Worker does not exist on your account.");
    }
    let m = /^(GET|PUT) \/workflows\/([^/]+)$/.exec(key);
    if (m?.[2] !== undefined) {
      const name = m[2];
      if (m[1] === "PUT") {
        const body = (await request.json()) as WorkflowPutBody;
        if (!state.workflows.includes(name)) state.workflows.push(name);
        state.workflowDefs[name] = body;
        return ok({ id: `wf-${name}`, name, ...body });
      }
      if (!state.workflows.includes(name)) return workflowNotFound();
      // As Cloudflare answers: its schedules only when it has some, and none
      // of its other settings.
      const def = state.workflowDefs[name];
      const schedules = def?.schedules ?? [];
      return ok({
        id: `wf-${name}`,
        name,
        script_name: def?.script_name ?? "someone",
        ...(def === undefined ? {} : { class_name: def.class_name }),
        ...(schedules.length === 0
          ? {}
          : { schedules: schedules.map((s) => ({ ...s, next_instance: "2026-10-06T00:00:00Z" })) }),
      });
    }
    m = /^POST \/workflows\/([^/]+)\/instances$/.exec(key);
    if (m?.[1] !== undefined) {
      if (!state.workflows.includes(m[1])) return workflowNotFound();
      const n = (state.workflowInstances[m[1]] ?? 0) + 1;
      state.workflowInstances[m[1]] = n;
      return ok({ id: `instance-${n}`, status: "queued" });
    }
    m = /^GET \/d1\/database\/([^/]+)\/time_travel\/bookmark$/.exec(key);
    if (m?.[1] !== undefined) {
      const bookmark = state.bookmarks[m[1]];
      return bookmark === undefined ? fail(404, "database not found") : ok({ bookmark });
    }
    m = /^POST \/d1\/database\/([^/]+)\/time_travel\/restore$/.exec(key);
    if (m?.[1] !== undefined) {
      const current = state.bookmarks[m[1]];
      const bookmark = url.searchParams.get("bookmark");
      if (current === undefined || bookmark === null) return fail(404, "database not found");
      state.restores.push({ databaseId: m[1], bookmark });
      state.bookmarks[m[1]] = `${current}-after-restore`;
      return ok({ bookmark, previous_bookmark: current, message: "restored" });
    }
    m = /^POST \/d1\/database\/([^/]+)\/query$/.exec(key);
    if (m?.[1] !== undefined) {
      const applied = state.applied[m[1]] ?? [];
      state.applied[m[1]] = applied;
      const { sql, params } = (await request.json()) as { sql: string; params?: unknown[] };
      const failing = state.failMigration;
      const failNow =
        failing !== undefined && failing.times > 0 && sql.endsWith(`values ('${failing.file}');`);
      if (failNow) failing.times -= 1;
      if (failNow && failing.after !== true)
        return fail(failing.status, 'near "BROKEN": syntax error');
      state.queries.push(sql);
      state.queryParams.push(params ?? null);
      if (sql.startsWith("SELECT (SELECT count(*) FROM sqlite_master")) {
        const counts = { tables: state.tables[m[1]] ?? 0, recorded: applied.length };
        return ok([{ results: [counts], success: true, meta: {} }]);
      }
      if (sql.startsWith("SELECT")) {
        return ok([
          { results: applied.map((name, i) => ({ id: i + 1, name })), success: true, meta: {} },
        ]);
      }
      const created = (
        sql.match(/CREATE (?:VIRTUAL )?TABLE (?!IF NOT EXISTS "d1_migrations")/g) ?? []
      ).length;
      state.tables[m[1]] = (state.tables[m[1]] ?? 0) + created;
      // A baseline's records: several rows, and names already there stay once.
      const recordAt = sql.indexOf('INSERT OR IGNORE INTO "d1_migrations"');
      if (recordAt !== -1) {
        for (const row of sql.slice(recordAt).matchAll(/\('((?:[^']|'')*)'\)/g)) {
          const name = (row[1] ?? "").replace(/''/g, "'");
          if (!applied.includes(name)) applied.push(name);
        }
        return ok([{ results: [], success: true, meta: {} }]);
      }
      const inserted = /values \('([^']+)'\);$/.exec(sql);
      if (inserted?.[1] !== undefined) applied.push(inserted[1]);
      if (failNow) return fail(failing.status, "internal error");
      // A statement with bound values (a seed's INSERT) adds its row.
      return ok([{ results: [], success: true, meta: params === undefined ? {} : { changes: 1 } }]);
    }
    const deleted = /^DELETE \/(storage\/kv\/namespaces|d1\/database)\/([^/]+)$/.exec(key);
    if (deleted !== null) {
      const id = deleted[2];
      const before = state.kv.length + state.d1.length;
      state.kv = state.kv.filter((n) => n.id !== id);
      state.d1 = state.d1.filter((d) => d.uuid !== id);
      return state.kv.length + state.d1.length < before ? ok(null) : fail(404, "not found");
    }
    return fail(404, `no route ${key}`);
  }

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.startsWith("https://api.cloudflare.com/")) {
      return cloudflare(new Request(input, init));
    }
    const host = new URL(input).host;
    if (host === `${state.worker}.${SUBDOMAIN}.workers.dev`) return next(state.health);
    if (host.endsWith(`-${state.worker}.${SUBDOMAIN}.workers.dev`)) {
      state.previewHosts.push(host);
      return next(state.previews);
    }
    const domain = state.domainHealth[host];
    if (domain !== undefined) {
      state.domainProbes.push(host);
      return next(domain);
    }
    return fixture?.serve(input, init) ?? new Response("not found", { status: 404 });
  };
  return { state, fetch };
}
