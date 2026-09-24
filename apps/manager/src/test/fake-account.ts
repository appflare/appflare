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
  queries: string[];
  /** Current bookmark per database id. */
  bookmarks: Record<string, string>;
  restores: Array<{ databaseId: string; bookmark: string }>;
  uploadedAssets: Set<string>;
  schedules: string[] | null;
  subdomainCalls: unknown[];
  workflows: string[];
  calls: string[];
  /** Answers of the canonical URL, in order (the last one repeats). */
  health: Array<{ status: number; body: string }>;
  /** Answers of any version preview URL, in order (the last one repeats). */
  previews: Array<{ status: number; body: string }>;
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
}

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
    queries: [],
    bookmarks: {},
    restores: [],
    uploadedAssets: new Set(),
    schedules: null,
    subdomainCalls: [],
    workflows: [],
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
    ...over,
  };
  const script = `/workers/scripts/${state.worker}`;
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, message: string) =>
    Response.json({ success: false, errors: [{ code: 10000, message }] }, { status });
  const next = (list: Array<{ status: number; body: string }>) => {
    const answer = list.length > 1 ? list.shift() : list[0];
    return new Response(answer?.body ?? "", { status: answer?.status ?? 500 });
  };

  async function cloudflare(request: Request): Promise<Response> {
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
        state.versions.push({
          id,
          metadata,
          modules: [...form.keys()].filter((k) => k !== "metadata"),
        });
        return ok({
          id,
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
    let m = /^GET \/workflows\/([^/]+)$/.exec(key);
    if (m?.[1] !== undefined) {
      return state.workflows.includes(m[1])
        ? ok({ id: "wf", name: m[1], script_name: "someone" })
        : fail(404, "Workflow not found");
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
      const { sql } = (await request.json()) as { sql: string };
      const failing = state.failMigration;
      const failNow =
        failing !== undefined && failing.times > 0 && sql.endsWith(`values ('${failing.file}');`);
      if (failNow) failing.times -= 1;
      if (failNow && failing.after !== true)
        return fail(failing.status, 'near "BROKEN": syntax error');
      state.queries.push(sql);
      if (sql.startsWith("SELECT")) {
        return ok([
          { results: applied.map((name, i) => ({ id: i + 1, name })), success: true, meta: {} },
        ]);
      }
      const inserted = /values \('([^']+)'\);$/.exec(sql);
      if (inserted?.[1] !== undefined) applied.push(inserted[1]);
      if (failNow) return fail(failing.status, "internal error");
      return ok([{ results: [], success: true, meta: {} }]);
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
    return fixture?.serve(input, init) ?? new Response("not found", { status: 404 });
  };
  return { state, fetch };
}
