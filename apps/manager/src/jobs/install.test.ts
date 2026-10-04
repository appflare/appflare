import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type CatalogD1Seed, type SigningKey, withRevisedCatalog } from "@appflare/schema";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { readCatalogRevision } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { StartInstallInput } from "../installs/install-input";
import { startInstallCore } from "../installs/start-install.server";
import { accessChallenge } from "../test/access-sign-in";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  baseCatalog,
  buildArtifactFixture,
  REVISED_URL,
  ZIP_URL,
} from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { redirectingArtifactHost, STORAGE_URL } from "../test/redirecting-host";
import { entryJobCost, otherWorkerCost } from "./entry-budget";
import { entryWorkers } from "./entry-workers";
import { API_STEP, type InstallJobParams, runInstall } from "./install";
import type { JobEnv } from "./run-job";

/**
 * End-to-end test of the install job against a stateful
 * fake of the Cloudflare API, a Range-capable fake artifact host, and the local
 * D1. The Workflow engine is replaced by `fakeStep` (inline steps, recorded
 * sleeps); a live install against a real account covers the engine.
 */

const ACC = "acc0000000000000000000000000000a";
const TOKEN = "cf-test-token-DO-NOT-LEAK";
const PASSWORD = "admin-password-DO-NOT-LEAK";
/** The R2 API token an admin enters for a Pipelines sink. */
const SINK_TOKEN = "sink-token-DO-NOT-LEAK";
const HEALTH_URL = "https://cut.appflare-dev.workers.dev/";
const WORKER_ORIGIN = "https://cut.appflare-dev.workers.dev";
const VERSION_HEX = "0123456789abcdef0123456789abcdef";
/** The rule Cloudflare gives every new bucket. */
const DEFAULT_MULTIPART_RULE = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
};

interface FakeState {
  scripts: string[];
  kv: Array<{ id: string; title: string }>;
  d1: Array<{ uuid: string; name: string }>;
  applied: string[];
  queries: string[];
  /** The `params` sent with each of `queries`; null for a query sent without. */
  queryParams: Array<unknown[] | null>;
  uploaded: Set<string>;
  bucketHashes: string[];
  bucketUploads: number;
  metadata: Record<string, unknown> | null;
  modules: string[];
  secrets: Record<string, string>;
  schedules: string[];
  /** Cron triggers of the account's other Workers (each must be in `scripts` too). */
  otherCrons: Record<string, string[]>;
  /** Handlers `GET /workers/scripts` lists per Worker; a Worker not named lists none. */
  handlers: Record<string, string[]>;
  /** `PUT .../schedules` answers like a Workers Free account at its cron trigger limit. */
  freeCronLimit: boolean;
  subdomainEnabled: unknown;
  calls: string[];
  health: Array<{ status: number; body: string }>;
  /** Every URL the health check requested on the Worker's host, in order. */
  healthUrls: string[];
  /** Called on each health request (a test's fake clock makes probes slow). */
  onHealthProbe?: () => void;
  workflows: string[];
  /** Keys (`METHOD /path`) whose next call does its work and then answers 500. */
  failAfter: Set<string>;
  /** The query that applies this migration file answers `status`, without running, `times` times. */
  failMigration?: { file: string; status: number; times: number };
  /** When set, the script upload is refused with this status. */
  uploadStatus?: number;
  /** When set, the upload of the app's other Worker of this name is refused with `status`. */
  otherUploadStatus?: { name: string; status: number };
  r2: string[];
  /** False: every R2 call is refused the way Cloudflare refuses an account without R2. */
  r2Enabled: boolean;
  /** Vectorize indexes with the create body each was made from. */
  vectorize: Array<{ name: string; config: unknown }>;
  /** Metadata indexes by Vectorize index, as created. */
  metadataIndexes: Record<string, Array<{ propertyName: string; indexType: string }>>;
  /** Lifecycle rules by R2 bucket, as last put (a bucket never put has Cloudflare's default). */
  lifecycle: Record<string, unknown[]>;
  /** Hyperdrive configurations with the create body each was made from. */
  hyperdrive: Array<{ id: string; name: string; origin: unknown }>;
  /** When set, creating a Hyperdrive configuration is refused with this message. */
  hyperdriveRefusal?: string;
  /** The token lacks Hyperdrive: every Hyperdrive call answers 403. */
  hyperdriveTokenRefused?: boolean;
  /** Pipelines streams, sinks and pipelines, each with the body it was created from. */
  streams: Array<{ id: string; name: string; body: Record<string, unknown> }>;
  sinks: Array<{ id: string; name: string; body: Record<string, unknown> }>;
  pipelines: Array<{ id: string; name: string; body: Record<string, unknown> }>;
  /** The manager's token lacks Pipelines: every Pipelines call answers 403, code 100. */
  pipelinesTokenRefused?: boolean;
  /** R2 Data Catalogs by bucket. */
  catalogs: Record<string, { id: string; status: string }>;
  /** Each R2 Data Catalog call as `METHOD /path as <sink|manager>`, with its body when it has one. */
  catalogCalls: Array<{ call: string; body?: unknown }>;
  /** The catalog refuses the maintenance settings with this status. */
  maintenanceStatus?: number;
  /** The zip answers like a GitHub release asset: a 302 to a signed storage URL. */
  artifactRedirect: boolean;
  /** Files per upload bucket the session asks for (default: one bucket for all). */
  bucketSize?: number;
  /** The session asks for one upload request per file (`wrangler_single_asset_uploads`). */
  singleUploads: boolean;
  /** When set, requests for the zip throw this error from `fetch`. */
  artifactThrows?: string;
  /** Every request, by the step that was running (`step.names.at(-1)`). */
  requestsByStep: Record<string, string[]>;
  /** The running step's name; `install` wires it to the fake step. */
  stepOf?: () => string | undefined;
  queues: Array<{ queue_id: string; queue_name: string }>;
  /** Consumers per queue id, with the body each was created from. */
  consumers: Record<string, Array<Record<string, unknown> & { consumer_id: string }>>;
  /** The app's other Workers (`cut-<name>`), each with what its calls set. */
  others: Record<string, OtherScript>;
  /** The account's Access objects: `/access/*` calls go to this fake. */
  access?: ReturnType<typeof fakeAccessAccount>;
  /** Answers the Worker's own URL instead of `health`, from the request's headers. */
  healthAnswer?: (url: string, headers: Headers) => Response;
}

/** What the fake records for an app's Worker other than `cut`. */
interface OtherScript {
  metadata: Record<string, unknown> | null;
  secrets: Record<string, string>;
  schedules: string[];
  subdomain: unknown;
}

function fakeWorld(fixture: ArtifactFixture, over: Partial<FakeState> = {}) {
  const state: FakeState = {
    scripts: ["appflare"],
    kv: [],
    d1: [],
    applied: [],
    queries: [],
    queryParams: [],
    uploaded: new Set(),
    bucketHashes: fixture.manifest.assets.files.map((f) => f.hash),
    bucketUploads: 0,
    metadata: null,
    modules: [],
    secrets: {},
    schedules: [],
    otherCrons: {},
    handlers: {},
    freeCronLimit: false,
    subdomainEnabled: null,
    calls: [],
    health: [
      { status: 404, body: "error code: 1042\n" },
      { status: 200, body: "<html>cut</html>" },
    ],
    healthUrls: [],
    workflows: [],
    failAfter: new Set(),
    r2: [],
    r2Enabled: true,
    vectorize: [],
    metadataIndexes: {},
    lifecycle: {},
    hyperdrive: [],
    streams: [],
    sinks: [],
    pipelines: [],
    catalogs: {},
    catalogCalls: [],
    artifactRedirect: false,
    singleUploads: false,
    requestsByStep: {},
    queues: [],
    consumers: {},
    others: {},
    ...over,
  };
  const host = redirectingArtifactHost(fixture);
  const sessionJwt = state.singleUploads
    ? `e30.${btoa(JSON.stringify({ wrangler_single_asset_uploads: true })).replace(/=+$/, "")}.sig`
    : "session-jwt";
  function storeUpload(hashes: Iterable<string>) {
    for (const hash of hashes) state.uploaded.add(hash);
    state.bucketUploads += 1;
    const done = state.bucketHashes.every((h) => state.uploaded.has(h));
    return ok({ jwt: done ? "completion-jwt" : null });
  }
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });

  async function cloudflare(request: Request): Promise<Response> {
    const response = await route(request);
    const key = `${request.method} ${new URL(request.url).pathname.replace(`/client/v4/accounts/${ACC}`, "")}`;
    if (state.failAfter.delete(key)) {
      return Response.json(
        { success: false, errors: [{ code: 10013, message: "internal error" }] },
        { status: 500 },
      );
    }
    return response;
  }

  /** R2 Data Catalog, which takes the app's catalog token as well as the manager's. */
  async function catalog(request: Request, path: string, auth: string | null) {
    const who =
      auth === `Bearer ${SINK_TOKEN}` ? "sink" : auth === `Bearer ${TOKEN}` ? "manager" : null;
    if (who === null) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "auth" }] },
        { status: 403 },
      );
    }
    const text = await request.text();
    const url = new URL(request.url);
    const call = `${request.method} ${path}${url.search} as ${who}`;
    state.catalogCalls.push(text.length > 0 ? { call, body: JSON.parse(text) } : { call });
    const [, bucket = "", action] = /^\/r2-catalog\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
    const notFound = () =>
      Response.json(
        { success: false, errors: [{ code: 40401, message: "Catalog not found" }] },
        { status: 404 },
      );
    switch (`${request.method} ${action ?? ""}`) {
      case "GET ": {
        const found = state.catalogs[bucket];
        return found === undefined ? notFound() : ok({ bucket, ...found });
      }
      case "POST enable": {
        const id = `cat-${Object.keys(state.catalogs).length + 1}`;
        state.catalogs[bucket] = { id, status: "active" };
        return ok({ id, name: `${ACC}_${bucket}` });
      }
      case "POST delete": {
        if (state.catalogs[bucket] === undefined) return notFound();
        delete state.catalogs[bucket];
        return new Response(null, { status: 204 });
      }
      case "POST credential":
        return ok(null);
      case "POST maintenance-configs":
        if (state.maintenanceStatus !== undefined) {
          return Response.json(
            { success: false, errors: [{ code: 40000, message: "bad maintenance" }] },
            { status: state.maintenanceStatus },
          );
        }
        return ok(null);
      default:
        return Response.json({ success: false, errors: [] }, { status: 404 });
    }
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    state.calls.push(key);
    const auth = request.headers.get("authorization");
    if (path.startsWith("/r2-catalog/")) return catalog(request, path, auth);
    if (path.startsWith("/pipelines/") && state.pipelinesTokenRefused === true) {
      return Response.json(
        { success: false, errors: [{ code: 100, message: "Forbidden" }] },
        { status: 403 },
      );
    }
    if (!path.startsWith("/workers/assets/upload") && auth !== `Bearer ${TOKEN}`) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "auth" }] },
        { status: 403 },
      );
    }
    if (path.startsWith("/access/") && state.access !== undefined) {
      const text = request.body === null ? undefined : await request.text();
      return state.access.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(text === undefined || text === "" ? {} : { body: text }),
      });
    }
    if (path.startsWith("/hyperdrive/") && state.hyperdriveTokenRefused === true) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      );
    }
    if (path.startsWith("/r2/") && !state.r2Enabled) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
        },
        { status: 403 },
      );
    }
    const otherScript =
      /^(?:PUT|POST) \/workers\/scripts\/(cut-[a-z0-9-]+)(?:\/(secrets|schedules|subdomain|assets-upload-session))?$/.exec(
        key,
      );
    if (otherScript?.[1] !== undefined) {
      const name = otherScript[1];
      state.others[name] ??= { metadata: null, secrets: {}, schedules: [], subdomain: null };
      const w = state.others[name];
      switch (otherScript[2]) {
        case undefined: {
          if (state.otherUploadStatus?.name === name) {
            return Response.json(
              { success: false, errors: [{ code: 10021, message: "script refused" }] },
              { status: state.otherUploadStatus.status },
            );
          }
          const form = await request.formData();
          w.metadata = JSON.parse(String(form.get("metadata")));
          state.scripts.push(name);
          return ok({ id: name, deployment_id: VERSION_HEX, tag: `tag-${name}` });
        }
        case "secrets": {
          const body = (await request.json()) as { name: string; text: string };
          w.secrets[body.name] = body.text;
          return ok({ name: body.name, type: "secret_text" });
        }
        case "schedules": {
          const body = (await request.json()) as Array<{ cron: string }>;
          w.schedules = body.map((s) => s.cron);
          return ok({ schedules: body });
        }
        case "subdomain":
          w.subdomain = await request.json();
          return ok({ enabled: true, previews_enabled: true });
        default:
          return ok({ jwt: sessionJwt, buckets: [] });
      }
    }
    const metadataIndex =
      /^(GET|POST) \/vectorize\/v2\/indexes\/([^/]+)\/metadata_index\/(list|create)$/.exec(key);
    if (metadataIndex?.[2] !== undefined) {
      state.metadataIndexes[metadataIndex[2]] ??= [];
      const list = state.metadataIndexes[metadataIndex[2]] ?? [];
      if (metadataIndex[3] === "list") return ok({ metadataIndexes: list });
      list.push((await request.json()) as { propertyName: string; indexType: string });
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
    switch (key) {
      case "GET /r2/buckets": {
        const contains = url.searchParams.get("name_contains") ?? "";
        return ok({
          buckets: state.r2.filter((n) => n.includes(contains)).map((name) => ({ name })),
        });
      }
      case "POST /r2/buckets": {
        const { name } = (await request.json()) as { name: string };
        state.r2.push(name);
        return ok({ name });
      }
      case "GET /pipelines/v1/streams":
      case "GET /pipelines/v1/sinks":
      case "GET /pipelines/v1/pipelines": {
        const list =
          state[path.slice("/pipelines/v1/".length) as "streams" | "sinks" | "pipelines"];
        const perPage = Number(url.searchParams.get("per_page") ?? "20");
        return ok(
          list.slice(0, perPage).map(({ id, name }) => ({ id, name })),
          {
            result_info: {
              page: 1,
              per_page: perPage,
              count: list.length,
              total_count: list.length,
            },
          },
        );
      }
      case "POST /pipelines/v1/streams":
      case "POST /pipelines/v1/sinks":
      case "POST /pipelines/v1/pipelines": {
        const what = path.slice("/pipelines/v1/".length) as "streams" | "sinks" | "pipelines";
        const body = (await request.json()) as Record<string, unknown> & { name: string };
        const id = `${what}-${state[what].length + 1}`;
        state[what].push({ id, name: body.name, body });
        return ok({ id, name: body.name });
      }
      case "GET /hyperdrive/configs":
        return ok(
          state.hyperdrive.map(({ id, name }) => ({ id, name })),
          { result_info: { page: 1, per_page: 100, total_count: state.hyperdrive.length } },
        );
      case "POST /hyperdrive/configs": {
        if (state.hyperdriveRefusal !== undefined) {
          return Response.json(
            { success: false, errors: [{ code: 2008, message: state.hyperdriveRefusal }] },
            { status: 400 },
          );
        }
        const body = (await request.json()) as { name: string; origin: unknown };
        const id = `hd-${state.hyperdrive.length + 1}`;
        state.hyperdrive.push({ id, ...body });
        return ok({ id, name: body.name });
      }
      case "GET /vectorize/v2/indexes":
        return ok(state.vectorize.map(({ name, config }) => ({ name, config })));
      case "POST /vectorize/v2/indexes": {
        const body = (await request.json()) as { name: string; config: unknown };
        state.vectorize.push(body);
        return ok({ name: body.name, config: body.config });
      }
      case "GET /tokens/verify":
        return ok({ id: "t", status: "active" });
      case "GET /workers/scripts":
        return ok(
          state.scripts.map((id) => ({
            id,
            tag: `tag-${id}`,
            ...(state.handlers[id] === undefined ? {} : { handlers: state.handlers[id] }),
          })),
        );
      case "GET /storage/kv/namespaces":
        return ok(state.kv, { result_info: { page: 1, total_pages: 1 } });
      case "POST /storage/kv/namespaces": {
        const { title } = (await request.json()) as { title: string };
        const ns = { id: `kv-${state.kv.length + 1}`, title };
        state.kv.push(ns);
        return ok(ns);
      }
      case "GET /d1/database":
        return ok(state.d1, { result_info: { page: 1, total_pages: 1 } });
      case "POST /d1/database": {
        const { name } = (await request.json()) as { name: string };
        const db = { uuid: `d1-${state.d1.length + 1}`, name };
        state.d1.push(db);
        return ok(db);
      }
      case "POST /workers/scripts/cut/assets-upload-session": {
        const needed = state.bucketHashes.filter((h) => !state.uploaded.has(h));
        const size = state.bucketSize ?? Math.max(1, needed.length);
        const buckets: string[][] = [];
        for (let i = 0; i < needed.length; i += size) buckets.push(needed.slice(i, i + size));
        return ok({ jwt: sessionJwt, buckets });
      }
      case "POST /workers/assets/upload": {
        if (auth !== `Bearer ${sessionJwt}`) return new Response("bad jwt", { status: 401 });
        return storeUpload((await request.formData()).keys());
      }
      case "PUT /workers/scripts/cut": {
        if (state.uploadStatus !== undefined) {
          return Response.json(
            { success: false, errors: [{ code: 10021, message: "script refused" }] },
            { status: state.uploadStatus },
          );
        }
        const form = await request.formData();
        state.metadata = JSON.parse(String(form.get("metadata")));
        state.modules = [...form.keys()].filter((k) => k !== "metadata");
        state.scripts.push("cut");
        return ok({ id: "cut", deployment_id: VERSION_HEX, tag: "tag-cut" });
      }
      case "PUT /workers/scripts/cut/secrets": {
        const body = (await request.json()) as { name: string; text: string };
        state.secrets[body.name] = body.text;
        return ok({ name: body.name, type: "secret_text" });
      }
      case "PUT /workers/scripts/cut/schedules": {
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
                  documentation_url:
                    "https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits",
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
      case "GET /workers/subdomain":
        return ok({ subdomain: "appflare-dev" });
      case "POST /workers/scripts/cut/subdomain":
        state.subdomainEnabled = await request.json();
        return ok({ enabled: true, previews_enabled: true });
    }
    const workflow = /^GET \/workflows\/([^/]+)$/.exec(key);
    if (workflow?.[1] !== undefined) {
      const name = workflow[1];
      return state.workflows.includes(name)
        ? ok({ id: "wf", name, script_name: "appflare" })
        : Response.json(
            { success: false, errors: [{ code: 10200, message: "Workflow not found" }] },
            { status: 404 },
          );
    }
    const schedules = /^GET \/workers\/scripts\/([^/]+)\/schedules$/.exec(key);
    if (schedules?.[1] !== undefined && state.scripts.includes(schedules[1])) {
      return ok({ schedules: (state.otherCrons[schedules[1]] ?? []).map((cron) => ({ cron })) });
    }
    if (key === "GET /queues") return ok(state.queues);
    if (key === "POST /queues") {
      const { queue_name } = (await request.json()) as { queue_name: string };
      const queue = { queue_id: `q-${state.queues.length + 1}`, queue_name };
      state.queues.push(queue);
      return ok(queue);
    }
    const consumers = /^(GET|POST) \/queues\/([^/]+)\/consumers$/.exec(key);
    if (consumers?.[2] !== undefined) {
      const queueId = consumers[2];
      state.consumers[queueId] ??= [];
      const list = state.consumers[queueId];
      if (consumers[1] === "GET") return ok(list);
      const body = (await request.json()) as Record<string, unknown>;
      const consumer = { ...body, consumer_id: `c-${queueId}-${list.length + 1}` };
      list.push(consumer);
      return ok(consumer);
    }
    const singleUpload = /^POST \/workers\/assets\/upload\/([0-9a-f]+)$/.exec(key);
    if (singleUpload?.[1] !== undefined) {
      if (auth !== `Bearer ${sessionJwt}`) return new Response("bad jwt", { status: 401 });
      return storeUpload([singleUpload[1]]);
    }
    const d1Query = /^POST \/d1\/database\/([^/]+)\/query$/.exec(key);
    if (d1Query) {
      const { sql, params } = (await request.json()) as { sql: string; params?: unknown[] };
      const failing = state.failMigration;
      if (
        failing !== undefined &&
        failing.times > 0 &&
        sql.endsWith(`values ('${failing.file}');`)
      ) {
        failing.times -= 1;
        return Response.json(
          { success: false, errors: [{ code: 7500, message: 'near "BROKEN": syntax error' }] },
          { status: failing.status },
        );
      }
      state.queries.push(sql);
      state.queryParams.push(params ?? null);
      if (sql.startsWith("SELECT (SELECT count(*) FROM sqlite_master")) {
        // The app's tables: every CREATE TABLE sent so far but d1_migrations.
        const tables = state.queries.flatMap(
          (q) => q.match(/CREATE TABLE (?!IF NOT EXISTS "d1_migrations")/g) ?? [],
        ).length;
        const recorded = state.applied.length;
        return ok([{ results: [{ tables, recorded }], success: true, meta: {} }]);
      }
      if (sql.startsWith("SELECT")) {
        return ok([
          {
            results: state.applied.map((name, i) => ({ id: i + 1, name })),
            success: true,
            meta: {},
          },
        ]);
      }
      const recordAt = sql.indexOf('INSERT OR IGNORE INTO "d1_migrations"');
      if (recordAt !== -1) {
        for (const row of sql.slice(recordAt).matchAll(/\('([^']+)'\)/g)) {
          if (row[1] !== undefined && !state.applied.includes(row[1])) state.applied.push(row[1]);
        }
        return ok([{ results: [], success: true, meta: {} }]);
      }
      const m = /values \('([^']+)'\);$/.exec(sql);
      if (m?.[1]) state.applied.push(m[1]);
      return ok([{ results: [], success: true, meta: {} }]);
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: `no route ${key}` }] },
      { status: 404 },
    );
  }

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const current = state.stepOf?.() ?? "(no step)";
    state.requestsByStep[current] ??= [];
    state.requestsByStep[current].push(input);
    if (input === ZIP_URL || input === STORAGE_URL) {
      if (state.artifactThrows !== undefined) throw new Error(state.artifactThrows);
      if (state.artifactRedirect) {
        const response = host.serve(input, init);
        // A followed redirect is two subrequests; record the second hop too.
        if (response?.redirected) state.requestsByStep[current].push(STORAGE_URL);
        if (response !== null) return response;
      }
    }
    const request = new Request(input, init);
    if (input.startsWith("https://api.cloudflare.com/")) return cloudflare(request);
    if (input.startsWith(`${WORKER_ORIGIN}/`)) {
      state.healthUrls.push(input);
      state.onHealthProbe?.();
      if (state.healthAnswer !== undefined) return state.healthAnswer(input, request.headers);
      const next = state.health.length > 1 ? state.health.shift() : state.health[0];
      return new Response(next?.body ?? "", { status: next?.status ?? 500 });
    }
    return fixture.serve(input, init) ?? new Response("not found", { status: 404 });
  };
  return { state, fetch };
}

