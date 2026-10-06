import type { FetchLike } from "@appflare/cf-api";
import { SANDBOX_CONTAINERS } from "@appflare/schema";
import {
  type ArtifactFixture,
  buildArtifactFixture,
  MANIFEST_URL,
  SIG_URL,
  ZIP_URL,
} from "./artifact-fixture";
import { ACC, type FakeAccount, fakeAccount, SUBDOMAIN, TOKEN } from "./fake-account";

/**
 * Test-only account for enabling and disabling sandbox builds: the Cloudflare
 * calls of the sandbox Worker (upload, workers.dev, versions, delete), its
 * Durable Object namespaces, R2 buckets and objects, container applications
 * and their rollouts, the capability probes, and GitHub's release of the
 * sandbox Worker (public, so no token). Everything about the manager's own
 * Worker ("appflare": its versions, preview check, deployments) is the
 * stateful `fakeAccount`. Container applications turn healthy after
 * `healthyAfter` reads, rollouts complete after `rolloutAfter`.
 */

export const MANAGER = "appflare";
export const MANAGER_SERVING = "11111111-2222-4333-8444-555555555555";
const SANDBOX = "appflare-sandbox";
const RELEASES = "https://api.github.com/repos/appflare/appflare/releases";
/** What `GET /containers/applications` shows for each instance type (recorded live). */
const SIZES: Record<string, Record<string, unknown>> = {
  "standard-1": { vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000, size: "8GB" } },
  "standard-2": { vcpu: 1, memory_mib: 6144, disk: { size_mb: 12000, size: "12GB" } },
};

export interface SandboxWorkerState {
  version: string;
  migrationTag: string | null;
  versionId: string;
  metadata: Record<string, unknown>;
}

export interface FakeContainerApp {
  id: string;
  name: string;
  max_instances: number;
  configuration: { image: string; instance_type: string };
  durable_objects: { namespace_id: string };
  active_rollout_id?: string;
  reads: number;
  created: Record<string, unknown>;
}

export interface SandboxAccountState {
  worker: SandboxWorkerState | null;
  /** Bodies of every sandbox Worker upload, in order. */
  uploads: Array<{ metadata: Record<string, unknown>; modules: string[] }>;
  subdomainCalls: unknown[];
  deletes: Array<{ force: boolean }>;
  namespaces: Record<string, string>;
  buckets: Set<string>;
  objects: Record<string, string[]>;
  apps: FakeContainerApp[];
  rollouts: Record<
    string,
    { appId: string; body: Record<string, unknown>; reads: number; status: string }
  >;
  healthyAfter: number;
  rolloutAfter: number;
  r2Enabled: boolean;
  containersAllowed: boolean;
  /** Uploads whose answer is lost (a 500 after the upload took effect), counted down. */
  lostUploadReplies: number;
  /** Every Cloudflare call this fake answered, `METHOD /path` (the manager's are in `manager.state.calls`). */
  calls: string[];
}

/**
 * The sandbox Worker's Durable Object migrations, as apps/sandbox/wrangler.jsonc
 * declares them: the build classes at v1, the self-deploying classes at v2.
 */
export const SANDBOX_MIGRATIONS = [
  { tag: "v1", new_sqlite_classes: ["Sandbox", "LargeSandbox"] },
  { tag: "v2", new_sqlite_classes: ["SelfDeployingSandbox", "LargeSelfDeployingSandbox"] },
];

/** A signed sandbox Worker release of `version`, shaped like the real one. */
export function sandboxRelease(
  version: string,
  opts: { keyId?: string; tweak?: (m: ArtifactFixture["manifest"]) => void } = {},
): Promise<ArtifactFixture> {
  return buildArtifactFixture({
    version,
    keyId: opts.keyId ?? "appflare-test",
    catalog: { slug: "appflare-sandbox", name: "Appflare sandbox", secrets: [], vars: [] },
    bindings: [
      ...SANDBOX_CONTAINERS.map((c) => ({
        type: "durable_object_namespace",
        name: c.class_name,
        class_name: c.class_name,
      })),
      { type: "r2_bucket", name: "BUILDS" },
      { type: "version_metadata", name: "CF_VERSION_METADATA" },
      { type: "plain_text", name: "APPFLARE_VERSION", text: version },
    ],
    migrations: SANDBOX_MIGRATIONS,
    tweak: (m) => {
      m.app = "appflare-sandbox";
      m.worker.name = "appflare-sandbox";
      m.worker.observability = { enabled: true };
      opts.tweak?.(m);
    },
  });
}

