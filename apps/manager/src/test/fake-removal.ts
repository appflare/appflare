import type { FetchLike } from "@appflare/cf-api";
import { ACC, TOKEN } from "./fake-account";

/**
 * Test-only stateful fake of every Cloudflare call the danger zone makes
 * (the auth secret write, and removing Appflare):
 * the account, Worker bindings, the build bucket and its objects, the
 * gateway's zone pieces, Access applications, and the deletes. What a
 * delete removes answers 404 afterwards, so a second run sees it gone.
 * `fail` makes one call answer an error; `calls` records `METHOD path` in
 * order, the path without `/client/v4` and with `/accounts/<id>` as `/a`.
 */

export const ACCOUNT_NAME = "Ada's Account";
export const MANAGER_WORKER = "appflare";
export const MANAGER_WORKFLOW = "appflare-jobs";
export const GATEWAY_ZONE_ID = "z-gw";
export const GATEWAY_ZONE_NAME = "gateway.example";

export interface FakeRemovalOptions {
  objects?: number;
  /** `METHOD path` -> status and code to answer instead. */
  fail?: Record<string, { status: number; code: number; message?: string }>;
  sandbox?: boolean;
  bucket?: boolean;
  /**
   * The sandbox Worker's container applications: listed (default), absent,
   * or refused to the token (403, no Containers group).
   */
  containers?: "present" | "none" | "denied";
  /** A 400 on the gateway record's delete this many times. */
  recordBusy?: number;
}

export function fakeRemovalAccount(options: FakeRemovalOptions = {}) {
  const calls: string[] = [];
  const gone = new Set<string>();
  let objects = Array.from({ length: options.objects ?? 0 }, (_, i) => `builds/b${i}.zip`);
  let recordBusy = options.recordBusy ?? 0;
  const fail = { ...options.fail };
  const sandbox = options.sandbox ?? true;
  const bucket = options.bucket ?? true;

  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const error = (status: number, code: number, message = "error") =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });

  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "").replace(`/accounts/${ACC}`, "/a");
    const key = `${request.method} ${path}`;
    calls.push(key);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return error(403, 10000, "auth");
    }
    const failure = fail[key];
    if (failure !== undefined) return error(failure.status, failure.code, failure.message);
    if (gone.has(path)) return error(404, 10007, "not found");

    if (key === "GET /a") return ok({ id: ACC, name: ACCOUNT_NAME, type: "standard" });
    if (key === `PUT /a/workers/scripts/${MANAGER_WORKER}/secrets`) {
      return ok({ name: "BETTER_AUTH_SECRET", type: "secret_text" });
    }
    if (key === `GET /a/workers/scripts/${MANAGER_WORKER}/bindings`) {
      return ok([
        { type: "d1", name: "DB", id: "d1-manager" },
        { type: "kv_namespace", name: "KV", namespace_id: "kv-manager" },
        {
          type: "workflow",
          name: "JOBS",
          workflow_name: MANAGER_WORKFLOW,
          class_name: "JobWorkflow",
        },
        { type: "service", name: "SELF", service: MANAGER_WORKER },
      ]);
    }
    if (key === "GET /a/workers/scripts/appflare-sandbox/bindings") {
      if (!sandbox) return error(404, 10007, "workers.api.error.script_not_found");
      return ok([
        { type: "durable_object_namespace", name: "Sandbox", class_name: "Sandbox" },
        { type: "r2_bucket", name: "BUILDS", bucket_name: "appflare-builds" },
        { type: "secret_text", name: "APP_TOKEN_01ABC" },
        { type: "plain_text", name: "APPFLARE_VERSION", text: "0.1.0" },
      ]);
    }
    if (key === "GET /a/containers/applications") {
      const containers = options.containers ?? "present";
      if (containers === "denied") return error(403, 10000, "Authentication error");
      const name = url.searchParams.get("name") ?? "";
      const id = `app-${name.split("-").at(-1)}`;
      const listed = containers === "present" && !gone.has(`/a/containers/applications/${id}`);
      return ok(listed ? [{ id, name }] : []);
    }
    if (key === "GET /a/r2/buckets") {
      return ok({
        buckets:
          bucket && !gone.has("/a/r2/buckets/appflare-builds") ? [{ name: "appflare-builds" }] : [],
      });
    }
    if (key === "GET /a/r2/buckets/appflare-builds/objects") {
      const perPage = Number(url.searchParams.get("per_page") ?? "1000");
      const page = objects.slice(0, perPage).map((k) => ({ key: k, size: 1 }));
      return ok(page, {
        result_info: objects.length > perPage ? { cursor: "next" } : {},
      });
    }
    const object = /^DELETE \/a\/r2\/buckets\/appflare-builds\/objects\/(.+)$/.exec(key);
    if (object?.[1] !== undefined) {
      const name = decodeURIComponent(object[1]);
      objects = objects.filter((k) => k !== name);
      return ok({});
    }
    if (key === "DELETE /a/r2/buckets/appflare-builds" && objects.length > 0) {
      return error(409, 10008, "The bucket you tried to delete is not empty");
    }
    if (key === `GET /zones/${GATEWAY_ZONE_ID}/custom_hostnames/fallback_origin`) {
      if (gone.has(`/zones/${GATEWAY_ZONE_ID}/custom_hostnames/fallback_origin`)) {
        return error(404, 1551, "No fallback origin");
      }
      return ok({ origin: `appflare-gateway.${GATEWAY_ZONE_NAME}`, status: "active" });
    }
    if (key === `DELETE /zones/${GATEWAY_ZONE_ID}/dns_records/rec-1` && recordBusy > 0) {
      recordBusy -= 1;
      return error(400, 1004, "The record is in use by the fallback origin");
    }
    if (request.method === "DELETE") {
      gone.add(path);
      return ok({ id: path.split("/").at(-1) });
    }
    return error(404, 7003, "No route for that URI");
  };

  return {
    fetch,
    calls,
    /** DELETE calls, in order. */
    deletes: () => calls.filter((c) => c.startsWith("DELETE ")),
    remainingObjects: () => objects.length,
    /** Stops failing `key` (as after the admin fixed the cause). */
    heal: (key: string) => {
      delete fail[key];
    },
  };
}