/** Seals a protected app's service token secret. */
const AUTH_SECRET = "auth-secret-0123456789abcdef0123456789";
const jobEnv = (): JobEnv => ({ DB: env.DB, CF_API_TOKEN: TOKEN, BETTER_AUTH_SECRET: AUTH_SECRET });

async function start(fixture: ArtifactFixture, over: Partial<StartInstallInput> = {}) {
  let params: InstallJobParams | null = null;
  let n = 0;
  const ids = await startInstallCore(
    {
      db: env.DB,
      // As getCatalogManifest reads it: the form of the revision, when listed.
      loadApp: async () => ({
        app: fixture.index,
        manifest:
          fixture.revised === null
            ? fixture.manifest
            : withRevisedCatalog(fixture.manifest, fixture.revised.catalog),
      }),
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => `id${++n}`,
    },
    {
      slug: "cut",
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: PASSWORD },
      vars: { HOME_PAGE: "admin" },
      paidConfirmed: false,
      requirementsConfirmed: false,
      ...over,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  return { ...ids, params: params as InstallJobParams };
}

async function install(
  options: ArtifactFixtureOptions = {},
  world: Partial<FakeState> = {},
  input: Partial<StartInstallInput> = {},
  paramsOver: Partial<InstallJobParams> = {},
  clock?: { now: () => number; onSleep: (name: string, duration: string | number) => void },
  /** `local`: a manager without the `SELF` binding runs the units in the job's invocation. */
  units: "self" | "local" = "self",
  /** Runs once the install row exists, before the job starts. */
  beforeRun?: (installId: string, fixture: ArtifactFixture) => Promise<void>,
) {
  const fixture = await buildArtifactFixture(options);
  const fake = fakeWorld(fixture, world);
  const started = await start(fixture, input);
  const { jobId, installId } = started;
  const params = { ...started.params, ...paramsOver };
  await beforeRun?.(installId, fixture);
  const step = fakeStep(clock === undefined ? {} : { onSleep: clock.onSleep });
  fake.state.stepOf = () => step.names.at(-1);
  const self = fakeSelf(jobEnv(), {
    fetch: fake.fetch,
    ...(clock === undefined ? {} : { now: clock.now }),
  });
  let error: unknown = null;
  try {
    await runInstall({
      params,
      step,
      env: units === "self" ? { ...jobEnv(), SELF: self } : jobEnv(),
      deps: {
        fetch: fake.fetch,
        signingKeys: fixture.keys,
        ...(clock === undefined ? {} : { now: clock.now }),
      },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first<{
    status: string;
    error: string | null;
    started_at: number | null;
    finished_at: number | null;
  }>();
  const installRow = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(installId)
    .first<{
      status: string;
      current_version_id: string | null;
      manifest_json: string | null;
      do_migration_tag: string | null;
      health_status: string | null;
      health_checked_at: number | null;
    }>();
  const resources = (
    await env.DB.prepare(
      "SELECT kind, binding, name, cf_id FROM resources WHERE install_id = ?1 ORDER BY rowid",
    )
      .bind(installId)
      .all()
  ).results;
  const logs = (
    await env.DB.prepare(
      "SELECT level, message, data_json FROM job_logs WHERE job_id = ?1 ORDER BY id",
    )
      .bind(jobId)
      .all<{ level: string; message: string; data_json: string | null }>()
  ).results;
  return { fixture, fake, step, self, error, job, installRow, resources, logs };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
});

describe("install job", () => {
  it("installs an app end to end", async () => {
    const r = await install({
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
      ],
      assets: [
        { route: "/app.js", content: "console.log('app')" },
        { route: "/assets/styles.css", content: "body{}" },
      ],
      d1: {
        DB: [
          { name: "0002_more.sql", content: "ALTER TABLE links ADD COLUMN hits INTEGER;" },
          { name: "0001_init.sql", content: "CREATE TABLE links (id TEXT);" },
        ],
      },
      crons: ["*/5 * * * *"],
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.job?.error).toBeNull();
    expect(r.job?.started_at).not.toBeNull();
    expect(r.job?.finished_at).not.toBeNull();
    expect(r.installRow?.status).toBe("installed");
    expect(r.installRow?.current_version_id).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(r.installRow?.manifest_json).toBe(new TextDecoder().decode(r.fixture.manifestBytes));

    expect(r.step.names).toEqual([
      "start",
      "verify artifact manifest",
      "preflight checks",
      "verify API token",
      "check Worker name",
      "check cron trigger limit",
      "check KV namespace cut-cut-kv",
      "create KV namespace cut-cut-kv",
      "record KV namespace cut-cut-kv",
      "check D1 database cut-db",
      "create D1 database cut-db",
      "record D1 database cut-db",
      "look up workers.dev subdomain",
      "open assets upload session",
      "upload assets bucket 1/1",
      "record Worker name",
      "upload Worker script",
      "record Worker script",
      "D1 DB: apply migrations",
      "set secret ADMIN_PASSWORD",
      "set cron triggers",
      "enable workers.dev route",
      "health check 1",
      "health check 2",
      "finish",
    ]);
    expect(r.step.sleeps).toEqual(["health wait 1"]);
    // The subrequest-heavy work ran as units over SELF, each in its own invocation.
    expect(r.self.calls.map((c) => [c.unit, c.subrequests])).toEqual([
      ["countCronTriggers", 2], // the Worker list, the manager's schedule
      ["uploadAssetPart", 2], // one range for both files, one upload
      ["uploadWorker", 2], // one range for the module, one upload
      // The table, the list, one range for both files, one query per file.
      ["applyD1Migrations", 5],
    ]);
    for (const call of r.self.calls) expect(call.reported).toBe(call.subrequests);
    expect(r.step.configs.every((c) => c === API_STEP)).toBe(true);

    // Step 3: resources recorded; step 5: bindings sent with their ids.
    expect(r.resources).toEqual([
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cf_id: "kv-1" },
      { kind: "d1", binding: "DB", name: "cut-db", cf_id: "d1-1" },
      { kind: "worker", binding: null, name: "cut", cf_id: "cut" },
      { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD", cf_id: null },
      { kind: "cron", binding: null, name: "*/5 * * * *", cf_id: null },
      { kind: "subdomain", binding: null, name: "cut.appflare-dev.workers.dev", cf_id: null },
    ]);
    expect(r.fake.state.metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
        { type: "d1", name: "DB", id: "d1-1" },
        { type: "plain_text", name: "HOME_PAGE", text: "admin" },
      ],
      assets: { jwt: "completion-jwt", config: {} },
    });
    expect(r.fake.state.modules).toEqual(["worker.js"]);
    expect(r.fake.state.uploaded.size).toBe(2);

    // Step 6: wrangler-style, in filename order.
    expect(r.fake.state.queries[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "d1_migrations"/);
    expect(r.fake.state.applied).toEqual(["0001_init.sql", "0002_more.sql"]);
    expect(r.fake.state.queries[2]).toBe(
      "CREATE TABLE links (id TEXT);\nINSERT INTO \"d1_migrations\" (name)\nvalues ('0001_init.sql');",
    );

    // Steps 7-8.
    expect(r.fake.state.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD });
    expect(r.fake.state.schedules).toEqual(["*/5 * * * *"]);
    expect(r.fake.state.subdomainEnabled).toEqual({ enabled: true, previews_enabled: true });

    // Logs: batched per step, API calls as METHOD path -> status, no secrets.
    const everything = JSON.stringify(r.logs);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("completion-jwt");
    expect(everything).not.toContain("session-jwt");
    expect(everything).toContain(`POST /accounts/${ACC}/storage/kv/namespaces -> 200`);
    expect(r.logs.some((l) => l.level === "warn" && l.message.includes("1042"))).toBe(true);
    expect(r.logs.at(-1)?.message).toMatch(/^Installed cut 1\.0\.0 at https:\/\/cut\.appflare-dev/);
  });

  it("sets a multiline secret with every line break it was entered with", async () => {
    const body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun-DO-NOT-LEAK";
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${body}\nVHK0CLt3=\n-----END RSA PRIVATE KEY-----\n`;
    const base = baseCatalog();
    const r = await install(
      {
        catalog: {
          secrets: [...base.secrets, { name: "APP_KEY", label: "Private key", multiline: true }],
        },
      },
      {},
      { secrets: { ADMIN_PASSWORD: PASSWORD, APP_KEY: key } },
    );
    expect(r.error).toBeNull();
    expect(r.fixture.manifest.format).toBe(1);
    expect(r.fake.state.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD, APP_KEY: key });
    expect(r.fake.state.secrets.APP_KEY?.split("\n")).toHaveLength(5);
    expect(JSON.stringify(r.logs)).not.toContain(body);
  });

  it("runs schema files after the migrations and post-deploy migrations after both", async () => {
    const r = await install({
      bindings: [{ type: "d1", name: "DB" }],
      d1: { DB: [{ name: "20240101_init", content: "CREATE TABLE links (id TEXT);" }] },
      d1Schema: {
        DB: [
          { name: "src/db/tables.sql", content: "CREATE TABLE IF NOT EXISTS s (id TEXT);" },
          { name: "src/db/indexes.sql", content: "CREATE INDEX IF NOT EXISTS i ON s(id);" },
        ],
      },
      d1PostDeploy: { DB: [{ name: "0001_drop_legacy.sql", content: "DROP TABLE legacy;" }] },
    });
    expect(r.error).toBeNull();
    const names = r.step.names;
    expect(
      names.slice(
        names.indexOf("record Worker script") + 1,
        names.indexOf("set secret ADMIN_PASSWORD"),
      ),
    ).toEqual([
      "D1 DB: apply migrations",
      "D1 DB: apply schema",
      "D1 DB: apply post-deploy migrations",
    ]);
    expect(r.self.calls.map((c) => c.unit).filter((u) => u.startsWith("applyD1"))).toEqual([
      "applyD1Migrations",
      "applyD1Schema",
      "applyD1Migrations",
    ]);
    // The schema files run as they are; only the tracked files are recorded.
    expect(r.fake.state.queries.filter((q) => !/d1_migrations/.test(q))).toEqual([
      "CREATE TABLE IF NOT EXISTS s (id TEXT);",
      "CREATE INDEX IF NOT EXISTS i ON s(id);",
    ]);
    expect(r.fake.state.applied).toEqual(["20240101_init", "0001_drop_legacy.sql"]);
    expect(r.logs.map((l) => l.message)).toContain(
      "Ran the schema file src/db/indexes.sql on cut-db.",
    );
  });

  it("runs a baseline before the migrations and records them without running them", async () => {
    const BASELINE = "CREATE TABLE links (id TEXT, slug TEXT);\nCREATE TABLE clicks (id TEXT);\n";
    const r = await install({
      bindings: [{ type: "d1", name: "DB" }],
      d1: {
        DB: [
          { name: "0001_add_slug.sql", content: "ALTER TABLE links ADD COLUMN slug TEXT;" },
          { name: "0002_clicks.sql", content: "CREATE TABLE clicks (id TEXT);" },
        ],
      },
      d1PostDeploy: { DB: [{ name: "0003_drop_legacy.sql", content: "DROP TABLE legacy;" }] },
      d1Baseline: { DB: { name: "db/schema.sql", content: BASELINE } },
    });
    expect(r.error).toBeNull();
    const names = r.step.names;
    expect(
      names.slice(
        names.indexOf("record Worker script") + 1,
        names.indexOf("set secret ADMIN_PASSWORD"),
      ),
    ).toEqual([
      "D1 DB: apply baseline",
      "D1 DB: apply migrations",
      "D1 DB: apply post-deploy migrations",
    ]);
    expect(r.self.calls.map((c) => c.unit).filter((u) => u.startsWith("applyD1"))).toEqual([
      "applyD1Baseline",
      "applyD1Migrations",
      "applyD1Migrations",
    ]);
    // The baseline ran once; no migration's SQL did, yet all are recorded.
    const ran = r.fake.state.queries.filter((q) => !q.startsWith("SELECT"));
    expect(ran.filter((q) => q.startsWith(BASELINE))).toHaveLength(1);
    expect(ran.some((q) => q.includes("ALTER TABLE") || q.includes("DROP TABLE"))).toBe(false);
    expect(r.fake.state.applied).toEqual([
      "0001_add_slug.sql",
      "0002_clicks.sql",
      "0003_drop_legacy.sql",
    ]);
    expect(r.logs.map((l) => l.message)).toContain(
      "Ran the baseline db/schema.sql on cut-db and recorded 3 migration(s) as applied without running them.",
    );
  });

  describe("an app that seeds its first admin", () => {
    const ADMIN_NAME = "first-admin-DO-NOT-LEAK";
    const SEED_PASSWORD = "seed-password-DO-NOT-LEAK";
    const SEED_SQL = "INSERT OR IGNORE INTO admins (name, password_hash) VALUES (?, ?)";
    const seedApp = (beforeSchema: boolean): ArtifactFixtureOptions => {
      const seed: CatalogD1Seed = {
        hashes: { admin: { from: "FIRST_ADMIN_PASSWORD", method: "bcrypt" } },
        statements: [{ sql: SEED_SQL, params: [{ var: "FIRST_ADMIN_NAME" }, { hash: "admin" }] }],
        ...(beforeSchema ? { beforeSchema: true } : {}),
      };
      const base = baseCatalog();
      return {
        bindings: [{ type: "d1", name: "DB" }],
        d1: { DB: [{ name: "20240101_init", content: "CREATE TABLE admins (name TEXT);" }] },
        d1Schema: {
          DB: [{ name: "schema.sql", content: "CREATE TABLE IF NOT EXISTS s (id TEXT);" }],
        },
        d1PostDeploy: { DB: [{ name: "0001_after.sql", content: "DROP TABLE legacy;" }] },
        catalog: {
          secrets: [
            ...base.secrets,
            {
              name: "FIRST_ADMIN_PASSWORD",
              label: "Admin password",
              generate: "password",
              seedOnly: true,
            },
          ],
          vars: [...base.vars, { name: "FIRST_ADMIN_NAME", label: "Admin name", seedOnly: true }],
          resources: {
            d1: {
              DB: { schema: ["schema.sql"], postDeployMigrationsDir: "after-deploy", seed },
            },
          },
        },
      };
    };
    const seedInput: Partial<StartInstallInput> = {
      secrets: { ADMIN_PASSWORD: PASSWORD, FIRST_ADMIN_PASSWORD: SEED_PASSWORD },
      vars: { HOME_PAGE: "admin", FIRST_ADMIN_NAME: ADMIN_NAME },
    };
    const d1Steps = (names: readonly string[]) =>
      names.slice(
        names.indexOf("record Worker script") + 1,
        names.indexOf("set secret ADMIN_PASSWORD"),
      );

    it("seeds once the migrations, schema files and post-deploy migrations ran, with bound params", async () => {
      const r = await install(seedApp(false), {}, seedInput);
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(d1Steps(r.step.names)).toEqual([
        "D1 DB: apply migrations",
        "D1 DB: apply schema",
        "D1 DB: apply post-deploy migrations",
        "D1 DB: seed",
      ]);
      expect(r.self.calls.filter((c) => c.unit === "seedD1")).toHaveLength(1);
      // The statement as signed, the values bound: the name and a bcrypt hash of the password.
      const at = r.fake.state.queries.indexOf(SEED_SQL);
      expect(at).toBe(r.fake.state.queries.length - 1);
      const [name, hash] = r.fake.state.queryParams[at] as [string, string];
      expect(name).toBe(ADMIN_NAME);
      expect(bcrypt.compareSync(SEED_PASSWORD, hash)).toBe(true);
      for (const sql of r.fake.state.queries) {
        expect(sql).not.toContain(ADMIN_NAME);
        expect(sql).not.toContain(SEED_PASSWORD);
      }
      expect(r.logs.map((l) => l.message)).toContain(
        "Seeded cut-db: 1 statement(s), 0 row(s) added. Seed statements run only at install.",
      );
    });

    it("seeds before the schema files with beforeSchema", async () => {
      const r = await install(seedApp(true), {}, seedInput);
      expect(r.error).toBeNull();
      expect(d1Steps(r.step.names)).toEqual([
        "D1 DB: apply migrations",
        "D1 DB: seed",
        "D1 DB: apply schema",
        "D1 DB: apply post-deploy migrations",
      ]);
      expect(r.fake.state.queries.filter((q) => !/d1_migrations/.test(q))).toEqual([
        SEED_SQL,
        "CREATE TABLE IF NOT EXISTS s (id TEXT);",
      ]);
    });

    it("never binds, stores or logs the seed-only values", async () => {
      const r = await install(seedApp(false), {}, seedInput);
      expect(r.error).toBeNull();
      // Only the Worker's own secret is set and recorded.
      expect(Object.keys(r.fake.state.secrets)).toEqual(["ADMIN_PASSWORD"]);
      const secretRows = r.resources.filter((row) => (row as { kind: string }).kind === "secret");
      expect(secretRows.map((row) => (row as { name: string }).name)).toEqual(["ADMIN_PASSWORD"]);
      const bindings = (r.fake.state.metadata?.bindings ?? []) as Array<{ name: string }>;
      expect(bindings.map((b) => b.name)).not.toContain("FIRST_ADMIN_NAME");
      expect(bindings.map((b) => b.name)).not.toContain("FIRST_ADMIN_PASSWORD");
      // Neither the job's recorded input nor the install's settings hold them.
      const rows = await env.DB.prepare(
        "SELECT i.config_json AS config, j.input_json AS input FROM installs i JOIN jobs j ON j.install_id = i.id",
      ).first<{ config: string; input: string }>();
      for (const text of [rows?.config ?? "", rows?.input ?? ""]) {
        expect(text).not.toContain("FIRST_ADMIN");
        expect(text).not.toContain(ADMIN_NAME);
        expect(text).not.toContain(SEED_PASSWORD);
      }
      const everything = JSON.stringify(r.logs);
      expect(everything).not.toContain(ADMIN_NAME);
      expect(everything).not.toContain(SEED_PASSWORD);
    });

    it("carries the seed-only values in the Workflow params alone", async () => {
      const fixture = await buildArtifactFixture(seedApp(false));
      expect(fixture.manifest.format).toBe(1);
      const started = await start(fixture, seedInput);
      expect(started.params.seed).toEqual({
        secrets: { FIRST_ADMIN_PASSWORD: SEED_PASSWORD },
        vars: { FIRST_ADMIN_NAME: ADMIN_NAME },
      });
      expect(started.params.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD });
      expect(started.params.vars).toEqual({ HOME_PAGE: "admin" });
    });

    it("refuses a password bcrypt would cut short before anything is created", async () => {
      const fixture = await buildArtifactFixture(seedApp(false));
      await expect(
        start(fixture, {
          ...seedInput,
          secrets: { ADMIN_PASSWORD: PASSWORD, FIRST_ADMIN_PASSWORD: "x".repeat(73) },
        }),
      ).rejects.toThrow("Admin password (FIRST_ADMIN_PASSWORD) is 73 bytes long");
    });
  });

  it("sends the install's stored workers.dev choice, keeping version previews on", async () => {
    const r = await install({}, {}, {}, {}, undefined, "self", async (installId) => {
      await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
        .bind(installId)
        .run();
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.subdomainEnabled).toEqual({ enabled: false, previews_enabled: true });
    // No workers.dev route is recorded for a Worker that does not answer there.
    expect(r.resources.some((row) => (row as { kind: string }).kind === "subdomain")).toBe(false);
    expect(r.logs.some((l) => l.message.startsWith("Left https://cut."))).toBe(true);
  });

  it("creates a Vectorize index with the recorded shape and passes Workers AI through", async () => {
    // Shaped like second-brain-cloudflare: D1 whose schema the app creates at
    // runtime (no migration files), a Vectorize index, Workers AI, KV, a var,
    // and five cron triggers.
    const crons = ["0 1 * * *", "*/15 * * * *", "0 */6 * * *", "30 2 * * 1", "0 0 1 * *"];
    const r = await install({
      bindings: [
        { type: "d1", name: "DB" },
        { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "cosine" },
        { type: "ai", name: "AI" },
        { type: "kv_namespace", name: "OAUTH_KV" },
        { type: "plain_text", name: "VECTORIZE_GRACE_MS", text: "300000" },
      ],
      d1: { DB: [] },
      crons,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toEqual(
      expect.arrayContaining([
        "check Vectorize index cut-vectorize",
        "create Vectorize index cut-vectorize",
        "record Vectorize index cut-vectorize",
        "set cron triggers",
      ]),
    );
    // No migration files: nothing touches the database before the app does.
    expect(r.step.names.some((n) => n.startsWith("D1 DB"))).toBe(false);
    expect(r.fake.state.queries).toEqual([]);

    // `POST /vectorize/v2/indexes` with `{ name, config: { dimensions, metric } }`.
    expect(r.fake.state.vectorize).toEqual([
      { name: "cut-vectorize", config: { dimensions: 384, metric: "cosine" } },
    ]);
    expect(r.resources).toEqual(
      expect.arrayContaining([
        { kind: "vectorize", binding: "VECTORIZE", name: "cut-vectorize", cf_id: "cut-vectorize" },
        ...crons.map((cron) => ({ kind: "cron", binding: null, name: cron, cf_id: null })),
      ]),
    );
    // The upload binds the index by name and sends Workers AI as recorded; the
    // index shape stays out of the script metadata.
    expect(r.fake.state.metadata?.bindings).toEqual([
      { type: "d1", name: "DB", id: "d1-1" },
      { type: "vectorize", name: "VECTORIZE", index_name: "cut-vectorize" },
      { type: "ai", name: "AI" },
      { type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-1" },
      { type: "plain_text", name: "VECTORIZE_GRACE_MS", text: "300000" },
      { type: "plain_text", name: "HOME_PAGE", text: "admin" },
    ]);
    expect(r.fake.state.schedules).toEqual(crons);
  });

  it("creates the declared metadata indexes and sets R2 lifecycle rules right after each resource", async () => {
    const lifecycle = [{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }];
    const metadataIndexes = [
      { propertyName: "url", type: "string" as const },
      { propertyName: "year", type: "number" as const },
    ];
    const r = await install({
      bindings: [
        { type: "r2_bucket", name: "FILES", lifecycle },
        { type: "vectorize", name: "VECTORIZE", dimensions: 3, metric: "cosine", metadataIndexes },
      ],
      catalog: {
        resources: {
          r2: { FILES: { lifecycle } },
          vectorize: { VECTORIZE: { dimensions: 3, metric: "cosine", metadataIndexes } },
        },
      },
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.fixture.manifest.format).toBe(1);
    const names = r.step.names;
    const at = (name: string) => names.indexOf(name);
    expect(at("record R2 bucket cut-files")).toBeLessThan(
      at("read lifecycle rules of R2 bucket cut-files"),
    );
    expect(at("read lifecycle rules of R2 bucket cut-files")).toBeLessThan(
      at("set lifecycle rules of R2 bucket cut-files"),
    );
    expect(at("record Vectorize index cut-vectorize")).toBeLessThan(
      at("create metadata index url on Vectorize index cut-vectorize"),
    );
    expect(names).toContain("create metadata index year on Vectorize index cut-vectorize");
    // Cloudflare's default rule stays; the declared one follows it, in the API's shape.
    expect(r.fake.state.lifecycle["cut-files"]).toEqual([
      DEFAULT_MULTIPART_RULE,
      {
        id: "appflare:tmp",
        enabled: true,
        conditions: { prefix: "tmp/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      },
    ]);
    expect(r.fake.state.metadataIndexes["cut-vectorize"]).toEqual([
      { propertyName: "url", indexType: "string" },
      { propertyName: "year", indexType: "number" },
    ]);
    // The rules and indexes stay out of the script metadata.
    expect(r.fake.state.metadata?.bindings).toEqual(
      expect.arrayContaining([
        { type: "r2_bucket", name: "FILES", bucket_name: "cut-files" },
        { type: "vectorize", name: "VECTORIZE", index_name: "cut-vectorize" },
      ]),
    );
  });

  describe("an app with a database elsewhere", () => {
    const DB_PASSWORD = "db-pass-NEVER-SHOWN";
    const CONNECTION = `postgres://app:${DB_PASSWORD}@db.example.com:6543/feedlog?sslmode=require`;
    const options = {
      bindings: [
        { type: "hyperdrive", name: "HYPERDRIVE" },
        { type: "kv_namespace", name: "CUT_KV" },
      ],
      catalog: {
        resources: { hyperdrive: { HYPERDRIVE: { protocol: "postgres" as const } } },
      },
    };

    it("creates a Hyperdrive configuration from the connection string and binds it by id", async () => {
      const r = await install(options, {}, { hyperdrive: { HYPERDRIVE: CONNECTION } });
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.step.names).toEqual(
        expect.arrayContaining([
          "check Hyperdrive configuration cut-hyperdrive",
          "create Hyperdrive configuration cut-hyperdrive",
          "record Hyperdrive configuration cut-hyperdrive",
        ]),
      );
      // First among the resources: an unreachable database stops the install early.
      expect(r.step.names.indexOf("create Hyperdrive configuration cut-hyperdrive")).toBeLessThan(
        r.step.names.findIndex((n) => n.startsWith("check KV namespace")),
      );
      // `POST /hyperdrive/configs` with `{ name, origin }`, origin from the string.
      expect(r.fake.state.hyperdrive).toEqual([
        {
          id: "hd-1",
          name: "cut-hyperdrive",
          origin: {
            scheme: "postgres",
            host: "db.example.com",
            port: 6543,
            database: "feedlog",
            user: "app",
            password: DB_PASSWORD,
          },
        },
      ]);
      expect(r.resources).toEqual(
        expect.arrayContaining([
          { kind: "hyperdrive", binding: "HYPERDRIVE", name: "cut-hyperdrive", cf_id: "hd-1" },
        ]),
      );
      expect(r.fake.state.metadata?.bindings).toContainEqual({
        type: "hyperdrive",
        name: "HYPERDRIVE",
        id: "hd-1",
      });
      // The string is a credential: only the binding name is kept anywhere.
      const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE kind = 'install'").first<{
        input_json: string;
      }>();
      expect(JSON.parse(job?.input_json ?? "{}").hyperdrive).toEqual(["HYPERDRIVE"]);
      expect(job?.input_json).not.toContain(DB_PASSWORD);
      expect(JSON.stringify(r.logs)).not.toContain(DB_PASSWORD);
      expect(JSON.stringify(r.resources)).not.toContain(DB_PASSWORD);
    });

    it("fails with Cloudflare's reason when the database cannot be reached, before the upload", async () => {
      const r = await install(
        options,
        { hyperdriveRefusal: "Failed to connect to the origin database" },
        { hyperdrive: { HYPERDRIVE: CONNECTION } },
      );
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^create Hyperdrive configuration cut-hyperdrive: Cloudflare could not set up Hyperdrive for HYPERDRIVE \(Failed to connect to the origin database\)/,
      );
      expect(r.job?.error).not.toContain(DB_PASSWORD);
      expect(r.fake.state.metadata).toBeNull();
      // Nothing else was created before it.
      expect(r.fake.state.kv).toEqual([]);
    });

    it("names the missing Hyperdrive: Edit permission when Cloudflare refuses the token", async () => {
      const r = await install(
        options,
        { hyperdriveTokenRefused: true },
        { hyperdrive: { HYPERDRIVE: CONNECTION } },
      );
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^check Hyperdrive configuration cut-hyperdrive: Cloudflare refused the Hyperdrive call \(Authentication error\)\. The API token needs Hyperdrive: Edit/,
      );
      expect(r.fake.state.kv).toEqual([]);
    });

    it("is refused at the start without a usable connection string", async () => {
      await expect(install(options, {}, {})).rejects.toThrow(
        /PostgreSQL connection string \(HYPERDRIVE\) is required/,
      );
      await expect(
        install(options, {}, { hyperdrive: { HYPERDRIVE: `mysql://a:${DB_PASSWORD}@h/db` } }),
      ).rejects.toThrow(/This app needs a PostgreSQL database/);
    });
  });

  describe("an app that streams events", () => {
    const options = {
      bindings: [
        { type: "pipelines", name: "EVENTS" },
        { type: "kv_namespace", name: "CUT_KV" },
      ],
      catalog: {
        plan: "paid" as const,
        secrets: [
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" as const },
          { name: "CATALOG_TOKEN", label: "R2 token" },
        ],
        resources: {
          pipelines: {
            EVENTS: {
              schema: {
                fields: [
                  { name: "ts", type: "timestamp" as const, required: true },
                  { name: "site", type: "string" as const },
                ],
              },
              sink: {
                type: "r2_data_catalog" as const,
                bucket: "WAREHOUSE",
                namespace: "cut",
                table: "events",
                tokenSecret: "CATALOG_TOKEN",
                rollIntervalSeconds: 60,
                compaction: true,
                snapshotExpiration: { maxAge: "30d", minSnapshotsToKeep: 5 },
              },
            },
          },
        },
      },
    };
    const input = {
      paidConfirmed: true,
      secrets: { ADMIN_PASSWORD: PASSWORD, CATALOG_TOKEN: SINK_TOKEN },
    };

    it("creates the bucket, its catalog, the stream, the sink and the pipeline, and binds the stream", async () => {
      const r = await install(options, {}, input);
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      const names = r.step.names;
      expect(
        names.slice(names.indexOf("check Pipelines"), names.indexOf("check Pipelines") + 1),
      ).toEqual(["check Pipelines"]);
      expect(names.slice(names.indexOf("check Pipelines names for EVENTS"))).toEqual(
        expect.arrayContaining([
          "check Pipelines names for EVENTS",
          "create R2 bucket cut-warehouse",
          "record R2 bucket cut-warehouse",
          "turn on R2 Data Catalog for cut-warehouse",
          "record R2 Data Catalog cut-warehouse",
          "turn on table maintenance for cut-warehouse",
          "create Pipelines stream cut_events_stream",
          "record Pipelines stream cut_events_stream",
          "create Pipelines sink cut_events_sink",
          "record Pipelines sink cut_events_sink",
          "create pipeline cut_events_pipeline",
          "record pipeline cut_events_pipeline",
        ]),
      );
      // The probe runs before anything is created; the streams after the other resources.
      expect(names.indexOf("check Pipelines")).toBeLessThan(
        names.indexOf("check KV namespace cut-cut-kv"),
      );
      expect(names.indexOf("record KV namespace cut-cut-kv")).toBeLessThan(
        names.indexOf("check Pipelines names for EVENTS"),
      );

      expect(r.fake.state.r2).toEqual(["cut-warehouse"]);
      expect(r.fake.state.streams).toEqual([
        {
          id: "streams-1",
          name: "cut_events_stream",
          body: {
            name: "cut_events_stream",
            format: { type: "json" },
            schema: {
              fields: [
                { name: "ts", type: "timestamp", required: true },
                { name: "site", type: "string" },
              ],
            },
            http: { enabled: false, authentication: false },
            worker_binding: { enabled: true },
          },
        },
      ]);
      expect(r.fake.state.sinks[0]?.body).toEqual({
        name: "cut_events_sink",
        type: "r2_data_catalog",
        format: { type: "parquet" },
        config: {
          account_id: ACC,
          bucket: "cut-warehouse",
          namespace: "cut",
          table_name: "events",
          token: SINK_TOKEN,
          rolling_policy: { interval_seconds: 60 },
        },
      });
      expect(r.fake.state.pipelines[0]?.body).toEqual({
        name: "cut_events_pipeline",
        sql: "INSERT INTO cut_events_sink SELECT * FROM cut_events_stream",
      });
      // The catalog calls use the app's token, never the manager's.
      expect(r.fake.state.catalogCalls).toEqual([
        { call: "GET /r2-catalog/cut-warehouse as sink" },
        { call: "POST /r2-catalog/cut-warehouse/enable as sink" },
        { call: "POST /r2-catalog/cut-warehouse/credential as sink", body: { token: SINK_TOKEN } },
        {
          call: "POST /r2-catalog/cut-warehouse/maintenance-configs as sink",
          body: {
            compaction: { state: "enabled" },
            snapshot_expiration: {
              state: "enabled",
              max_snapshot_age: "30d",
              min_snapshots_to_keep: 5,
            },
          },
        },
      ]);
      expect(r.resources).toEqual(
        expect.arrayContaining([
          { kind: "r2", binding: null, name: "cut-warehouse", cf_id: "cut-warehouse" },
          { kind: "r2_catalog", binding: null, name: "cut-warehouse", cf_id: "cat-1" },
          {
            kind: "pipeline_stream",
            binding: "EVENTS",
            name: "cut_events_stream",
            cf_id: "streams-1",
          },
          { kind: "pipeline_sink", binding: null, name: "cut_events_sink", cf_id: "sinks-1" },
          { kind: "pipeline", binding: null, name: "cut_events_pipeline", cf_id: "pipelines-1" },
        ]),
      );
      // Wrangler's upload shape: the stream by id.
      expect(r.fake.state.metadata?.bindings).toContainEqual({
        type: "pipelines",
        name: "EVENTS",
        stream: "streams-1",
      });
      // The token is the app's secret: set on the Worker, never logged or recorded.
      expect(r.fake.state.secrets.CATALOG_TOKEN).toBe(SINK_TOKEN);
      expect(JSON.stringify(r.logs)).not.toContain(SINK_TOKEN);
      expect(JSON.stringify(r.resources)).not.toContain(SINK_TOKEN);
      expect(r.job?.error ?? "").not.toContain(SINK_TOKEN);
    });

    it("clears a catalog an earlier bucket of the same name left before turning it on", async () => {
      const r = await install(
        options,
        { catalogs: { "cut-warehouse": { id: "old-cat", status: "active" } } },
        input,
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.catalogCalls.slice(0, 3).map((c) => c.call)).toEqual([
        "GET /r2-catalog/cut-warehouse as sink",
        "POST /r2-catalog/cut-warehouse/delete?force=true as sink",
        "POST /r2-catalog/cut-warehouse/enable as sink",
      ]);
    });

    it("goes on with a warning when the catalog refuses the maintenance settings", async () => {
      const r = await install(options, { maintenanceStatus: 400 }, input);
      expect(r.job?.status).toBe("succeeded");
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(
            /^Could not turn on table maintenance for "cut-warehouse"/,
          ),
        }),
      );
    });

    it("names Pipelines: Edit and Workers Paid when Cloudflare refuses the probe, before creating anything", async () => {
      const r = await install(options, { pipelinesTokenRefused: true }, input);
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^check Pipelines: Cloudflare refused the Pipelines call \(Forbidden\)\. The API token needs Pipelines: Edit, .* Workers Paid/,
      );
      expect(r.fake.state.kv).toEqual([]);
      expect(r.fake.state.r2).toEqual([]);
    });

    it("picks up the stream its own failed attempt created, then creates the sink it lacks", async () => {
      const r = await install(
        options,
        { failAfter: new Set(["POST /pipelines/v1/streams", "POST /pipelines/v1/sinks"]) },
        input,
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.step.retried).toMatchObject({
        "create Pipelines stream cut_events_stream": 2,
        "create Pipelines sink cut_events_sink": 2,
      });
      // One of each: the retries found what the failed attempts made.
      expect(r.fake.state.streams.map((s) => s.id)).toEqual(["streams-1"]);
      expect(r.fake.state.sinks.map((s) => s.id)).toEqual(["sinks-1"]);
      expect(r.fake.state.pipelines).toHaveLength(1);
      expect(r.logs.map((l) => l.message)).toContain(
        'Found the Pipelines stream "cut_events_stream" an earlier attempt created.',
      );
      expect(r.resources).toContainEqual({
        kind: "pipeline_sink",
        binding: null,
        name: "cut_events_sink",
        cf_id: "sinks-1",
      });
    });

    it("names only the permission when the account is known to be on Workers Paid", async () => {
      const r = await install(
        options,
        { pipelinesTokenRefused: true },
        input,
        {},
        undefined,
        "self",
        async () => {
          await writeSettings(createDb(env.DB), { [SETTING.accountPlan]: "paid" });
        },
      );
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(/The API token needs Pipelines: Edit, an optional permission/);
      expect(r.job?.error).not.toMatch(/Workers Paid/);
    });

    it("refuses a stream name the account already has instead of adopting it", async () => {
      const r = await install(
        options,
        { streams: [{ id: "theirs", name: "cut_events_stream", body: {} }] },
        input,
      );
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^check Pipelines names for EVENTS: a Pipelines stream named cut_events_stream already exists/,
      );
      expect(r.fake.state.sinks).toEqual([]);
      expect(r.fake.state.r2).toEqual([]);
    });

    it("writes to the app's own R2 binding when the sink names it, without a second bucket", async () => {
      const r = await install(
        {
          ...options,
          bindings: [...options.bindings, { type: "r2_bucket", name: "WAREHOUSE" }],
        },
        {},
        { ...input, requirementsConfirmed: true },
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.r2).toEqual(["cut-warehouse"]);
      // Created once, by the binding's own resource steps.
      expect(r.step.names.filter((n) => n === "create R2 bucket cut-warehouse")).toHaveLength(1);
      expect(r.step.names.indexOf("create R2 bucket cut-warehouse")).toBeLessThan(
        r.step.names.indexOf("check Pipelines names for EVENTS"),
      );
      expect(r.resources).toContainEqual({
        kind: "r2",
        binding: "WAREHOUSE",
        name: "cut-warehouse",
        cf_id: "cut-warehouse",
      });
      expect(r.fake.state.sinks[0]?.body).toMatchObject({ config: { bucket: "cut-warehouse" } });
    });
  });

  it("refuses an artifact whose Vectorize binding lacks the index shape, before creating anything", async () => {
    const r = await install({
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      tweak: (m) => {
        m.worker.bindings.push({ type: "vectorize", name: "VECTORIZE" });
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /^verify artifact manifest: .*a vectorize binding must record the index's dimensions and metric/s,
    );
    expect(r.fake.state.vectorize).toEqual([]);
    expect(r.fake.state.kv).toEqual([]);
  });

  it("uploads non-string vars as json and fills in the Worker's URL and name", async () => {
    const r = await install(
      {
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "json", name: "EMAIL_ADDRESSES", json: [] },
          { type: "plain_text", name: "PUBLIC_URL", text: "{{workerUrl}}" },
        ],
        catalog: {
          vars: [
            { name: "HOME_PAGE", label: "Home page", optional: true },
            {
              name: "EMAIL_ADDRESSES",
              label: "Addresses",
              default: '["{{workerName}}@example.com"]',
              optional: true,
            },
          ],
        },
      },
      {},
      { vars: { HOME_PAGE: "{{workerUrl}}/admin" } },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.metadata?.bindings).toEqual([
      { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
      { type: "json", name: "EMAIL_ADDRESSES", json: ["cut@example.com"] },
      { type: "plain_text", name: "PUBLIC_URL", text: "https://cut.appflare-dev.workers.dev" },
      {
        type: "plain_text",
        name: "HOME_PAGE",
        text: "https://cut.appflare-dev.workers.dev/admin",
      },
    ]);
  });

  it("installs the signed Worker with the form of a revision the catalog lists, and records it", async () => {
    const homePage = {
      name: "HOME_PAGE",
      label: "Home page",
      optional: true,
      type: "select" as const,
      options: [
        { value: "default", label: "Show the landing page" },
        { value: "404", label: "Return an empty 404 response" },
      ],
      default: "404",
    };
    const greeting = { name: "GREETING", label: "Greeting", default: "hi", optional: true };
    const r = await install({ revision: { vars: [homePage, greeting] } }, {}, { vars: {} });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toContain("verify revised catalog manifest");
    // The revision's defaults, including a var only the revision declares.
    expect(r.fake.state.metadata?.bindings).toEqual(
      expect.arrayContaining([
        { type: "plain_text", name: "HOME_PAGE", text: "404" },
        { type: "plain_text", name: "GREETING", text: "hi" },
      ]),
    );
    // The install keeps the signed manifest; the revision is recorded for the release.
    expect(r.installRow?.manifest_json).toBe(new TextDecoder().decode(r.fixture.manifestBytes));
    const recorded = await readCatalogRevision(createDb(env.DB), r.fixture.digest);
    expect(recorded?.revision).toBe(2);
    expect(recorded?.catalog.vars).toEqual(r.fixture.revised?.catalog.vars);
    expect(recorded?.sha256).toBe(r.fixture.index.catalogManifest?.sha256);
    expect(recorded?.signature).toBe(r.fixture.index.catalogManifest?.signature);
  });

  it("refuses a revision whose bytes are not the ones the index lists, before creating anything", async () => {
    const r = await install(
      { revision: { summary: "Revised." } },
      {},
      {},
      {
        revisedCatalog: {
          url: REVISED_URL,
          sha256: "0".repeat(64),
          keyId: "test-key",
          signature: "x",
          revision: 2,
        },
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /verify revised catalog manifest: .*digest .* does not match the catalog index/,
    );
    expect(r.resources).toEqual([]);
  });

  it("refuses an unsigned revision, before creating anything", async () => {
    // The same revised bytes (the fixture is deterministic), listed without a signature.
    const listed = (await buildArtifactFixture({ revision: { summary: "Revised." } })).index
      .catalogManifest;
    if (listed === undefined) throw new Error("no revision");
    const r = await install(
      { revision: { summary: "Revised." } },
      {},
      {},
      { revisedCatalog: { ...listed, signature: "AAAA", revision: 2 } },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/verify revised catalog manifest: .*signature does not verify/);
    expect(r.resources).toEqual([]);
  });

  it("refuses a revision that changes what only a new build can change", async () => {
    const r = await install(
      { revision: { requires: ["r2"] } },
      {},
      { requirementsConfirmed: true },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /it adds "r2" to requires; a revision may add only "access", and anything else needs a new build/,
    );
  });

  it("renames Workflows per install and refuses a name that is taken", async () => {
    const bindings = [
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
    ];
    const ok = await install({ bindings });
    expect(ok.error).toBeNull();
    expect(ok.step.names).toContain("check Workflow cut-jobs");
    expect((ok.fake.state.metadata?.bindings as unknown[] | undefined)?.[1]).toEqual({
      type: "workflow",
      name: "JOBS",
      workflow_name: "cut-jobs",
      class_name: "JobWorkflow",
    });
    expect(ok.resources).toContainEqual({
      kind: "workflow",
      binding: "JOBS",
      name: "cut-jobs",
      cf_id: null,
    });

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const taken = await install({ bindings }, { workflows: ["cut-jobs"] });
    expect(taken.job?.error).toBe(
      'check Workflow cut-jobs: a Workflow named cut-jobs already exists in this account (script "appflare"); Appflare does not adopt existing Workflows',
    );
    expect(taken.fake.state.calls).not.toContain("POST /storage/kv/namespaces");
  });

  it("retries a create whose response was lost without creating twice", async () => {
    const r = await install({}, { failAfter: new Set(["POST /storage/kv/namespaces"]) });
    expect(r.error).toBeNull();
    expect(r.step.retried["create KV namespace cut-cut-kv"]).toBe(2);
    expect(r.fake.state.kv).toEqual([{ id: "kv-1", title: "cut-cut-kv" }]);
    expect(r.resources[0]).toEqual({
      kind: "kv",
      binding: "CUT_KV",
      name: "cut-cut-kv",
      cf_id: "kv-1",
    });
    expect(r.logs.some((l) => l.message.includes("an earlier attempt created"))).toBe(true);
  });

  it("retries a metadata index whose response was lost without creating it twice", async () => {
    const metadataIndexes = [{ propertyName: "url", type: "string" as const }];
    const r = await install(
      {
        bindings: [
          {
            type: "vectorize",
            name: "VECTORIZE",
            dimensions: 3,
            metric: "cosine",
            metadataIndexes,
          },
        ],
        catalog: {
          resources: {
            vectorize: { VECTORIZE: { dimensions: 3, metric: "cosine", metadataIndexes } },
          },
        },
      },
      {
        // Cloudflare takes the create, then the answer is lost: the step fails and retries.
        failAfter: new Set(["POST /vectorize/v2/indexes/cut-vectorize/metadata_index/create"]),
      },
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.retried["create metadata index url on Vectorize index cut-vectorize"]).toBe(2);
    expect(r.fake.state.metadataIndexes["cut-vectorize"]).toEqual([
      { propertyName: "url", indexType: "string" },
    ]);
    expect(
      r.logs.some((l) => l.message.includes('metadata index on "url" an earlier attempt created')),
    ).toBe(true);
  });

  it("does not re-apply a D1 migration an earlier attempt applied", async () => {
    const r = await install(
      {
        bindings: [{ type: "d1", name: "DB" }],
        d1: { DB: [{ name: "0001_init.sql", content: "CREATE TABLE t (id TEXT);" }] },
      },
      { failAfter: new Set(["POST /d1/database/d1-1/query"]) },
    );
    // The first query (the d1_migrations CREATE) fails after running; later ones pass.
    expect(r.error).toBeNull();
    expect(r.fake.state.applied).toEqual(["0001_init.sql"]);
    expect(r.fake.state.queries.filter((q) => q.startsWith("CREATE TABLE t"))).toHaveLength(1);
  });

  describe("an app with many D1 migrations", () => {
    /** `count` migration files, each creating its own table. */
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `${String(i + 1).padStart(4, "0")}_table${i + 1}.sql`,
        content: `CREATE TABLE t${i + 1} (id TEXT);`,
      }));
    const names = (count: number) => files(count).map((f) => f.name);
    const d1Steps = (r: Awaited<ReturnType<typeof install>>) =>
      r.step.names.filter((n) => n.startsWith("D1 DB"));
    const d1Calls = (r: Awaited<ReturnType<typeof install>>) =>
      r.self.calls.filter((c) => c.unit === "applyD1Migrations").map((c) => c.subrequests);
    /** How many queries ran each file (the file's SQL and its d1_migrations row). */
    const runs = (r: Awaited<ReturnType<typeof install>>, file: string) =>
      r.fake.state.queries.filter((q) => q.endsWith(`values ('${file}');`)).length;

    it("applies 30 migrations from a release asset in one unit call", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(30) } },
        { artifactRedirect: true },
      );
      expect(r.error).toBeNull();
      expect(d1Steps(r)).toEqual(["D1 DB: apply migrations"]);
      // The table, the list, the redirect and one range for every file, one query per file.
      expect(d1Calls(r)).toEqual([34]);
      expect(r.fake.state.applied).toEqual(names(30));
    });

    it("continues in a further call from the first file that did not fit", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(40) } },
        { artifactRedirect: true },
      );
      expect(r.error).toBeNull();
      expect(d1Steps(r)).toEqual([
        "D1 DB: apply migrations",
        "D1 DB: apply migrations from 0033_table33.sql",
      ]);
      expect(d1Calls(r)).toEqual([36, 12]);
      expect(r.fake.state.applied).toEqual(names(40));
    });

    it("resumes a retried call after the last applied file, without running any twice", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(30) } },
        { failMigration: { file: "0013_table13.sql", status: 500, times: 1 } },
      );
      expect(r.error).toBeNull();
      expect(r.step.retried).toEqual({ "D1 DB: apply migrations": 2 });
      expect(r.fake.state.applied).toEqual(names(30));
      for (const file of names(30)) expect(runs(r, file)).toBe(1);
      // The second attempt listed 12 files as applied and started at the 13th.
      expect(r.logs.map((l) => l.message)).toContain(
        "12 migration(s) already applied to cut-db; applying 18 of 18 new.",
      );
    });

    it("stops at the file whose statement fails, with Cloudflare's error", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(30) } },
        { failMigration: { file: "0024_table24.sql", status: 400, times: 1 } },
      );
      expect(r.job?.status).toBe("failed");
      expect(r.installRow?.status).toBe("failed");
      expect(r.job?.error).toBe(
        `D1 DB: apply migrations: 0024_table24.sql: Cloudflare API request failed: POST /accounts/${ACC}/d1/database/d1-1/query -> 400: [7500] near "BROKEN": syntax error`,
      );
      expect(r.step.retried).toEqual({});
      expect(r.fake.state.applied).toEqual(names(23));
      for (const file of names(30).slice(24)) expect(runs(r, file)).toBe(0);
      expect(r.step.names.at(-1)).toBe("mark install failed");
    });
  });

  it("runs the units in its own invocation when the Worker has no SELF binding", async () => {
    const options = {
      bindings: [{ type: "d1" as const, name: "DB" }],
      assets: [{ route: "/a.txt", content: "a" }],
      d1: { DB: [{ name: "0001_init.sql", content: "CREATE TABLE t (id TEXT);" }] },
    };
    const remote = await install(options);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const local = await install(options, {}, {}, {}, undefined, "local");
    expect(local.error).toBeNull();
    expect(local.job?.status).toBe("succeeded");
    expect(local.self.calls).toEqual([]);
    // The same steps, the same Cloudflare calls, the same outcome.
    expect(local.step.names).toEqual(remote.step.names);
    expect(local.fake.state.calls).toEqual(remote.fake.state.calls);
    expect(local.fake.state.applied).toEqual(["0001_init.sql"]);
    expect(local.logs.map((l) => l.message)).toEqual(remote.logs.map((l) => l.message));
  });

  it("uses the session JWT when Cloudflare already has every asset (zero buckets)", async () => {
    const assets = [{ route: "/a.txt", content: "a" }];
    const fixture = await buildArtifactFixture({ assets });
    const r = await install(
      { assets },
      { uploaded: new Set(fixture.manifest.assets.files.map((f) => f.hash)) },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.bucketUploads).toBe(0);
    expect(r.step.names).not.toContain("upload assets bucket 1/1");
    expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe("session-jwt");
  });

  describe("asset upload from a release asset that redirects", () => {
    const smallFiles = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        route: `/f${i}.js`,
        content: `export const f${i} = ${i};`,
      }));
    const uploadSteps = (r: { step: { names: string[] } }) =>
      r.step.names.filter((n) => n.startsWith("upload assets bucket"));
    const artifactRequests = (r: { fake: { state: FakeState } }, name: string) =>
      (r.fake.state.requestsByStep[name] ?? []).filter((u) => u === ZIP_URL || u === STORAGE_URL);

    it("reads a bucket of 30 small files with one range request, following the redirect once", async () => {
      const r = await install({ assets: smallFiles(30) }, { artifactRedirect: true });
      expect(r.error).toBeNull();
      expect(uploadSteps(r)).toEqual(["upload assets bucket 1/1"]);
      // One redirect hop, one ranged read of the storage URL, one upload: 3, not 61.
      expect(r.fake.state.requestsByStep["upload assets bucket 1/1"]).toEqual([
        ZIP_URL,
        STORAGE_URL,
        "https://api.cloudflare.com/client/v4/accounts/acc0000000000000000000000000000a/workers/assets/upload?base64=true",
      ]);
      expect(r.fake.state.bucketUploads).toBe(1);
      expect([...r.fake.state.uploaded].sort()).toEqual([...r.fake.state.bucketHashes].sort());
      expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe(
        "completion-jwt",
      );
      expect(
        r.logs.some((l) =>
          /Uploaded 30 asset file\(s\), \d+ bytes, read with 1 range request\(s\)\./.test(
            l.message,
          ),
        ),
      ).toBe(true);
    });

    it("follows the redirect once per step when Cloudflare spreads the files over buckets", async () => {
      // The live failure: 27 files in three buckets of nine.
      const r = await install(
        { assets: smallFiles(27) },
        { artifactRedirect: true, bucketSize: 9 },
      );
      expect(r.error).toBeNull();
      expect(uploadSteps(r)).toEqual([
        "upload assets bucket 1/3",
        "upload assets bucket 2/3",
        "upload assets bucket 3/3",
      ]);
      for (const name of uploadSteps(r)) {
        expect(artifactRequests(r, name)).toEqual([ZIP_URL, STORAGE_URL]);
      }
      expect(r.fake.state.bucketUploads).toBe(3);
    });

    it("splits a bucket that does not fit one step, and no step passes 40 subrequests", async () => {
      // One upload request per file: 60 files cannot share one step.
      const r = await install(
        { assets: smallFiles(60) },
        { artifactRedirect: true, singleUploads: true },
      );
      expect(r.error).toBeNull();
      expect(uploadSteps(r)).toEqual([
        "upload assets bucket 1/1 part 1/2",
        "upload assets bucket 1/1 part 2/2",
      ]);
      for (const name of uploadSteps(r)) {
        expect(artifactRequests(r, name)).toEqual([ZIP_URL, STORAGE_URL]);
      }
      // Each part is one unit call: one redirect, one range, 30 or so uploads.
      const parts = r.self.calls.filter((c) => c.unit === "uploadAssetPart");
      expect(parts.map((c) => c.subrequests)).toEqual([36, 28]);
      for (const call of r.self.calls) expect(call.subrequests).toBeLessThan(40);
      expect(r.fake.state.bucketUploads).toBe(60);
      expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe(
        "completion-jwt",
      );
    });

    it("fails at once, without retrying, when the runtime refuses a subrequest", async () => {
      const r = await install(
        { assets: smallFiles(3) },
        {
          artifactThrows:
            "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
        },
      );
      expect(r.error).toBeInstanceOf(Error);
      expect(r.step.retried["upload assets bucket 1/1"]).toBeUndefined();
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^upload assets bucket 1\/1: GET assets\/f0\.js and 2 more file\(s\) failed: Too many subrequests by single Worker invocation\. Cloudflare allows 50 subrequests per Worker invocation on the free plan, and a retry would make the same requests and hit the same limit, so the job stopped instead of retrying\.$/,
      );
    });
  });

  it("fails without adopting an existing Worker of the same name", async () => {
    const r = await install({}, { scripts: ["appflare", "cut"] });
    expect(r.error).toBeInstanceOf(Error);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      "check Worker name: a Worker named cut already exists in this account; Appflare does not adopt existing Workers",
    );
    expect(r.installRow?.status).toBe("failed");
    expect(r.step.names.at(-1)).toBe("mark install failed");
    expect(r.fake.state.calls).not.toContain("POST /storage/kv/namespaces");
  });

  it("fails without adopting an existing resource, keeping what it created", async () => {
    const r = await install(
      {
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "d1", name: "DB" },
        ],
      },
      { d1: [{ uuid: "someone-elses", name: "cut-db" }] },
    );
    expect(r.job?.error).toBe(
      "check D1 database cut-db: a D1 database named cut-db already exists in this account; Appflare does not adopt existing resources",
    );
    expect(r.resources).toEqual([
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cf_id: "kv-1" },
    ]);
  });

  describe("an app that requires R2", () => {
    const r2App: ArtifactFixtureOptions = {
      catalog: { requires: ["r2"] },
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "r2_bucket", name: "FILES" },
      ],
    };

    it("creates and records the bucket, and logs the confirmed requirement", async () => {
      const r = await install(r2App, {}, { requirementsConfirmed: true });
      expect(r.error).toBeNull();
      expect(r.fake.state.r2).toEqual(["cut-files"]);
      expect(r.resources).toContainEqual({
        kind: "r2",
        binding: "FILES",
        name: "cut-files",
        cf_id: "cut-files",
      });
      const messages = r.logs.map((l) => l.message);
      expect(messages).toContain(
        "Requires R2: R2 must be enabled on the account, which needs a payment method on file even on the free tier.",
      );
      expect(messages).toContain("The admin confirmed this account meets these requirements.");
      expect(messages).toContain("R2 is enabled on this account.");
    });

    it("stops before creating anything when R2 is not enabled, and says what to do", async () => {
      const r = await install(r2App, { r2Enabled: false }, { requirementsConfirmed: true });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        "check R2 is enabled: R2 is not enabled on this Cloudflare account, so the R2 bucket cut-files cannot be created. Enable R2 in the Cloudflare dashboard under R2 Object Storage. Cloudflare asks for a payment method on file before enabling R2, even though its free tier costs nothing. Then try again.",
      );
      expect(r.installRow?.status).toBe("failed");
      expect(r.resources).toEqual([]);
      expect(r.fake.state.calls).not.toContain("POST /storage/kv/namespaces");
      // Not retried: the refusal is a 4xx.
      expect(r.fake.state.calls.filter((c) => c === "GET /r2/buckets")).toHaveLength(1);
    });

    it("refuses a job whose requirements were explicitly not confirmed", async () => {
      const r = await install(
        r2App,
        {},
        { requirementsConfirmed: true },
        { requirementsConfirmed: false },
      );
      expect(r.job?.error).toBe(
        "preflight checks: this app needs R2; confirm the account meets these requirements to install it",
      );
      expect(r.fake.state.calls).toEqual([]);
    });
  });

  describe("an app with cron triggers on a free account", () => {
    const cronApp: ArtifactFixtureOptions = { crons: ["0 1 * * *", "*/15 * * * *"] };
    /** The manager and two apps: 4 cron triggers on Workers with a scheduled handler. */
    const busy = (): Partial<FakeState> & Pick<FakeState, "handlers"> => ({
      scripts: ["appflare", "second-brain", "flaremo", "appflare-docs"],
      handlers: {
        appflare: ["fetch", "scheduled"],
        "second-brain": ["fetch", "scheduled"],
        flaremo: ["fetch", "scheduled", "queue"],
        "appflare-docs": ["fetch"],
      },
      otherCrons: {
        appflare: ["*/30 * * * *"],
        "second-brain": ["0 1 * * *", "0 13 * * *"],
        flaremo: ["17 3 * * *"],
      },
      freeCronLimit: true,
    });

    it("refuses before creating anything when its triggers would pass 5, naming the count", async () => {
      const r = await install(cronApp, busy());
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        "check cron trigger limit: this app needs 2 cron triggers and the account's other Workers already use 4 (second-brain: 2, appflare: 1, flaremo: 1); Workers Free allows 5 per account, so this would make 6. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account). If it is already on Workers Paid, choose that plan under [Workers plan in Your account](/settings/account#capability-workers-plan). Then try again.",
      );
      expect(r.installRow?.status).toBe("failed");
      expect(r.resources).toEqual([]);
      expect(r.step.names.slice(-2)).toEqual(["check cron trigger limit", "mark install failed"]);
      expect(r.step.retried).toEqual({});
      // Counted in a unit of its own; a Worker without a scheduled handler is not read.
      expect(r.self.calls.map((c) => [c.unit, c.subrequests])).toEqual([["countCronTriggers", 4]]);
      expect(r.fake.state.calls).not.toContain("GET /workers/scripts/appflare-docs/schedules");
      expect(r.fake.state.calls.some((c) => c.startsWith("POST ") || c.startsWith("PUT "))).toBe(
        false,
      );
    });

    it("installs when the triggers fit, and logs the count", async () => {
      const r = await install(cronApp, {
        ...busy(),
        otherCrons: { appflare: ["*/30 * * * *"], flaremo: ["17 3 * * *"] },
      });
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.schedules).toEqual(["0 1 * * *", "*/15 * * * *"]);
      expect(r.logs.map((l) => l.message)).toContain(
        "The account's other Workers use 2 cron triggers; with 2 more that is 4 of the 5 Workers Free allows.",
      );
    });

    it("skips the count when the admin confirmed Workers Paid", async () => {
      const r = await install(
        cronApp,
        { ...busy(), freeCronLimit: false },
        { paidConfirmed: true },
      );
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
      expect(r.self.calls.map((c) => c.unit)).not.toContain("countCronTriggers");
      expect(r.fake.state.schedules).toEqual(["0 1 * * *", "*/15 * * * *"]);
    });

    it("skips the count when Settings records the account as on Workers Paid", async () => {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'paid', 0)",
      ).run();
      const r = await install(cronApp, { ...busy(), freeCronLimit: false });
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
      expect(r.fake.state.schedules).toEqual(["0 1 * * *", "*/15 * * * *"]);
    });

    it("skips the count when the capability probes detected Workers Paid, over a manual free", async () => {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'free', 0), ('account_capabilities', ?, 0)",
      )
        .bind(
          JSON.stringify({
            checkedAt: "2026-09-24T00:00:00.000Z",
            r2: { state: "enabled" },
            containers: { state: "available" },
            workersPlan: { state: "paid" },
          }),
        )
        .run();
      const r = await install(cronApp, { ...busy(), freeCronLimit: false });
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
    });

    it("counts when the probes detected Workers Free, over a manual paid", async () => {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'paid', 0), ('account_capabilities', ?, 0)",
      )
        .bind(
          JSON.stringify({
            checkedAt: "2026-09-24T00:00:00.000Z",
            r2: { state: "enabled" },
            containers: { state: "needs-workers-paid" },
            workersPlan: { state: "free" },
          }),
        )
        .run();
      const r = await install(cronApp, busy());
      expect(r.step.names).toContain("check cron trigger limit");
    });

    it("maps Cloudflare's refusal at the cron trigger step into what to do, without retrying", async () => {
      // A Worker without a scheduled handler still holds triggers, so the
      // count misses them and Cloudflare refuses the schedule.
      const account = busy();
      const r = await install(cronApp, {
        ...account,
        handlers: { ...account.handlers, flaremo: ["fetch"], "second-brain": ["fetch"] },
      });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        'set cron triggers: Cloudflare refused 2 cron triggers: this account has reached the Workers Free limit of 5 cron triggers per account. The Worker "cut" is uploaded without them; uninstall this install to remove it. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account), then try again.',
      );
      expect(r.step.retried).toEqual({});
      expect(
        r.fake.state.calls.filter((c) => c === "PUT /workers/scripts/cut/schedules"),
      ).toHaveLength(1);
      // The Worker exists and stays recorded; no cron trigger is.
      expect(r.resources).toContainEqual({
        kind: "worker",
        binding: null,
        name: "cut",
        cf_id: "cut",
      });
      expect(r.resources.some((row) => (row as { kind: string }).kind === "cron")).toBe(false);
      expect(r.fake.state.schedules).toEqual([]);
    });

    it("goes on without the count when the account has too many scheduled Workers to read", async () => {
      const many = Array.from({ length: 21 }, (_, i) => `worker-${i}`);
      const r = await install(cronApp, {
        scripts: many,
        handlers: Object.fromEntries(many.map((w) => [w, ["scheduled"]])),
      });
      expect(r.error).toBeNull();
      expect(r.logs.map((l) => l.message)).toContain(
        "Did not count the account's cron triggers: the account has 21 Workers with scheduled handlers, more than the 20 this check reads. Cloudflare checks the limit when the cron triggers are set.",
      );
      expect(r.fake.state.calls.filter((c) => c.endsWith("/schedules"))).toEqual([
        "PUT /workers/scripts/cut/schedules",
      ]);
    });
  });

  it("verifies a custom catalog's release with that catalog's pinned key, never the official keys", async () => {
    const seedCatalog = async (keys: SigningKey[]) => {
      await env.DB.prepare(
        `INSERT INTO catalogs (id, kind, label, colour, index_url, keys_json, enabled, added_at)
         VALUES ('acme', 'custom', 'Acme', 'blue', 'https://acme.test/index.json', ?1, 1, 1)`,
      )
        .bind(JSON.stringify(keys))
        .run();
    };
    // Pinned with another key: refused before anything is created, although
    // the release verifies with what the official catalog trusts in this test.
    const other = await buildArtifactFixture();
    const refused = await install({}, {}, {}, { catalogId: "acme" }, undefined, "self", () =>
      seedCatalog(other.keys),
    );
    expect(refused.job?.status).toBe("failed");
    expect(refused.job?.error).toMatch(
      /^verify artifact manifest: manifest signature does not verify with keyId "test-key"/,
    );
    expect(refused.fake.state.calls).toEqual([]);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const installed = await install({}, {}, {}, { catalogId: "acme" }, undefined, "self", (_, f) =>
      seedCatalog(f.keys),
    );
    expect(installed.error).toBeNull();
    expect(installed.job?.status).toBe("succeeded");
  });

  it("fails when the custom catalog its app comes from was removed", async () => {
    const r = await install({}, {}, {}, { catalogId: "gone" });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      'catalog keys: the catalog "gone" this app comes from was removed from Appflare; add it again to install or update its apps',
    );
    expect(r.fake.state.calls).toEqual([]);
  });

  it("rejects an artifact whose manifest does not match the catalog digest", async () => {
    const fixture = await buildArtifactFixture();
    const fake = fakeWorld(fixture);
    const { params, jobId } = await start(fixture);
    const step = fakeStep();
    await expect(
      runInstall({
        params: { ...params, digest: "f".repeat(64) },
        step,
        env: jobEnv(),
        deps: { fetch: fake.fetch, signingKeys: fixture.keys },
      }),
    ).rejects.toThrow(/verify artifact manifest: manifest.json digest/);
    const job = await env.DB.prepare("SELECT error FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(String(job?.error)).toMatch(/^verify artifact manifest: /);
    expect(fake.state.calls).toEqual([]);
  });

  it("keeps probing a route that is slow to go live, with backoff", async () => {
    const edge = { status: 404, body: "error code: 1042" };
    const r = await install(
      {},
      { health: [edge, edge, edge, edge, edge, { status: 401, body: "" }] },
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(6);
    const waits = r.step.sleeps.flatMap((name, i) =>
      name.startsWith("health wait") ? [r.step.sleepDurations[i]] : [],
    );
    expect(waits).toEqual(["2 seconds", "3 seconds", "5 seconds", "8 seconds", "10 seconds"]);
    expect(r.installRow?.health_status).toBe("verified");
  });

  it("still installs a Worker it cannot verify within the window, and says so", async () => {
    const r = await install({}, { health: [{ status: 404, body: "error code: 1042" }] });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", error: null });
    expect(r.installRow?.status).toBe("installed");
    expect(r.installRow?.health_status).toBe("unverified");
    expect(r.installRow?.health_checked_at).not.toBeNull();
    // 2+3+5+8 s, then every 10 s: probes at 0, 2, 5, 10, 18, 28, ... 88 s.
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(12);
    expect(r.step.sleeps.filter((s) => s.startsWith("health wait"))).toHaveLength(11);
    expect(
      r.logs.some(
        (l) =>
          l.level === "warn" &&
          l.message.startsWith(`Could not verify ${HEALTH_URL} after 12 attempts`) &&
          l.message.includes("Open the app to check"),
      ),
    ).toBe(true);
    expect(r.logs.at(-1)?.message).toMatch(/\(health: not verified yet \(404 error code: 1042/);
  });

  it("ends the window by the clock when probes are slow", async () => {
    let clock = 1_000_000;
    const r = await install(
      {},
      {
        health: [{ status: 404, body: "error code: 1042" }],
        // Each probe takes 10 s (a timeout).
        onHealthProbe: () => {
          clock += 10_000;
        },
      },
      {},
      {},
      {
        now: () => clock,
        onSleep: (_name, duration) => {
          clock += Number.parseInt(String(duration), 10) * 1000;
        },
      },
    );
    expect(r.job?.status).toBe("succeeded");
    // Probes start at 0, 12, 25, 40, 58, 78, 98 s: the seventh is past 90 s.
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(7);
    expect(r.installRow?.health_status).toBe("unverified");
  });

  it("records a Worker that answers only 5xx as unhealthy without failing", async () => {
    const r = await install({}, { health: [{ status: 502, body: "bad gateway" }] });
    expect(r.job?.status).toBe("succeeded");
    expect(r.installRow?.status).toBe("installed");
    expect(r.installRow?.health_status).toBe("unhealthy");
    expect(r.logs.some((l) => l.level === "warn" && l.message.includes("server error"))).toBe(true);
  });

  it("accepts a plain 404 at the root once the window ends", async () => {
    const r = await install({}, { health: [{ status: 404, body: "Not found" }] });
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(12);
    expect(r.installRow?.health_status).toBe("verified");
  });

  it("probes the catalog's health path", async () => {
    const r = await install(
      {
        catalog: {
          install: {
            tier: "artifact",
            packageManager: "pnpm",
            wranglerConfig: "wrangler.jsonc",
            workerName: "cut",
            health: { path: "/api/health" },
          },
        },
      },
      { health: [{ status: 200, body: '{"ok":true}' }] },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.healthUrls).toEqual([`${WORKER_ORIGIN}/api/health`]);
    expect(r.installRow?.health_status).toBe("verified");
    // The app's URL, not the health path, is what the admin opens.
    expect(r.logs.at(-1)?.message).toMatch(new RegExp(`at ${HEALTH_URL} \\(health: verified`));
  });

  it("refuses an artifact whose Worker is too large for one upload, before creating anything", async () => {
    const r = await install({
      tweak: (m) => {
        const first = m.worker.modules[0];
        if (first === undefined) throw new Error("the fixture has no module");
        // Never fetched: the check reads the manifest alone.
        first.size = 40 * 1024 * 1024;
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      "preflight checks: This app version has 40.00 MiB of Worker modules, but Appflare uploads at most 32.00 MiB: the upload holds every module and the request body in memory at once, within the 128 MB a Worker may use. Make the Worker smaller, for example by minifying it or serving large files as static assets.",
    );
    expect(r.installRow?.status).toBe("failed");
    expect(r.resources).toEqual([]);
    expect(r.fake.state.calls).toEqual([]);
  });

  it("refuses an artifact whose modules take more ranges than one upload may read, before creating anything", async () => {
    const r = await install({
      tweak: (m) => {
        const first = m.worker.modules[0];
        if (first === undefined) throw new Error("the fixture has no module");
        // 42 small modules 1 MiB apart: each needs a Range request of its own,
        // 43 subrequests with the redirect, though they add up to a few KiB.
        for (let i = 1; i < 42; i++) {
          m.worker.modules.push({ ...first, name: `chunk-${i}.js`, offset: i * 1024 * 1024 });
        }
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      "preflight checks: This app version needs 43 subrequests to read its 42 Worker modules (42 Range requests to the release zip and the redirect), but one upload may make at most 42 of the free plan's 50 per invocation. Pack it again with the current packer, which writes a Worker's modules next to each other in the zip.",
    );
    expect(r.installRow?.status).toBe("failed");
    expect(r.resources).toEqual([]);
    expect(r.fake.state.calls).toEqual([]);
  });

  it("fails before touching Cloudflare when no API token is configured", async () => {
    const fixture = await buildArtifactFixture();
    const fake = fakeWorld(fixture);
    const { params, jobId } = await start(fixture);
    await expect(
      runInstall({
        params,
        step: fakeStep(),
        env: { DB: env.DB },
        deps: { fetch: fake.fetch, signingKeys: fixture.keys },
      }),
    ).rejects.toThrow(/token is not configured/);
    const job = await env.DB.prepare("SELECT error FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(job?.error).toBe(
      "preflight checks: the Cloudflare API token is not configured; finish setup first",
    );
    expect(fake.state.calls).toEqual([]);
  });

  it("records the Worker before uploading it, so a lost upload response is still owned", async () => {
    const r = await install({}, { failAfter: new Set(["PUT /workers/scripts/cut"]) });
    // The upload is retried and succeeds; the row recorded before it gets the id.
    expect(r.error).toBeNull();
    expect(r.step.names.indexOf("record Worker name")).toBeLessThan(
      r.step.names.indexOf("upload Worker script"),
    );
    expect(r.resources).toContainEqual({
      kind: "worker",
      binding: null,
      name: "cut",
      cf_id: "cut",
    });
  });

  it("releases the pending Worker row when Cloudflare refuses the upload", async () => {
    const r = await install({}, { uploadStatus: 400 });
    expect(r.job?.error).toMatch(/^upload Worker script: /);
    const row = await env.DB.prepare(
      "SELECT cf_id, deleted_at FROM resources WHERE kind = 'worker'",
    ).first<{ cf_id: string | null; deleted_at: number | null }>();
    expect(row?.cf_id).toBeNull();
    // Deleted: an uninstall must not treat a same-named Worker as this install's.
    expect(row?.deleted_at).not.toBeNull();
  });

  it("keeps the pending Worker row when the upload fails with a 5xx", async () => {
    const r = await install({}, { uploadStatus: 503 });
    expect(r.job?.status).toBe("failed");
    const row = await env.DB.prepare(
      "SELECT deleted_at FROM resources WHERE kind = 'worker'",
    ).first<{ deleted_at: number | null }>();
    expect(row).toEqual({ deleted_at: null });
  });

  it("does not flip an install that left `installing` back to installed", async () => {
    const fixture = await buildArtifactFixture();
    const fake = fakeWorld(fixture, { health: [{ status: 200, body: "ok" }] });
    const { params, installId, jobId } = await start(fixture);
    const fetch = async (input: string, init?: RequestInit) => {
      // The job was settled from outside while it ran.
      if (input === HEALTH_URL) {
        await env.DB.prepare("UPDATE installs SET status = 'failed' WHERE id = ?1")
          .bind(installId)
          .run();
      }
      return fake.fetch(input, init);
    };
    await runInstall({
      params,
      step: fakeStep(),
      env: jobEnv(),
      deps: { fetch, signingKeys: fixture.keys },
    });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
      .bind(installId)
      .first();
    expect(install).toEqual({ status: "failed" });
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(job).toEqual({ status: "succeeded" });
  });

  describe("an app with queue consumers", () => {
    const queueApp: ArtifactFixtureOptions = {
      bindings: [{ type: "queue", name: "JOBS" }],
      tweak: (m) => {
        m.worker.queueConsumers = [
          {
            queue: { binding: "JOBS" },
            max_batch_size: 5,
            max_batch_timeout: 2,
            max_retries: 3,
            dead_letter_queue: { name: "jobs-dlq" },
          },
          { queue: { name: "jobs-dlq" } },
        ];
      },
    };

    it("creates the dead-letter queue and attaches each consumer after the upload", async () => {
      const r = await install(queueApp);
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.queues).toEqual([
        { queue_id: "q-1", queue_name: "cut-jobs" },
        { queue_id: "q-2", queue_name: "cut-jobs-dlq" },
      ]);
      expect(r.fake.state.consumers).toEqual({
        "q-1": [
          {
            type: "worker",
            script_name: "cut",
            dead_letter_queue: "cut-jobs-dlq",
            settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 2000 },
            consumer_id: "c-q-1-1",
          },
        ],
        "q-2": [{ type: "worker", script_name: "cut", consumer_id: "c-q-2-1" }],
      });
      const calls = r.fake.state.calls;
      expect(calls.indexOf("POST /queues/q-1/consumers")).toBeGreaterThan(
        calls.indexOf("PUT /workers/scripts/cut"),
      );
      // Only the producer binding reaches the upload; the dead-letter queue is not bound.
      expect(r.fake.state.metadata?.bindings).toContainEqual({
        type: "queue",
        name: "JOBS",
        queue_name: "cut-jobs",
      });
      expect(JSON.stringify(r.fake.state.metadata?.bindings)).not.toContain("dlq");
      expect(r.resources).toEqual(
        expect.arrayContaining([
          { kind: "queue", binding: "JOBS", name: "cut-jobs", cf_id: "q-1" },
          { kind: "queue", binding: null, name: "cut-jobs-dlq", cf_id: "q-2" },
          { kind: "queue_consumer", binding: null, name: "cut-jobs", cf_id: "c-q-1-1" },
          { kind: "queue_consumer", binding: null, name: "cut-jobs-dlq", cf_id: "c-q-2-1" },
        ]),
      );
    });

    it("does not attach a consumer twice when the response of the first attempt is lost", async () => {
      const r = await install(queueApp, { failAfter: new Set(["POST /queues/q-1/consumers"]) });
      expect(r.error).toBeNull();
      expect(r.fake.state.consumers["q-1"]).toHaveLength(1);
      expect(r.step.retried["attach consumer to queue cut-jobs"]).toBe(2);
      expect(r.resources).toContainEqual({
        kind: "queue_consumer",
        binding: null,
        name: "cut-jobs",
        cf_id: "c-q-1-1",
      });
    });

    it("refuses a consumer of a queue the Worker does not bind, before creating anything", async () => {
      const r = await install({
        ...queueApp,
        tweak: (m) => {
          m.worker.queueConsumers = [{ queue: { binding: "MISSING" } }];
        },
      });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(/preflight checks: .*queue binding MISSING/);
      expect(r.fake.state.queues).toEqual([]);
    });
  });

  it("gives each rate limit a namespace of its own instead of the artifact's", async () => {
    const r = await install({
      bindings: [
        {
          type: "ratelimit",
          name: "LIMITER",
          namespace_id: "1001",
          simple: { limit: 20, period: 60 },
        },
      ],
    });
    expect(r.error).toBeNull();
    const bindings = (r.fake.state.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
    const sent = bindings.find((b) => b.type === "ratelimit");
    expect(sent).toMatchObject({ name: "LIMITER", simple: { limit: 20, period: 60 } });
    const id = String(sent?.namespace_id);
    expect(id).toMatch(/^[1-9]\d*$/);
    expect(id).not.toBe("1001");
    expect(Number(id)).toBeLessThanOrEqual(2_147_483_647);
    expect(r.resources).toContainEqual({
      kind: "ratelimit",
      binding: "LIMITER",
      name: "LIMITER",
      cf_id: id,
    });
  });

  it("verifies an app in any-response mode by any answer of its own Worker", async () => {
    const r = await install(
      {
        catalog: {
          install: {
            tier: "artifact",
            packageManager: "pnpm",
            wranglerConfig: "wrangler.jsonc",
            workerName: "cut",
            health: { mode: "any-response" },
          },
        },
      },
      {
        health: [
          { status: 404, body: "error code: 1042\n" },
          { status: 500, body: "Cloudflare Access must be configured in production." },
        ],
      },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.healthUrls).toHaveLength(2);
    expect(r.installRow?.health_status).toBe("verified");
  });

  it("records the Durable Object migration tag the upload applied", async () => {
    const r = await install({
      bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }],
      migrations: [
        { tag: "v1", new_sqlite_classes: ["Room"] },
        { tag: "v2", new_sqlite_classes: ["Lobby"] },
      ],
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.metadata?.migrations).toEqual({
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["Room"] }, { new_sqlite_classes: ["Lobby"] }],
    });
    expect(r.installRow?.do_migration_tag).toBe("v2");
  });
});

describe("install job, an app of several Workers", () => {
  /** The primary Worker binds the `jobs` Worker; `jobs` implements the Durable Object. */
  const twoWorkers = (): ArtifactFixtureOptions => ({
    bindings: [
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "service", name: "JOBS", service: "{{workerName:jobs}}", entrypoint: "Jobs" },
      {
        type: "durable_object_namespace",
        name: "ROOM",
        class_name: "Room",
        script_name: "{{workerName:jobs}}",
      },
      { type: "plain_text", name: "JOBS_URL", text: "https://example.test" },
    ],
    otherWorkers: [
      {
        name: "jobs",
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
        ],
        migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
        crons: ["*/5 * * * *"],
      },
    ],
    catalog: {
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password", workers: ["app"] },
        { name: "SHARED_KEY", label: "Shared key", generate: "password" },
      ],
      vars: [
        { name: "JOBS_URL", label: "Jobs URL", default: "{{workerUrl:jobs}}", optional: true },
      ],
    },
  });
  const secrets = { secrets: { ADMIN_PASSWORD: PASSWORD, SHARED_KEY: "shared" }, vars: {} };

  it("deploys the Worker the primary one binds to first, sharing the app's resources", async () => {
    const r = await install(twoWorkers(), {}, secrets);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const calls = r.fake.state.calls;
    expect(calls.indexOf("PUT /workers/scripts/cut-jobs")).toBeLessThan(
      calls.indexOf("PUT /workers/scripts/cut"),
    );
    // One KV namespace for the binding both Workers have.
    expect(r.fake.state.kv.map((k) => k.title)).toEqual(["cut-cut-kv"]);
    const jobs = r.fake.state.others["cut-jobs"];
    const jobsBindings = (jobs?.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
    expect(jobsBindings).toContainEqual({
      type: "kv_namespace",
      name: "CUT_KV",
      namespace_id: "kv-1",
    });
    expect(jobs?.metadata?.migrations).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["Room"] }],
    });
    // Secrets go to the Workers that get them.
    expect(jobs?.secrets).toEqual({ SHARED_KEY: "shared" });
    expect(r.fake.state.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD, SHARED_KEY: "shared" });
    expect(jobs?.schedules).toEqual(["*/5 * * * *"]);
    expect(jobs?.subdomain).toEqual({ enabled: true, previews_enabled: true });
    // The primary Worker's bindings to the other one name its installed name.
    const bindings = (r.fake.state.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({
      type: "service",
      name: "JOBS",
      service: "cut-jobs",
      entrypoint: "Jobs",
    });
    expect(bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "ROOM",
      class_name: "Room",
      script_name: "cut-jobs",
    });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "JOBS_URL",
      text: "https://cut-jobs.appflare-dev.workers.dev",
    });
    expect(r.fake.state.metadata?.migrations).toBeUndefined();
    const workers = r.resources.filter((row) => row.kind === "worker").map((row) => row.name);
    expect(workers).toEqual(["cut-jobs", "cut"]);
    const recorded = await env.DB.prepare("SELECT worker_versions_json FROM installs").first<{
      worker_versions_json: string;
    }>();
    expect(JSON.parse(recorded?.worker_versions_json ?? "null")).toEqual({
      "cut-jobs": "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(r.resources.filter((row) => row.kind === "durable_object")).toEqual([
      { kind: "durable_object", binding: "ROOM", name: "Room", cf_id: null },
    ]);
    expect(r.resources.filter((row) => row.kind === "subdomain").map((row) => row.name)).toEqual([
      "cut-jobs.appflare-dev.workers.dev",
      "cut.appflare-dev.workers.dev",
    ]);
    // Step names never repeat, so each Worker's steps are its own.
    expect(new Set(r.step.names).size).toBe(r.step.names.length);
  });

  it("deploys a Worker that binds to the primary one after it", async () => {
    const r = await install({
      otherWorkers: [
        {
          name: "hooks",
          bindings: [{ type: "service", name: "APP", service: "{{workerName:app}}" }],
        },
      ],
    });
    expect(r.error).toBeNull();
    const calls = r.fake.state.calls;
    expect(calls.indexOf("PUT /workers/scripts/cut")).toBeLessThan(
      calls.indexOf("PUT /workers/scripts/cut-hooks"),
    );
    expect(r.fake.state.others["cut-hooks"]?.metadata?.bindings).toContainEqual({
      type: "service",
      name: "APP",
      service: "cut",
    });
    // The default secret goes to every Worker.
    expect(r.fake.state.others["cut-hooks"]?.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD });
  });

  it("keeps a Worker off workers.dev when its entry says so", async () => {
    const options = twoWorkers();
    const jobsWorker = options.otherWorkers?.[0];
    if (jobsWorker === undefined) throw new Error("no jobs Worker");
    const r = await install(
      {
        ...options,
        otherWorkers: [{ ...jobsWorker, workersDev: false }],
        catalog: { ...options.catalog, vars: [] },
        bindings: (options.bindings ?? []).filter((b) => b.name !== "JOBS_URL"),
      },
      {},
      secrets,
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const jobs = r.fake.state.others["cut-jobs"];
    expect(jobs?.subdomain).toEqual({ enabled: false, previews_enabled: false });
    expect(jobs?.secrets).toEqual({ SHARED_KEY: "shared" });
    const calls = r.fake.state.calls;
    expect(calls.indexOf("POST /workers/scripts/cut-jobs/subdomain")).toBeGreaterThan(
      calls.indexOf("PUT /workers/scripts/cut-jobs"),
    );
    expect(calls.indexOf("POST /workers/scripts/cut-jobs/subdomain")).toBeLessThan(
      calls.indexOf("PUT /workers/scripts/cut-jobs/secrets"),
    );
    // The primary Worker keeps its address; only it is recorded as one.
    expect(r.fake.state.subdomainEnabled).toEqual({ enabled: true, previews_enabled: true });
    expect(r.resources.filter((row) => row.kind === "subdomain").map((row) => row.name)).toEqual([
      "cut.appflare-dev.workers.dev",
    ]);
    expect(r.step.names).toContain('turn off workers.dev route (Worker "cut-jobs")');
    expect(r.step.names).not.toContain('enable workers.dev route (Worker "cut-jobs")');
  });

  it("refuses an entry of more than three Workers not marked paid, before creating anything", async () => {
    const r = await install({
      otherWorkers: [{ name: "a" }, { name: "b" }, { name: "c" }],
      catalog: { plan: "paid" },
      // A manifest the catalog would refuse, signed all the same.
      tweak: (m) => {
        m.catalog.plan = "free";
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain('an entry of 4 Workers needs \\"plan\\": \\"paid\\"');
    expect(r.fake.state.kv).toEqual([]);
  });

  describe("a Workflow one Worker runs and another defines", () => {
    const siteAudit = {
      type: "workflow",
      name: "SITE_AUDIT",
      workflow_name: "site-audit",
      class_name: "SiteAudit",
    };
    /** As OpenSEO: the primary Worker runs the audit Worker's Workflow and defines its own. */
    const auditApp = (runAs = "SITE_AUDIT"): ArtifactFixtureOptions => ({
      bindings: [
        { ...siteAudit, name: runAs, script_name: "{{workerName:audit}}" },
        { type: "workflow", name: "RANK", workflow_name: "rank", class_name: "Rank" },
      ],
      otherWorkers: [{ name: "audit", bindings: [siteAudit], workersDev: false }],
    });

    it("creates it with the Worker that defines it, first, and points the other binding there", async () => {
      const r = await install(auditApp());
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      const calls = r.fake.state.calls;
      // Both names are checked before anything is created.
      expect(r.step.names).toContain("check Workflow cut-site-audit");
      expect(r.step.names).toContain("check Workflow cut-rank");
      expect(calls.indexOf("GET /workflows/cut-site-audit")).toBeLessThan(
        calls.indexOf("PUT /workers/scripts/cut-audit"),
      );
      // The Worker that defines the Workflow is uploaded before the one that runs it.
      expect(calls.indexOf("PUT /workers/scripts/cut-audit")).toBeLessThan(
        calls.indexOf("PUT /workers/scripts/cut"),
      );
      const audit = (r.fake.state.others["cut-audit"]?.metadata?.bindings ?? []) as Array<
        Record<string, unknown>
      >;
      expect(audit.filter((b) => b.type === "workflow")).toEqual([
        {
          type: "workflow",
          name: "SITE_AUDIT",
          workflow_name: "cut-site-audit",
          class_name: "SiteAudit",
        },
      ]);
      const primary = (r.fake.state.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
      expect(primary.filter((b) => b.type === "workflow")).toEqual([
        {
          type: "workflow",
          name: "SITE_AUDIT",
          workflow_name: "cut-site-audit",
          class_name: "SiteAudit",
          script_name: "cut-audit",
        },
        { type: "workflow", name: "RANK", workflow_name: "cut-rank", class_name: "Rank" },
      ]);
      // Each Workflow is recorded once, for the uninstall to delete by name.
      expect(r.resources.filter((row) => row.kind === "workflow")).toEqual([
        { kind: "workflow", binding: "SITE_AUDIT", name: "cut-site-audit", cf_id: null },
        { kind: "workflow", binding: "RANK", name: "cut-rank", cf_id: null },
      ]);
    });

    it("names the Workflow the same under another binding name", async () => {
      const r = await install(auditApp("AUDIT"));
      expect(r.error).toBeNull();
      const primary = (r.fake.state.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
      expect(primary).toContainEqual({
        type: "workflow",
        name: "AUDIT",
        workflow_name: "cut-site-audit",
        class_name: "SiteAudit",
        script_name: "cut-audit",
      });
      expect(
        r.resources.filter((row) => row.kind === "workflow").map((row) => row.binding),
      ).toEqual(["SITE_AUDIT", "RANK"]);
    });

    /** The install's Workflow rows with whether each is still live. */
    const workflowRows = async () =>
      (
        await env.DB.prepare(
          "SELECT binding, name, deleted_at IS NULL AS live FROM resources WHERE kind = 'workflow' ORDER BY rowid",
        ).all()
      ).results;

    it("records each Workflow before the upload of the Worker that defines it", async () => {
      const r = await install(auditApp());
      expect(r.error).toBeNull();
      const order = r.step.names;
      // Recorded with each Worker's name, before its upload.
      expect(order.indexOf('record Worker name (Worker "cut-audit")')).toBeLessThan(
        order.indexOf('upload Worker script (Worker "cut-audit")'),
      );
      expect(order.indexOf("record Worker name")).toBeLessThan(
        order.indexOf("upload Worker script"),
      );
    });

    it("keeps a Workflow recorded when its Worker's upload fails with a 5xx, which may have created it", async () => {
      const r = await install(auditApp(), {
        otherUploadStatus: { name: "cut-audit", status: 500 },
      });
      expect(r.job?.status).toBe("failed");
      // The primary Worker was never reached; only the audit Worker's Workflow is recorded.
      expect(await workflowRows()).toEqual([
        { binding: "SITE_AUDIT", name: "cut-site-audit", live: 1 },
      ]);
    });

    it("releases the Workflows of a Worker whose upload Cloudflare refused, which created none", async () => {
      const refused = await install(auditApp(), {
        otherUploadStatus: { name: "cut-audit", status: 400 },
      });
      expect(refused.job?.status).toBe("failed");
      expect(await workflowRows()).toEqual([
        { binding: "SITE_AUDIT", name: "cut-site-audit", live: 0 },
      ]);
    });

    it("releases only the primary's own Workflows when its upload is refused", async () => {
      const r = await install(auditApp(), { uploadStatus: 400 });
      expect(r.job?.status).toBe("failed");
      expect(r.fake.state.calls).toContain("PUT /workers/scripts/cut-audit");
      // The audit Worker's upload created its Workflow; the primary's created none.
      expect(await workflowRows()).toEqual([
        { binding: "SITE_AUDIT", name: "cut-site-audit", live: 1 },
        { binding: "RANK", name: "cut-rank", live: 0 },
      ]);
    });

    it("refuses when the Workflow's name is taken, before creating anything", async () => {
      const r = await install(auditApp(), { workflows: ["cut-site-audit"] });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toContain("a Workflow named cut-site-audit already exists");
      expect(r.fake.state.others["cut-audit"]).toBeUndefined();
    });
  });

  it("refuses when one of the app's Worker names is taken, before creating anything", async () => {
    const r = await install(twoWorkers(), { scripts: ["appflare", "cut-jobs"] }, secrets);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("a Worker named cut-jobs already exists");
    expect(r.fake.state.kv).toEqual([]);
  });

  it("with Cloudflare Access, turns on no Worker's route until Access covers every Worker", async () => {
    const access = protectedWorld();
    const r = await install(
      twoWorkers(),
      access.world,
      { ...secrets, access: true },
      {},
      undefined,
      "self",
      addUser,
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const at = (name: string) => r.step.names.indexOf(name);
    const cover = at("cover the app's Workers with Cloudflare Access");
    expect(at("protect with Cloudflare Access")).toBeLessThan(
      at('upload Worker script (Worker "cut-jobs")'),
    );
    expect(cover).toBeGreaterThan(at("record Worker script"));
    expect(cover).toBeLessThan(at('enable workers.dev route (Worker "cut-jobs")'));
    expect(cover).toBeLessThan(at("enable workers.dev route"));
    const [app] = [...access.cf.apps.values()];
    expect(app?.destinations).toEqual([
      { type: "worker", worker_id: "tag-cut-jobs" },
      { type: "worker", worker_id: "tag-cut" },
    ]);
    expect(r.fake.state.others["cut-jobs"]?.subdomain).toEqual({
      enabled: true,
      previews_enabled: true,
    });
  });

  it("with Cloudflare Access, takes every uploaded Worker off workers.dev when the install fails before Access covers it", async () => {
    const access = protectedWorld();
    const r = await install(
      twoWorkers(),
      { ...access.world, uploadStatus: 400 },
      { ...secrets, access: true },
      {},
      undefined,
      "self",
      addUser,
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("upload Worker script");
    expect(r.step.names).toContain("keep Worker cut-jobs unreachable");
    expect(r.step.names).toContain("keep Worker cut unreachable");
    expect(r.step.names).not.toContain("cover the app's Workers with Cloudflare Access");
    expect(r.fake.state.others["cut-jobs"]?.subdomain).toEqual({
      enabled: false,
      previews_enabled: false,
    });
    const failed = r.logs.find((l) => l.message.startsWith("Install failed at"));
    expect(failed?.message).toContain('"upload Worker script"');
  });
});

describe("install job, an app of many Workers", () => {
  /** A router Worker (the primary one) bound to 17 others, as Cloudflare OS is. */
  const OTHER_NAMES = [
    "backend",
    ...Array.from({ length: 16 }, (_, i) => `gk-${String(i + 1).padStart(2, "0")}`),
  ];
  const manyWorkers = (): ArtifactFixtureOptions => ({
    bindings: [
      { type: "kv_namespace", name: "CUT_KV" },
      ...OTHER_NAMES.map((name) => ({
        type: "service",
        name: name.toUpperCase().replace(/-/g, "_"),
        service: `{{workerName:${name}}}`,
      })),
    ],
    otherWorkers: OTHER_NAMES.map((name) => ({
      name,
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      assets: [{ route: `/${name}.js`, content: `console.log(${JSON.stringify(name)})` }],
    })),
    catalog: { plan: "paid" },
  });

  it("installs 18 Workers, each in steps of its own, within the job's planned budget", async () => {
    const r = await install(manyWorkers(), {}, { paidConfirmed: true });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const calls = r.fake.state.calls;
    const primaryAt = calls.indexOf("PUT /workers/scripts/cut");
    for (const name of OTHER_NAMES) {
      // Deployed before the primary Worker, which binds every one of them.
      expect(calls.indexOf(`PUT /workers/scripts/cut-${name}`)).toBeGreaterThan(-1);
      expect(calls.indexOf(`PUT /workers/scripts/cut-${name}`)).toBeLessThan(primaryAt);
      expect(r.fake.state.others[`cut-${name}`]?.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD });
    }
    expect(r.resources.filter((row) => row.kind === "worker")).toHaveLength(18);
    const recorded = await env.DB.prepare("SELECT worker_versions_json FROM installs").first<{
      worker_versions_json: string;
    }>();
    expect(Object.keys(JSON.parse(recorded?.worker_versions_json ?? "{}"))).toHaveLength(17);

    // Every Worker's upload is a step of its own, as are its assets and address.
    const names = r.step.names;
    expect(new Set(names).size).toBe(names.length);
    const workers = entryWorkers(r.fixture.manifest, "cut");
    for (const w of workers.filter((w) => !w.primary)) {
      const label = ` (Worker "${w.scriptName}")`;
      const own = names.filter((n) => n.includes(label));
      expect(own).toEqual([
        `open assets upload session${label}`,
        `record Worker name${label}`,
        `upload Worker script${label}`,
        `record Worker script${label}`,
        `set secret ADMIN_PASSWORD${label}`,
        `enable workers.dev route${label}`,
      ]);
      expect(own.length).toBeLessThanOrEqual(otherWorkerCost(w, "install", 0).steps);
    }
    // The whole job stays inside what the plan totalled for it.
    const planned = entryJobCost(workers, "install", 0);
    expect(names.length + r.step.sleeps.length).toBeLessThanOrEqual(planned.steps);
    // Every unit call the job made was counted: here one upload per Worker
    // (the fake already stores every asset, so no asset parts).
    expect(r.self.calls.filter((c) => c.unit === "uploadWorker")).toHaveLength(18);
    expect(r.self.calls.length).toBeLessThanOrEqual(planned.unitCalls);
    expect(r.logs.some((l) => l.message.startsWith("The app's 18 Workers: an estimated"))).toBe(
      true,
    );
  });

  it("refuses when the account has no room for the app's Workers, before creating anything", async () => {
    const existing = Array.from({ length: 489 }, (_, i) => `other-${i}`);
    const r = await install(
      manyWorkers(),
      { scripts: ["appflare", ...existing] },
      { paidConfirmed: true },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "check Worker name: This app installs 18 Workers, and the account already has 490; Workers Paid allows 500 Workers per account.",
    );
    expect(r.fake.state.kv).toEqual([]);
    expect(r.fake.state.calls.filter((c) => c.startsWith("PUT /workers/scripts/"))).toEqual([]);
  });

  it("counts the account's Workers against the free plan's 100 when the account is set to Workers Free", async () => {
    const existing = Array.from({ length: 99 }, (_, i) => `other-${i}`);
    const r = await install(
      {},
      { scripts: ["appflare", ...existing] },
      {},
      {},
      undefined,
      "self",
      async () => {
        await writeSettings(createDb(env.DB), { [SETTING.accountPlan]: "free" });
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "This app installs one Worker, and the account already has 100; Workers Free allows 100 Workers per account.",
    );
    expect(r.fake.state.kv).toEqual([]);
  });

  it("holds an account of unknown plan to Workers Paid's 500: 100 Workers or more means it is on Workers Paid", async () => {
    const existing = Array.from({ length: 149 }, (_, i) => `other-${i}`);
    const r = await install({}, { scripts: ["appflare", ...existing] });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
  });
});

/** A user for "Appflare users" (the Access policy needs at least one). */
async function addUser(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role) VALUES ('u1', 'Owner', 'owner@example.com', 1, 1, 1, 'admin')",
  ).run();
}

/**
 * The account's Access objects, and the app's workers.dev address as Access
 * answers it once it covers the Worker: its sign-in page, or the app for a
 * request with the app's own service token.
 */
function protectedWorld() {
  const cf = fakeAccessAccount();
  /** Every probe of the Worker's address: whether it carried the token. */
  const probes: boolean[] = [];
  const covered = () =>
    [...cf.apps.values()].some((a) =>
      (
        a.destinations as Array<{ type: string; worker_id?: string; uri?: string }> | undefined
      )?.some((d) => d.worker_id === "tag-cut" || d.uri === "cut.appflare-dev.workers.dev"),
    );
  const world: Partial<FakeState> = {
    access: cf,
    healthAnswer: (_url, headers) => {
      const token = headers.get("CF-Access-Client-Secret");
      probes.push(token !== null);
      if (!covered()) return new Response("<html>cut, unprotected</html>", { status: 200 });
      const known = [...cf.tokens.values()].some((t) => t.client_secret === token);
      return known
        ? new Response("<html>cut</html>", { status: 200 })
        : accessChallenge("cut.appflare-dev.workers.dev");
    },
  };
  return { cf, world, probes };
}

describe("install job, an app protected with Cloudflare Access", () => {
  it("protects the app before its upload, covers the Worker by its tag before its route, and checks it through Access", async () => {
    const access = protectedWorld();
    const r = await install(
      { bindings: [{ type: "kv_namespace", name: "CUT_KV" }] },
      access.world,
      { access: true },
      {},
      undefined,
      "self",
      addUser,
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const at = (name: string) => r.step.names.indexOf(name);
    // Before anything of the app exists in the account.
    expect(at("protect with Cloudflare Access")).toBeGreaterThan(at("check Worker name"));
    expect(at("protect with Cloudflare Access")).toBeLessThan(at("create KV namespace cut-cut-kv"));
    expect(at("protect with Cloudflare Access")).toBeLessThan(at("upload Worker script"));
    // After the upload, before the route.
    expect(at("cover the app's Workers with Cloudflare Access")).toBeGreaterThan(
      at("record Worker script"),
    );
    expect(at("cover the app's Workers with Cloudflare Access")).toBeLessThan(
      at("enable workers.dev route"),
    );
    // One application, now covering the Worker by its tag; the same audience tag throughout.
    expect(access.cf.apps.size).toBe(1);
    const [app] = [...access.cf.apps.values()];
    expect(app?.destinations).toEqual([{ type: "worker", worker_id: "tag-cut" }]);
    const row = await env.DB.prepare(
      "SELECT access_app_id, access_aud, access_team_domain FROM install_access",
    ).first<{ access_app_id: string; access_aud: string; access_team_domain: string }>();
    expect(row).toEqual({
      access_app_id: app?.id,
      access_aud: app?.aud,
      access_team_domain: "appflare-test.cloudflareaccess.com",
    });
    expect(
      r.resources.filter((x) => String(x.kind).startsWith("access_")).map((x) => x.kind),
    ).toEqual(["access_service_token", "access_app"]);
    // Verified through Access: the sign-in first, then the app with its own token.
    expect(r.installRow?.health_status).toBe("verified");
    expect(access.probes).toEqual([false, true]);
    // Two unit calls, each one subrequest of the job.
    expect(r.self.calls.filter((c) => c.unit === "protectInstall").length).toBe(2);
    expect(r.self.calls.filter((c) => c.unit === "protectInstall").every((c) => c.ok)).toBe(true);
  });

  it("fails closed when the switch to the app's Workers fails: no route, previews off", async () => {
    const access = protectedWorld();
    access.cf.forbidden.add(`PUT /accounts/${ACC}/access/apps/*`);
    const r = await install({}, access.world, { access: true }, {}, undefined, "self", addUser);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("cover the app's Workers with Cloudflare Access");
    expect(r.job?.error).toContain("cannot manage Access applications");
    expect(r.installRow?.status).toBe("failed");
    expect(r.step.names).toContain("keep Worker cut unreachable");
    expect(r.step.names).not.toContain("enable workers.dev route");
    expect(r.step.names).not.toContain("set cron triggers");
    expect(r.fake.state.subdomainEnabled).toEqual({ enabled: false, previews_enabled: false });
    // The application from before the upload still guards the workers.dev address.
    expect([...access.cf.apps.values()][0]?.destinations).toEqual([
      { type: "public", uri: "cut.appflare-dev.workers.dev" },
    ]);
    expect(access.probes).toEqual([]);
  });

  it("creates nothing of the app when another Access application covers its address", async () => {
    const access = protectedWorld();
    access.cf.apps.set("other", {
      id: "other",
      aud: "aud-other",
      name: "Everything on workers.dev",
      destinations: [{ type: "public", uri: "*.appflare-dev.workers.dev" }],
      policies: [],
    });
    const r = await install(
      { bindings: [{ type: "kv_namespace", name: "CUT_KV" }] },
      access.world,
      { access: true },
      {},
      undefined,
      "self",
      addUser,
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("protect with Cloudflare Access");
    expect(r.job?.error).toContain('"Everything on workers.dev" already covers');
    expect(r.fake.state.kv).toEqual([]);
    expect(r.step.names).not.toContain("upload Worker script");
    expect(access.cf.tokens.size + access.cf.policies.size).toBe(0);
    expect(access.cf.apps.size).toBe(1);
  });

  it("uploads the Worker with the Access values from the first upload on, and makes its public paths public", async () => {
    const access = protectedWorld();
    const r = await install(
      {
        bindings: [{ type: "plain_text", name: "POLICY_AUD", text: "{{accessAud}}" }],
        catalog: {
          vars: [
            { name: "HOME_PAGE", label: "Home page", optional: true },
            { name: "TEAM", label: "Team", default: "{{accessTeamDomain}}" },
            { name: "CERTS", label: "Keys", default: "{{accessCertsUrl}}" },
          ],
          access: { mode: "required", bypass: ["/s/*"] },
          requires: ["access"],
        },
      },
      access.world,
      // An entry that requires protection is protected without asking.
      { requirementsConfirmed: true },
      {},
      undefined,
      "self",
      addUser,
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const main = [...access.cf.apps.values()].find((a) => a.name === "Appflare: Cut (cut)");
    const bindings = (r.fake.state.metadata?.bindings ?? []) as Array<{
      type: string;
      name: string;
      text?: string;
    }>;
    const text = (name: string) => bindings.find((b) => b.name === name)?.text;
    expect(main?.aud).toMatch(/^aud-/);
    expect(text("POLICY_AUD")).toBe(main?.aud);
    expect(text("TEAM")).toBe("appflare-test.cloudflareaccess.com");
    expect(text("CERTS")).toBe("https://appflare-test.cloudflareaccess.com/cdn-cgi/access/certs");
    // The public paths, once the install (and its manifest) is recorded.
    const at = (name: string) => r.step.names.indexOf(name);
    expect(at("update Cloudflare Access destinations")).toBeGreaterThan(at("finish"));
    const bypass = [...access.cf.apps.values()].find((a) =>
      a.name?.toString().endsWith("public paths"),
    );
    expect(bypass?.destinations).toEqual([
      { type: "public", uri: "cut.appflare-dev.workers.dev/s/*" },
    ]);
    // Installing it protected accepted the entry's public paths.
    const accepted = await env.DB.prepare(
      "SELECT accepted_bypass_json AS json FROM install_access",
    ).first<{ json: string }>();
    expect(JSON.parse(accepted?.json ?? "null")).toEqual(["/s/*"]);
  });

  it("refuses to start an app whose entry requires protection without it", async () => {
    const fixture = await buildArtifactFixture({
      catalog: { access: { mode: "required" }, requires: ["access"] },
    });
    await expect(start(fixture, { access: false, requirementsConfirmed: true })).rejects.toThrow(
      "must be protected with Cloudflare Access",
    );
  });

  it("refuses an install job without protection for an app whose entry requires it", async () => {
    const access = protectedWorld();
    const r = await install(
      { catalog: { access: { mode: "required" }, requires: ["access"] } },
      access.world,
      { requirementsConfirmed: true },
      { access: false },
      undefined,
      "self",
      addUser,
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("must be protected with Cloudflare Access");
    expect(r.step.names).not.toContain("upload Worker script");
  });

  it("covers an external domain the form asked for before anything of the app exists", async () => {
    const access = protectedWorld();
    // No gateway here, so the domain step only reports it could not add the
    // domain; the application covered it from the start, then lists exactly
    // the domains the install has.
    const seen: unknown[] = [];
    const r = await install(
      {},
      access.world,
      { access: true },
      { domain: { kind: "external", hostname: "go.customer.net", validation: "http" } },
      undefined,
      "self",
      addUser,
    );
    for (const c of access.cf.calls) {
      if (c.key.endsWith("/access/apps") && c.key.startsWith("POST")) seen.push(c.body);
    }
    expect(r.job?.status).toBe("succeeded");
    expect((seen[0] as { destinations: unknown[] }).destinations).toEqual([
      { type: "public", uri: "cut.appflare-dev.workers.dev" },
      { type: "public", uri: "go.customer.net" },
    ]);
    const [app] = [...access.cf.apps.values()];
    expect(app?.destinations).toEqual([{ type: "worker", worker_id: "tag-cut" }]);
  });
});