/** GitHub's answer for the release `sandbox@<version>`, with public download URLs. */
function githubSandboxRelease(version: string) {
  return {
    tag_name: `sandbox@${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `appflare-sandbox-${version}.zip`, browser_download_url: ZIP_URL },
      { name: "manifest.json", browser_download_url: MANIFEST_URL },
      { name: "manifest.sig", browser_download_url: SIG_URL },
    ],
  };
}

export function fakeSandboxAccount(
  release: ArtifactFixture,
  over: Partial<SandboxAccountState> = {},
  managerOver: Partial<FakeAccount> = {},
) {
  const state: SandboxAccountState = {
    worker: null,
    uploads: [],
    subdomainCalls: [],
    deletes: [],
    namespaces: {},
    buckets: new Set(),
    objects: {},
    apps: [],
    rollouts: {},
    healthyAfter: 2,
    rolloutAfter: 2,
    r2Enabled: true,
    containersAllowed: true,
    lostUploadReplies: 0,
    calls: [],
    ...over,
  };
  const manager = fakeAccount(release, {
    worker: MANAGER,
    deployments: [{ id: "dep-0", versions: [{ version_id: MANAGER_SERVING, percentage: 100 }] }],
    versionBindings: { [MANAGER_SERVING]: [{ type: "d1", name: "DB", id: "db-1" }] },
    ...managerOver,
  });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });
  const appView = (app: FakeContainerApp) => {
    const ready = app.reads >= state.healthyAfter;
    const n = app.max_instances;
    const { reads: _reads, created: _created, configuration, ...rest } = app;
    // Cloudflare answers with the size an instance type expands to, not the type.
    const { instance_type, ...runs } = configuration;
    const size = SIZES[instance_type] ?? {};
    return {
      ...rest,
      configuration: { ...runs, ...size },
      health: { instances: { healthy: ready ? n : 0, starting: ready ? 0 : n, scheduling: 0 } },
    };
  };
  const sandboxBindings = () =>
    ((state.worker?.metadata.bindings as Array<Record<string, unknown>> | undefined) ?? []).map(
      (b) =>
        b.type === "durable_object_namespace"
          ? { ...b, namespace_id: state.namespaces[String(b.class_name)] }
          : b,
    );

  async function cloudflare(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(403, 10000, "auth");

    if (key === "GET /workers/scripts") {
      state.calls.push(key);
      const listed = (await (
        await manager.fetch(request.url, { headers: request.headers })
      ).json()) as {
        result: Array<Record<string, unknown>>;
      };
      const scripts = [...listed.result];
      if (state.worker !== null) {
        scripts.push({
          id: SANDBOX,
          ...(state.worker.migrationTag === null
            ? {}
            : { migration_tag: state.worker.migrationTag }),
        });
      }
      return ok(scripts, { result_info: { page: 1, total_pages: 1 } });
    }
    const sandboxRoute = path.startsWith(`/workers/scripts/${SANDBOX}`);
    const mine =
      sandboxRoute ||
      path.startsWith("/r2/") ||
      path.startsWith("/containers/") ||
      path === "/workers/durable_objects/namespaces";
    if (!mine) return null;
    state.calls.push(key);

    if (path.startsWith("/r2/") && !state.r2Enabled) {
      return fail(403, 10042, "Please enable R2 through the Cloudflare Dashboard.");
    }
    if (path.startsWith("/containers/") && !state.containersAllowed) {
      return fail(403, 10000, "Authentication error");
    }

    switch (key) {
      case `PUT /workers/scripts/${SANDBOX}`: {
        const form = await request.formData();
        const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
        const migrations = metadata.migrations as
          | { old_tag?: string; new_tag: string; steps: unknown[] }
          | undefined;
        const current = state.worker?.migrationTag ?? null;
        if (migrations !== undefined && (migrations.old_tag ?? null) !== current) {
          return fail(400, 10079, "migration tag precondition failed");
        }
        if (migrations === undefined && current === null) {
          return fail(400, 10074, "Durable Object classes need a migration");
        }
        for (const c of SANDBOX_CONTAINERS) {
          state.namespaces[c.class_name] ??= `ns-${c.class_name.toLowerCase()}`;
        }
        const n = state.uploads.length + 1;
        const versionId = `5b000000-0000-4000-8000-00000000000${n}`;
        const version = (
          (metadata.bindings as Array<{ name: string; text?: string }>).find(
            (b) => b.name === "APPFLARE_VERSION",
          ) ?? { text: "?" }
        ).text as string;
        state.uploads.push({ metadata, modules: [...form.keys()].filter((k) => k !== "metadata") });
        state.worker = {
          version,
          versionId,
          metadata,
          migrationTag: migrations?.new_tag ?? current,
        };
        if (state.lostUploadReplies > 0) {
          state.lostUploadReplies -= 1;
          return fail(500, 10013, "internal error");
        }
        return ok({ id: SANDBOX, deployment_id: versionId });
      }
      case `DELETE /workers/scripts/${SANDBOX}`: {
        const force = url.searchParams.get("force") === "true";
        state.deletes.push({ force });
        if (state.worker === null) return fail(404, 10007, "This Worker does not exist");
        if (!force) {
          return fail(400, 10142, "still referenced by service bindings in Workers 'appflare'");
        }
        state.worker = null;
        state.namespaces = {};
        return ok(null);
      }
      case `GET /workers/scripts/${SANDBOX}/bindings`:
        return state.worker === null ? fail(404, 10007, "no such Worker") : ok(sandboxBindings());
      case `POST /workers/scripts/${SANDBOX}/subdomain`:
        state.subdomainCalls.push(await request.json());
        return ok({ enabled: false, previews_enabled: false });
      case `GET /workers/scripts/${SANDBOX}/deployments`:
        return state.worker === null
          ? fail(404, 10007, "no such Worker")
          : ok({
              deployments: [
                { id: "sd", versions: [{ version_id: state.worker.versionId, percentage: 100 }] },
              ],
            });
      case "GET /workers/durable_objects/namespaces":
        return ok(
          Object.entries(state.namespaces).map(([cls, id]) => ({
            id,
            script: SANDBOX,
            class: cls,
          })),
          { result_info: { page: 1, total_pages: 1 } },
        );
      case "GET /r2/buckets": {
        const contains = url.searchParams.get("name_contains") ?? "";
        const buckets = [...state.buckets].filter((b) => b.includes(contains));
        return ok({ buckets: buckets.map((name) => ({ name })) });
      }
      case "POST /r2/buckets": {
        const { name } = (await request.json()) as { name: string };
        if (state.buckets.has(name)) return fail(409, 10004, "bucket already exists");
        state.buckets.add(name);
        return ok({ name });
      }
      case "GET /containers/applications": {
        const name = url.searchParams.get("name");
        return ok(state.apps.filter((a) => name === null || a.name === name).map(appView));
      }
      case "POST /containers/applications": {
        const body = (await request.json()) as Record<string, unknown> & {
          name: string;
          max_instances: number;
          configuration: FakeContainerApp["configuration"];
          durable_objects: { namespace_id: string };
        };
        const app: FakeContainerApp = {
          id: `app-${state.apps.length + 1}`,
          name: body.name,
          max_instances: body.max_instances,
          configuration: body.configuration,
          durable_objects: body.durable_objects,
          reads: 0,
          created: body,
        };
        state.apps.push(app);
        return ok(appView(app), {});
      }
    }

    const version = new RegExp(`^GET /workers/scripts/${SANDBOX}/versions/([^/]+)$`).exec(key);
    if (version !== null) {
      return state.worker?.versionId === version[1]
        ? ok({ id: version[1], resources: { bindings: sandboxBindings() } })
        : fail(404, 10007, "version not found");
    }
    const objects = /^(GET|DELETE) \/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/.exec(key);
    if (objects !== null) {
      const bucket = objects[2] as string;
      if (!state.buckets.has(bucket)) return fail(404, 10006, "no such bucket");
      state.objects[bucket] ??= [];
      const list = state.objects[bucket];
      if (objects[1] === "GET") {
        const perPage = Number(url.searchParams.get("per_page") ?? "1000");
        const page = list.slice(0, perPage);
        return ok(
          page.map((k) => ({ key: k })),
          { result_info: { cursor: list.length > perPage ? "more" : "" } },
        );
      }
      const at = list.indexOf(decodeURIComponent(objects[3] ?? ""));
      if (at !== -1) list.splice(at, 1);
      return ok(null);
    }
    const bucket = /^DELETE \/r2\/buckets\/([^/]+)$/.exec(key);
    if (bucket !== null) {
      const name = bucket[1] as string;
      if (!state.buckets.has(name)) return fail(404, 10006, "no such bucket");
      if ((state.objects[name] ?? []).length > 0) return fail(409, 10008, "bucket is not empty");
      state.buckets.delete(name);
      return ok(null);
    }
    const rollout = /^(POST|GET) \/containers\/applications\/([^/]+)\/rollouts(?:\/([^/]+))?$/.exec(
      key,
    );
    if (rollout !== null) {
      const app = state.apps.find((a) => a.id === rollout[2]);
      if (app === undefined) return fail(404, 1000, "application not found");
      if (rollout[1] === "POST") {
        const id = `rollout-${Object.keys(state.rollouts).length + 1}`;
        state.rollouts[id] = {
          appId: app.id,
          body: (await request.json()) as Record<string, unknown>,
          reads: 0,
          status: "progressing",
        };
        app.active_rollout_id = id;
        return ok({ id, status: "progressing" });
      }
      const found = state.rollouts[rollout[3] ?? ""];
      if (found === undefined) return fail(404, 1000, "rollout not found");
      found.reads += 1;
      if (found.reads >= state.rolloutAfter && found.status === "progressing") {
        found.status = "completed";
        app.configuration = found.body.target_configuration as FakeContainerApp["configuration"];
        delete app.active_rollout_id;
      }
      return ok({
        id: rollout[3],
        status: found.status,
        target_configuration: found.body.target_configuration,
      });
    }
    const one = /^(GET|PATCH|DELETE) \/containers\/applications\/([^/]+)$/.exec(key);
    if (one !== null) {
      const at = state.apps.findIndex((a) => a.id === one[2]);
      const app = state.apps[at];
      if (app === undefined) return fail(404, 1000, "application not found");
      if (one[1] === "DELETE") {
        state.apps.splice(at, 1);
        return ok(null);
      }
      if (one[1] === "PATCH") {
        const body = (await request.json()) as { max_instances?: number };
        // A patch alone never changes what running instances run.
        if (body.max_instances !== undefined) app.max_instances = body.max_instances;
        return ok(appView(app));
      }
      app.reads += 1;
      return ok(appView(app));
    }
    return fail(404, 7003, `no route ${key}`);
  }

  /** Every github.com download request, in the order made. */
  const githubDownloads: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "api.github.com") {
      const tag = /^\/repos\/appflare\/appflare\/releases\/tags\/(.+)$/.exec(url.pathname);
      const wanted = tag === null ? null : decodeURIComponent(tag[1] as string);
      if (
        `${url.origin}${url.pathname}`.startsWith(RELEASES) &&
        wanted === `sandbox@${release.manifest.version}`
      ) {
        return Response.json(githubSandboxRelease(release.manifest.version));
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    // The public download URLs of the same release (read without a token).
    if (url.hostname === "github.com") {
      const download = /^\/appflare\/appflare\/releases\/download\/([^/]+)\/([^/]+)$/.exec(
        url.pathname,
      );
      const version = release.manifest.version;
      const files: Record<string, string> = {
        [`appflare-sandbox-${version}.zip`]: ZIP_URL,
        "manifest.json": MANIFEST_URL,
        "manifest.sig": SIG_URL,
      };
      const file =
        download !== null && decodeURIComponent(download[1] as string) === `sandbox@${version}`
          ? files[decodeURIComponent(download[2] as string)]
          : undefined;
      githubDownloads.push(`${url.origin}${url.pathname}`);
      return (
        (file === undefined ? null : release.serve(file, init)) ??
        new Response("Not Found", { status: 404 })
      );
    }
    if (input.startsWith("https://api.cloudflare.com/")) {
      const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
      order.push(`${init?.method ?? "GET"} ${path}`);
      const answered = await cloudflare(new Request(input, init));
      if (answered !== null) return answered;
    }
    return manager.fetch(input, init);
  };

  /** Every Cloudflare call, the manager's and the sandbox's, in the order made. */
  const order: string[] = [];
  return { state, manager, fetch, order, githubDownloads, subdomain: SUBDOMAIN };
}
