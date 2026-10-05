import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";
import { ACCESS_SERVICE_TOKEN_IN_USE, isServiceTokenInUse } from "./namespaces/access";
import { isAddressableObjectKey } from "./namespaces/r2";
import {
  isWorkflowCronPaidOnly,
  isWorkflowNotFound,
  WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE,
  WORKFLOW_NOT_FOUND_CODE,
} from "./namespaces/workflows";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const BASE = "https://api.cloudflare.com/client/v4";
const A = `${BASE}/accounts/${ACCOUNT}`;

function make(spec?: FakeResponseSpec) {
  const fake = makeFakeFetch(spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

describe("tokens", () => {
  it("verify -> GET /accounts/{id}/tokens/verify", async () => {
    const { fake, client } = make({ result: { id: "t1", status: "active" } });
    await client.tokens.verify();
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/tokens/verify`);
    expect(fake.last().authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("verifyUserToken -> GET /user/tokens/verify", async () => {
    const { fake, client } = make({ result: { id: "t1", status: "active" } });
    await client.tokens.verifyUserToken();
    expect(fake.last().url).toBe(`${BASE}/user/tokens/verify`);
  });
});

describe("accounts", () => {
  it("get -> GET /accounts/{id}", async () => {
    const { fake, client } = make({ result: { id: ACCOUNT, name: "Example Account" } });
    expect(await client.accounts.get()).toEqual({ id: ACCOUNT, name: "Example Account" });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(A);
  });
});

describe("workers", () => {
  it("listScripts -> GET /workers/scripts (paginated)", async () => {
    const { fake, client } = make({ result: [{ id: "s1" }] });
    const scripts = await client.workers.listScripts();
    expect(scripts).toEqual([{ id: "s1" }]);
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url.split("?")[0]).toBe(`${A}/workers/scripts`);
    expect(fake.last().query.get("page")).toBe("1");
  });

  it("uploadScript -> PUT multipart with metadata + typed module parts", async () => {
    const { fake, client } = make({ result: { id: "hello" } });
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [{ type: "kv_namespace", name: "KV", namespace_id: "n1" }],
      observability: { enabled: true },
    };
    await client.workers.uploadScript("hello", {
      metadata,
      modules: [
        { name: "index.js", content: "export default {};", type: "esm" },
        { name: "mod.wasm", content: new Uint8Array([0, 97, 115, 109]), type: "compiled-wasm" },
      ],
    });

    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/workers/scripts/hello`);
    const form = await req.request.formData();
    expect(JSON.parse(form.get("metadata") as string)).toEqual(metadata);

    const index = form.get("index.js") as File;
    expect(index).toBeInstanceOf(File);
    expect(index.name).toBe("index.js");
    expect(index.type).toBe("application/javascript+module");
    expect(await index.text()).toBe("export default {};");

    const wasm = form.get("mod.wasm") as File;
    expect(wasm.type).toBe("application/wasm");
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
  });

  it("uploadScript excludeScript -> PUT ?excludeScript=true, returns deployment_id", async () => {
    const { fake, client } = make({ result: { id: "hello", deployment_id: "abc" } });
    const res = await client.workers.uploadScript("hello", {
      metadata: { main_module: "index.js" },
      modules: [{ name: "index.js", content: "export default {};" }],
      excludeScript: true,
    });
    expect(res.deployment_id).toBe("abc");
    expect(fake.last().query.get("excludeScript")).toBe("true");
  });

  it("deleteScript force -> DELETE ?force=true", async () => {
    const { fake, client } = make();
    await client.workers.deleteScript("hello", { force: true });
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url.split("?")[0]).toBe(`${A}/workers/scripts/hello`);
    expect(fake.last().query.get("force")).toBe("true");
  });

  it("deleteScript without force -> no query", async () => {
    const { fake, client } = make();
    await client.workers.deleteScript("hello");
    expect([...fake.last().query.keys()]).toEqual([]);
  });

  it("getSettings -> GET /settings", async () => {
    const { fake, client } = make({ result: { logpush: false } });
    await client.workers.getSettings("hello");
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/settings`);
  });

  it("patchSettings -> PATCH multipart with a settings JSON part", async () => {
    const { fake, client } = make({ result: {} });
    await client.workers.patchSettings("hello", { observability: { enabled: true } });
    const req = fake.last();
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe(`${A}/workers/scripts/hello/settings`);
    const form = await req.request.formData();
    expect(JSON.parse(form.get("settings") as string)).toEqual({
      observability: { enabled: true },
    });
  });

  it("getBindings -> GET /bindings", async () => {
    const { fake, client } = make({ result: [] });
    await client.workers.getBindings("hello");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/bindings`);
  });

  it("enableSubdomain -> POST { enabled, previews_enabled }", async () => {
    const { fake, client } = make({ result: { enabled: true, previews_enabled: true } });
    await client.workers.enableSubdomain("hello", { enabled: true, previews_enabled: true });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/workers/scripts/hello/subdomain`);
    expect(await req.request.json()).toEqual({ enabled: true, previews_enabled: true });
  });

  it("getSubdomain -> GET /subdomain", async () => {
    const { fake, client } = make({ result: { enabled: true, previews_enabled: false } });
    expect(await client.workers.getSubdomain("hello")).toEqual({
      enabled: true,
      previews_enabled: false,
    });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/subdomain`);
  });

  it("getSchedules -> GET /schedules", async () => {
    const { fake, client } = make({ result: { schedules: [] } });
    await client.workers.getSchedules("hello");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/schedules`);
  });

  it("putSchedules -> PUT with an array body", async () => {
    const { fake, client } = make({ result: { schedules: [] } });
    await client.workers.putSchedules("hello", [{ cron: "*/30 * * * *" }]);
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(await req.request.json()).toEqual([{ cron: "*/30 * * * *" }]);
  });

  it("listSecrets -> GET /secrets", async () => {
    const { fake, client } = make({ result: [{ name: "S", type: "secret_text" }] });
    await client.workers.listSecrets("hello");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/secrets`);
  });

  it("putSecret -> PUT { name, text, type: secret_text }", async () => {
    const { fake, client } = make({ result: { name: "S", type: "secret_text" } });
    await client.workers.putSecret("hello", { name: "S", text: "shh" });
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/workers/scripts/hello/secrets`);
    expect(await req.request.json()).toEqual({ name: "S", text: "shh", type: "secret_text" });
  });

  it("deleteSecret -> DELETE /secrets/{name}", async () => {
    const { fake, client } = make();
    await client.workers.deleteSecret("hello", "MY_SECRET");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/secrets/MY_SECRET`);
  });

  it("getAccountSubdomain -> GET /workers/subdomain", async () => {
    const { fake, client } = make({ result: { subdomain: "acme" } });
    const res = await client.workers.getAccountSubdomain();
    expect(res).toEqual({ subdomain: "acme" });
    expect(fake.last().url).toBe(`${A}/workers/subdomain`);
  });
});

describe("versions", () => {
  it("uploadVersion -> POST multipart with metadata (annotations) + modules", async () => {
    const { fake, client } = make({ result: { id: "v1" } });
    const metadata = {
      main_module: "index.js",
      keep_bindings: ["secret_text"],
      annotations: { "workers/message": "update" },
    };
    await client.versions.uploadVersion("hello", {
      metadata,
      modules: [{ name: "index.js", content: "export default {};" }],
    });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/workers/scripts/hello/versions`);
    const form = await req.request.formData();
    expect(JSON.parse(form.get("metadata") as string)).toEqual(metadata);
    expect((form.get("index.js") as File).type).toBe("application/javascript+module");
  });

  it("listVersions -> GET, returns result.items", async () => {
    const { fake, client } = make({ result: { items: [{ id: "v1" }, { id: "v2" }] } });
    const versions = await client.versions.listVersions("hello");
    expect(versions.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/versions`);
  });

  it("patchLatestVersion -> PATCH /workers/workers/{name}/versions/latest as a merge patch", async () => {
    const { fake, client } = make({
      result: { id: "v9", urls: ["https://v9-hello.x.workers.dev"] },
    });
    const patch = {
      env: {
        SANDBOX: { type: "service", service: "appflare-sandbox", entrypoint: "SandboxBuilds" },
      },
      annotations: { "workers/message": "connect" },
    };
    const version = await client.versions.patchLatestVersion("hello", patch);
    expect(version.id).toBe("v9");
    const req = fake.last();
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe(`${A}/workers/workers/hello/versions/latest`);
    expect(req.headers.get("content-type")).toBe("application/merge-patch+json");
    expect(await req.request.json()).toEqual(patch);
  });

  it("listVersions deployable -> ?deployable=true", async () => {
    const { fake, client } = make({ result: { items: [] } });
    await client.versions.listVersions("hello", { deployable: true });
    expect(fake.last().query.get("deployable")).toBe("true");
  });

  it("getVersion -> GET /versions/{id}", async () => {
    const { fake, client } = make({ result: { id: "v1" } });
    await client.versions.getVersion("hello", "v1");
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/versions/v1`);
  });

  it("listDeployments -> GET, returns result.deployments", async () => {
    const { fake, client } = make({ result: { deployments: [{ id: "d1" }] } });
    const deployments = await client.versions.listDeployments("hello");
    expect(deployments.map((d) => d.id)).toEqual(["d1"]);
    expect(fake.last().url).toBe(`${A}/workers/scripts/hello/deployments`);
  });

  it("createDeployment -> POST { strategy: percentage, versions }", async () => {
    const { fake, client } = make({ result: { id: "d1" } });
    await client.versions.createDeployment("hello", {
      versions: [{ version_id: "v1", percentage: 100 }],
      annotations: { "workers/message": "promote" },
    });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/workers/scripts/hello/deployments`);
    expect(await req.request.json()).toEqual({
      strategy: "percentage",
      versions: [{ version_id: "v1", percentage: 100 }],
      annotations: { "workers/message": "promote" },
    });
  });

  it("createDeployment force -> ?force=true", async () => {
    const { fake, client } = make({ result: { id: "d1" } });
    await client.versions.createDeployment("hello", {
      versions: [{ version_id: "v1", percentage: 100 }],
      force: true,
    });
    expect(fake.last().query.get("force")).toBe("true");
  });
});

describe("assets", () => {
  it("createUploadSession -> POST { manifest }, returns { jwt, buckets }", async () => {
    const { fake, client } = make({ result: { jwt: "sess", buckets: [["h1"]] } });
    const manifest = { "/index.html": { hash: "h1", size: 10 } };
    const session = await client.assets.createUploadSession("hello", manifest);
    expect(session).toEqual({ jwt: "sess", buckets: [["h1"]] });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/workers/scripts/hello/assets-upload-session`);
    expect(await req.request.json()).toEqual({ manifest });
  });

  it("uploadBucket -> POST ?base64=true, bearer = session JWT (not the account token)", async () => {
    const { fake, client } = make({ result: { jwt: "completion" } });
    const res = await client.assets.uploadBucket("session-jwt-xyz", [
      { hash: "abc123", base64: "aGk=", contentType: "text/html" },
      { hash: "def456", base64: "Ynll" },
    ]);
    expect(res).toEqual({ jwt: "completion" });

    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url.split("?")[0]).toBe(`${A}/workers/assets/upload`);
    expect(req.query.get("base64")).toBe("true");
    expect(req.authorization).toBe("Bearer session-jwt-xyz");
    expect(req.authorization).not.toContain(TOKEN);

    const form = await req.request.formData();
    const first = form.get("abc123") as File;
    expect(first.name).toBe("abc123");
    expect(first.type).toBe("text/html");
    expect(await first.text()).toBe("aGk=");
    expect((form.get("def456") as File).type).toBe("application/null");
  });

  it("uploadFile -> POST /workers/assets/upload/{hash}, raw body, bearer = session JWT", async () => {
    const { fake, client } = make({ result: { jwt: "completion" } });
    const res = await client.assets.uploadFile("session-jwt-xyz", {
      hash: "abc123",
      body: new Uint8Array([104, 105]),
      contentType: "text/css; charset=utf-8",
    });
    expect(res).toEqual({ jwt: "completion" });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/workers/assets/upload/abc123`);
    expect(req.authorization).toBe("Bearer session-jwt-xyz");
    expect(req.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await req.request.text()).toBe("hi");
  });
});

describe("kv", () => {
  it("createNamespace -> POST { title }", async () => {
    const { fake, client } = make({ result: { id: "n1", title: "hello-kv" } });
    await client.kv.createNamespace("hello-kv");
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/storage/kv/namespaces`);
    expect(await req.request.json()).toEqual({ title: "hello-kv" });
  });

  it("listKeys -> GET /namespaces/{id}/keys?limit=, returns one page and its cursor", async () => {
    const { fake, client } = make({
      result: [{ name: "a" }, { name: "b" }],
      result_info: { count: 2, cursor: "next" },
    });
    expect(await client.kv.listKeys("n1", { limit: 1000 })).toEqual({
      items: [{ name: "a" }, { name: "b" }],
      cursor: "next",
    });
    expect(fake.last().path).toBe(`/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/n1/keys`);
    expect(fake.last().query.get("limit")).toBe("1000");
    expect(fake.last().query.get("cursor")).toBeNull();
  });

  it("listKeys -> an empty cursor means the last page", async () => {
    const { client } = make({ result: [], result_info: { count: 0, cursor: "" } });
    expect(await client.kv.listKeys("n1")).toEqual({ items: [], cursor: null });
  });

  it("deleteNamespace -> DELETE /namespaces/{id}", async () => {
    const { fake, client } = make();
    await client.kv.deleteNamespace("n1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/storage/kv/namespaces/n1`);
  });
});

describe("d1", () => {
  it("createDatabase -> POST { name }", async () => {
    const { fake, client } = make({ result: { uuid: "u1", name: "db" } });
    await client.d1.createDatabase("db");
    expect(await fake.last().request.json()).toEqual({ name: "db" });
    expect(fake.last().url).toBe(`${A}/d1/database`);
  });

  it("listDatabases -> GET (paginated)", async () => {
    const { fake, client } = make({ result: [{ uuid: "u1", name: "db" }] });
    await client.d1.listDatabases();
    expect(fake.last().url.split("?")[0]).toBe(`${A}/d1/database`);
    expect(fake.last().query.get("page")).toBe("1");
  });

  it("getDatabase / deleteDatabase -> /d1/database/{uuid}", async () => {
    const del = make();
    await del.client.d1.deleteDatabase("u1");
    expect(del.fake.last().method).toBe("DELETE");
    expect(del.fake.last().url).toBe(`${A}/d1/database/u1`);

    const get = make({ result: { uuid: "u1", name: "db" } });
    await get.client.d1.getDatabase("u1");
    expect(get.fake.last().method).toBe("GET");
    expect(get.fake.last().url).toBe(`${A}/d1/database/u1`);
  });

  it("query -> POST { sql, params }, returns the results array", async () => {
    const { fake, client } = make({
      result: [{ results: [{ n: 1 }], success: true, meta: {} }],
    });
    const rows = await client.d1.query("u1", "SELECT ?", [1]);
    expect(rows[0]?.results).toEqual([{ n: 1 }]);
    const req = fake.last();
    expect(req.url).toBe(`${A}/d1/database/u1/query`);
    expect(await req.request.json()).toEqual({ sql: "SELECT ?", params: [1] });
  });

  it("query without params -> body omits params", async () => {
    const { fake, client } = make({ result: [] });
    await client.d1.query("u1", "SELECT 1");
    expect(await fake.last().request.json()).toEqual({ sql: "SELECT 1" });
  });

  it("bookmark -> GET /time_travel/bookmark, optional timestamp query", async () => {
    const plain = make({ result: { bookmark: "bm" } });
    await plain.client.d1.bookmark("u1");
    expect(plain.fake.last().method).toBe("GET");
    expect(plain.fake.last().url).toBe(`${A}/d1/database/u1/time_travel/bookmark`);
    expect([...plain.fake.last().query.keys()]).toEqual([]);

    const stamped = make({ result: { bookmark: "bm" } });
    await stamped.client.d1.bookmark("u1", { timestamp: "2026-01-01T00:00:00Z" });
    expect(stamped.fake.last().query.get("timestamp")).toBe("2026-01-01T00:00:00Z");
  });

  it("restore by bookmark -> single POST /time_travel/restore?bookmark", async () => {
    const { fake, client } = make({ result: { bookmark: "bm", previous_bookmark: "prev" } });
    const res = await client.d1.restore("u1", { bookmark: "explicit-bm" });
    expect(res).toEqual({ bookmark: "bm", previous_bookmark: "prev" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url.split("?")[0]).toBe(`${A}/d1/database/u1/time_travel/restore`);
    expect(fake.last().query.get("bookmark")).toBe("explicit-bm");
  });

  it("restore by timestamp -> resolves the bookmark first, then restores", async () => {
    const fake = makeFakeFetch((req) =>
      req.path.endsWith("/time_travel/bookmark")
        ? { result: { bookmark: "bm-from-ts" } }
        : { result: { bookmark: "bm-from-ts", previous_bookmark: "prev" } },
    );
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
    await client.d1.restore("u1", { timestamp: "2026-01-01T00:00:00Z" });

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.method).toBe("GET");
    expect(fake.calls[0]?.query.get("timestamp")).toBe("2026-01-01T00:00:00Z");
    expect(fake.calls[1]?.method).toBe("POST");
    expect(fake.calls[1]?.query.get("bookmark")).toBe("bm-from-ts");
  });
});

describe("r2 / queues / vectorize", () => {
  it("r2.createBucket -> POST { name, ... }", async () => {
    const { fake, client } = make({ result: { name: "b" } });
    await client.r2.createBucket({ name: "b", locationHint: "weur" });
    const req = fake.last();
    expect(req.url).toBe(`${A}/r2/buckets`);
    expect(await req.request.json()).toEqual({ name: "b", locationHint: "weur" });
  });

  it("r2.deleteBucket -> DELETE /r2/buckets/{name}", async () => {
    const { fake, client } = make();
    await client.r2.deleteBucket("b");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/r2/buckets/b`);
  });

  it("r2.listObjects -> GET /r2/buckets/{name}/objects?per_page=&cursor=, one page", async () => {
    const { fake, client } = make({
      result: [{ key: "a.txt", size: 1 }],
      result_info: { cursor: "c2", per_page: 30 },
    });
    expect(await client.r2.listObjects("b", { perPage: 30, cursor: "c1" })).toEqual({
      items: [{ key: "a.txt", size: 1 }],
      cursor: "c2",
    });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().path).toBe(`/client/v4/accounts/${ACCOUNT}/r2/buckets/b/objects`);
    expect(fake.last().query.get("per_page")).toBe("30");
    expect(fake.last().query.get("cursor")).toBe("c1");
  });

  it("r2.listObjects -> no cursor on the last page", async () => {
    const { client } = make({ result: [] });
    expect(await client.r2.listObjects("b")).toEqual({ items: [], cursor: null });
  });

  it("r2.deleteObject -> DELETE /objects/{key}, each key segment encoded, slashes kept", async () => {
    const { fake, client } = make();
    await client.r2.deleteObject("b", "a b.jpg");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/r2/buckets/b/objects/a%20b.jpg`);
    await client.r2.deleteObject("b", "photos/2026/a b?#%.jpg");
    expect(fake.last().url).toBe(`${A}/r2/buckets/b/objects/photos/2026/a%20b%3F%23%25.jpg`);
  });

  it("r2.deleteObject -> refuses a key with a dot segment instead of deleting another object", async () => {
    const { fake, client } = make();
    expect(() => client.r2.deleteObject("b", "a/../b")).toThrow(RangeError);
    expect(fake.calls).toHaveLength(0);
    expect(isAddressableObjectKey("x/.hidden/..y/%2E%2E")).toBe(true);
    for (const key of [".", "a/..", "./a", "a/../b"]) {
      expect(isAddressableObjectKey(key)).toBe(false);
    }
  });

  it("queues.createQueue -> POST { queue_name }", async () => {
    const { fake, client } = make({ result: { queue_id: "q1", queue_name: "q" } });
    await client.queues.createQueue("q");
    expect(fake.last().url).toBe(`${A}/queues`);
    expect(await fake.last().request.json()).toEqual({ queue_name: "q" });
  });

  it("r2.listBuckets -> GET /r2/buckets?name_contains=, follows the cursor", async () => {
    const pages = [
      { result: { buckets: [{ name: "a-1" }] }, result_info: { cursor: "c2", per_page: 1000 } },
      { result: { buckets: [{ name: "a-2" }] }, result_info: { cursor: "", per_page: 1000 } },
    ];
    const paged = makeFakeFetch((_req, i) => pages[i]);
    const c = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: paged.fetch });
    expect(await c.r2.listBuckets({ nameContains: "a-" })).toEqual([
      { name: "a-1" },
      { name: "a-2" },
    ]);
    expect(paged.calls).toHaveLength(2);
    expect(paged.calls[0]?.path).toBe(`/client/v4/accounts/${ACCOUNT}/r2/buckets`);
    expect(paged.calls[0]?.query.get("name_contains")).toBe("a-");
    expect(paged.calls[0]?.query.get("cursor")).toBeNull();
    expect(paged.calls[1]?.query.get("cursor")).toBe("c2");
  });

  it("queues.listQueues -> GET /queues", async () => {
    const { fake, client } = make({ result: [{ queue_id: "q1", queue_name: "jobs" }] });
    expect(await client.queues.listQueues()).toEqual([{ queue_id: "q1", queue_name: "jobs" }]);
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/queues`);
  });

  it("queues.createConsumer -> POST /queues/{id}/consumers with a Worker consumer body", async () => {
    const { fake, client } = make({
      result: { consumer_id: "c1", queue_name: "jobs", script_name: "app", type: "worker" },
    });
    const body = {
      type: "worker" as const,
      script_name: "app",
      dead_letter_queue: "app-dlq",
      settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 2000, max_concurrency: null },
    };
    const consumer = await client.queues.createConsumer("q1", body);
    expect(consumer.consumer_id).toBe("c1");
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${A}/queues/q1/consumers`);
    expect(await fake.last().request.json()).toEqual(body);
  });

  it("queues.listConsumers -> GET /queues/{id}/consumers", async () => {
    const { fake, client } = make({ result: [{ consumer_id: "c1", script_name: "app" }] });
    expect(await client.queues.listConsumers("q1")).toEqual([
      { consumer_id: "c1", script_name: "app" },
    ]);
    expect(fake.last().url).toBe(`${A}/queues/q1/consumers`);
  });

  it("queues.updateConsumer -> PUT /queues/{id}/consumers/{consumer_id}", async () => {
    const { fake, client } = make({ result: { consumer_id: "c1" } });
    await client.queues.updateConsumer("q1", "c1", {
      type: "worker",
      script_name: "app",
      settings: { batch_size: 5 },
    });
    expect(fake.last().method).toBe("PUT");
    expect(fake.last().url).toBe(`${A}/queues/q1/consumers/c1`);
    expect(await fake.last().request.json()).toEqual({
      type: "worker",
      script_name: "app",
      settings: { batch_size: 5 },
    });
  });

  it("queues.deleteConsumer -> DELETE /queues/{id}/consumers/{consumer_id}", async () => {
    const { fake, client } = make();
    await client.queues.deleteConsumer("q1", "c1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/queues/q1/consumers/c1`);
  });

  it("vectorize.listIndexes -> GET /vectorize/v2/indexes", async () => {
    const { fake, client } = make({ result: [{ name: "idx" }] });
    expect(await client.vectorize.listIndexes()).toEqual([{ name: "idx" }]);
    expect(fake.last().url).toBe(`${A}/vectorize/v2/indexes`);
  });

  it("queues.deleteQueue -> DELETE /queues/{id}", async () => {
    const { fake, client } = make();
    await client.queues.deleteQueue("q1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/queues/q1`);
  });

  it("vectorize.createIndex -> POST /vectorize/v2/indexes", async () => {
    const { fake, client } = make({ result: { name: "idx" } });
    await client.vectorize.createIndex({
      name: "idx",
      config: { dimensions: 768, metric: "cosine" },
    });
    const req = fake.last();
    expect(req.url).toBe(`${A}/vectorize/v2/indexes`);
    expect(await req.request.json()).toEqual({
      name: "idx",
      config: { dimensions: 768, metric: "cosine" },
    });
  });

  it("vectorize.createMetadataIndex -> POST .../metadata_index/create { propertyName, indexType }", async () => {
    const { fake, client } = make({ result: { mutationId: "m1" } });
    expect(
      await client.vectorize.createMetadataIndex("idx", {
        propertyName: "url",
        indexType: "string",
      }),
    ).toEqual({ mutationId: "m1" });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/vectorize/v2/indexes/idx/metadata_index/create`);
    expect(await req.request.json()).toEqual({ propertyName: "url", indexType: "string" });
  });

  it("vectorize.listMetadataIndexes -> GET .../metadata_index/list", async () => {
    const { fake, client } = make({
      result: { metadataIndexes: [{ propertyName: "url", indexType: "String" }] },
    });
    expect(await client.vectorize.listMetadataIndexes("idx")).toEqual([
      { propertyName: "url", indexType: "String" },
    ]);
    expect(fake.last().url).toBe(`${A}/vectorize/v2/indexes/idx/metadata_index/list`);
  });

  it("r2.getLifecycleRules / putLifecycleRules -> GET and PUT /r2/buckets/{name}/lifecycle", async () => {
    const rule = { id: "a", enabled: true, conditions: { prefix: "" } };
    const got = make({ result: { rules: [rule] } });
    expect(await got.client.r2.getLifecycleRules("b")).toEqual([rule]);
    expect(got.fake.last().url).toBe(`${A}/r2/buckets/b/lifecycle`);
    const put = make();
    await put.client.r2.putLifecycleRules("b", [rule]);
    expect(put.fake.last().method).toBe("PUT");
    expect(put.fake.last().url).toBe(`${A}/r2/buckets/b/lifecycle`);
    expect(await put.fake.last().request.json()).toEqual({ rules: [rule] });
  });

  it("vectorize.deleteIndex -> DELETE /vectorize/v2/indexes/{name}", async () => {
    const { fake, client } = make();
    await client.vectorize.deleteIndex("idx");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/vectorize/v2/indexes/idx`);
  });
});

describe("workflows", () => {
  it("getWorkflow -> GET /workflows/{name}", async () => {
    const { fake, client } = make({ result: { id: "w1", name: "cut-jobs" } });
    expect(await client.workflows.getWorkflow("cut-jobs")).toEqual({ id: "w1", name: "cut-jobs" });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/workflows/cut-jobs`);
  });

  it("getWorkflow surfaces 404 as a CloudflareApiError", async () => {
    const { client } = make({ status: 404, errors: [{ code: 10200, message: "not found" }] });
    await expect(client.workflows.getWorkflow("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("putWorkflow -> PUT /workflows/{name} with the script, class and settings", async () => {
    const { fake, client } = make({
      result: { id: "w1", name: "cut-jobs", script_name: "cut", class_name: "Jobs" },
    });
    const body = {
      script_name: "cut",
      class_name: "Jobs",
      limits: { steps: 500 },
      concurrency: { limit: 10 },
      schedules: [{ cron: "0 * * * *" }],
      default_retention: { success_retention: "3 days", error_retention: 86_400_000 },
    };
    expect(await client.workflows.putWorkflow("cut-jobs", body)).toMatchObject({
      name: "cut-jobs",
      script_name: "cut",
    });
    expect(fake.last().method).toBe("PUT");
    expect(fake.last().url).toBe(`${A}/workflows/cut-jobs`);
    expect(fake.last().headers.get("content-type")).toContain("application/json");
    expect(await fake.last().request.json()).toEqual(body);
  });

  it("tells a missing Workflow and a paid-only schedule from other refusals", () => {
    const notFound = new CloudflareApiError({
      status: 404,
      method: "GET",
      path: "/workflows/x",
      errors: [{ code: WORKFLOW_NOT_FOUND_CODE, message: "workflow.not_found" }],
    });
    const paidOnly = new CloudflareApiError({
      status: 400,
      method: "PUT",
      path: "/workflows/x",
      errors: [{ code: WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE, message: "paid plan" }],
    });
    expect(isWorkflowNotFound(notFound)).toBe(true);
    expect(isWorkflowNotFound(paidOnly)).toBe(false);
    expect(isWorkflowCronPaidOnly(paidOnly)).toBe(true);
    expect(isWorkflowCronPaidOnly(notFound)).toBe(false);
    expect(isWorkflowNotFound(new Error("boom"))).toBe(false);
  });

  it("deleteWorkflow -> DELETE /workflows/{name}", async () => {
    const { fake, client } = make({ result: { status: "ok" } });
    await client.workflows.deleteWorkflow("appflare-jobs");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/workflows/appflare-jobs`);
  });
});

describe("access", () => {
  it("getOrganization -> GET /access/organizations", async () => {
    const { fake, client } = make({
      result: { auth_domain: "team.cloudflareaccess.com", name: "team" },
    });
    const org = await client.access.getOrganization();
    expect(org.auth_domain).toBe("team.cloudflareaccess.com");
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/access/organizations`);
  });

  it("getOrganization surfaces a missing organization as a 404 CloudflareApiError", async () => {
    const { client } = make({ status: 404, errors: [{ code: 12130, message: "not found" }] });
    await expect(client.access.getOrganization()).rejects.toMatchObject({ status: 404 });
  });

  it("listIdentityProviders -> GET /access/identity_providers", async () => {
    const { fake, client } = make({ result: [{ id: "idp1", type: "onetimepin", name: "" }] });
    const idps = await client.access.listIdentityProviders();
    expect(idps.map((i) => i.type)).toEqual(["onetimepin"]);
    expect(fake.last().url.split("?")[0]).toBe(`${A}/access/identity_providers`);
  });

  it("listApps -> GET /access/apps (paginated)", async () => {
    const { fake, client } = make({ result: [{ id: "app1", aud: "aud1" }] });
    expect(await client.access.listApps()).toEqual([{ id: "app1", aud: "aud1" }]);
    expect(fake.last().url.split("?")[0]).toBe(`${A}/access/apps`);
    expect(fake.last().query.get("page")).toBe("1");
  });

  it("getApp -> GET /access/apps/{id}", async () => {
    const { fake, client } = make({ result: { id: "app1", aud: "aud1" } });
    await client.access.getApp("app1");
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/access/apps/app1`);
  });

  it("createApp -> POST /access/apps with a self-hosted body", async () => {
    const { fake, client } = make({ result: { id: "app1", aud: "aud1" } });
    const app = await client.access.createApp({
      type: "self_hosted",
      name: "Appflare",
      domain: "appflare.example.workers.dev",
      session_duration: "24h",
      app_launcher_visible: false,
    });
    expect(app.aud).toBe("aud1");
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/access/apps`);
    expect(await req.request.json()).toEqual({
      type: "self_hosted",
      name: "Appflare",
      domain: "appflare.example.workers.dev",
      session_duration: "24h",
      app_launcher_visible: false,
    });
  });

  it("updateApp -> PUT /access/apps/{id} with the whole self-hosted body", async () => {
    const { fake, client } = make({
      result: { id: "app1", aud: "aud1", domain: "appflare.example.com", policies: [{ id: "p1" }] },
    });
    const app = await client.access.updateApp("app1", {
      type: "self_hosted",
      name: "Appflare (appflare.example.com)",
      domain: "appflare.example.com",
      session_duration: "24h",
      app_launcher_visible: false,
    });
    expect(app).toMatchObject({ aud: "aud1", policies: [{ id: "p1" }] });
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/access/apps/app1`);
    expect(await req.request.json()).toEqual({
      type: "self_hosted",
      name: "Appflare (appflare.example.com)",
      domain: "appflare.example.com",
      session_duration: "24h",
      app_launcher_visible: false,
    });
  });

  it("deleteApp -> DELETE /access/apps/{id}", async () => {
    const { fake, client } = make({ result: { id: "app1" } });
    await client.access.deleteApp("app1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/access/apps/app1`);
  });

  it("createPolicy -> POST /access/apps/{id}/policies with email rules", async () => {
    const { fake, client } = make({ result: { id: "pol1" } });
    await client.access.createPolicy("app1", {
      name: "Appflare admins",
      decision: "allow",
      include: [{ email: { email: "a@example.com" } }, { email: { email: "b@example.com" } }],
      precedence: 1,
    });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/access/apps/app1/policies`);
    expect(await req.request.json()).toEqual({
      name: "Appflare admins",
      decision: "allow",
      include: [{ email: { email: "a@example.com" } }, { email: { email: "b@example.com" } }],
      precedence: 1,
    });
  });

  it("updatePolicy -> PUT /access/apps/{id}/policies/{policy_id}", async () => {
    const { fake, client } = make({ result: { id: "pol1" } });
    await client.access.updatePolicy("app1", "pol1", {
      name: "Appflare admins",
      decision: "allow",
      include: [{ email: { email: "a@example.com" } }],
    });
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/access/apps/app1/policies/pol1`);
    expect(await req.request.json()).toMatchObject({
      include: [{ email: { email: "a@example.com" } }],
    });
  });

  it("createApp sends destinations and reusable policy references", async () => {
    const { fake, client } = make({
      result: {
        id: "app2",
        aud: "aud2",
        domain: null,
        destinations: [
          { type: "worker", worker_id: "tag123" },
          { type: "public", uri: "notes.example.com" },
        ],
      },
    });
    const body = {
      type: "self_hosted" as const,
      name: "notes",
      session_duration: "24h",
      app_launcher_visible: false,
      destinations: [
        { type: "worker" as const, worker_id: "tag123" },
        { type: "public" as const, uri: "notes.example.com" },
      ],
      policies: [
        { id: "users", precedence: 1 },
        { id: "probes", precedence: 2 },
      ],
    };
    const app = await client.access.createApp(body);
    expect(app.domain).toBeNull();
    expect(app.destinations).toHaveLength(2);
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/access/apps`);
    expect(await req.request.json()).toEqual(body);
  });

  it("createApp accepts an inline bypass policy for a public path", async () => {
    const { fake, client } = make({ result: { id: "app3", aud: "aud3" } });
    await client.access.createApp({
      type: "self_hosted",
      name: "notes (public)",
      destinations: [{ type: "public", uri: "notes.example.com/open/*" }],
      policies: [{ name: "Public", decision: "bypass", include: [{ everyone: {} }] }],
    });
    expect(await fake.last().request.json()).toMatchObject({
      destinations: [{ type: "public", uri: "notes.example.com/open/*" }],
      policies: [{ name: "Public", decision: "bypass", include: [{ everyone: {} }] }],
    });
  });

  it("updateApp -> PUT /access/apps/{id} with changed destinations", async () => {
    const { fake, client } = make({ result: { id: "app2", aud: "aud2", domain: null } });
    const app = await client.access.updateApp("app2", {
      type: "self_hosted",
      name: "notes",
      destinations: [{ type: "public", uri: "notes.example.org" }],
      policies: [{ id: "users", precedence: 1 }],
    });
    expect(app.aud).toBe("aud2");
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/access/apps/app2`);
    expect(await req.request.json()).toMatchObject({
      destinations: [{ type: "public", uri: "notes.example.org" }],
    });
  });

  it("listReusablePolicies -> GET /access/policies, following every page", async () => {
    const pages = makeFakeFetch((req) => {
      const page = Number(req.query.get("page"));
      return {
        result: [{ id: `pol${page}`, reusable: true }],
        result_info: { page, per_page: 100, total_pages: 2 },
      };
    });
    const paged = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: pages.fetch });
    expect((await paged.access.listReusablePolicies()).map((p) => p.id)).toEqual(["pol1", "pol2"]);
    expect(pages.calls.map((c) => c.url.split("?")[0])).toEqual([
      `${A}/access/policies`,
      `${A}/access/policies`,
    ]);
    expect(pages.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
  });

  it("getReusablePolicy -> GET /access/policies/{id}", async () => {
    const { fake, client } = make({ result: { id: "pol1", app_count: 3 } });
    expect((await client.access.getReusablePolicy("pol1")).app_count).toBe(3);
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/access/policies/pol1`);
  });

  it("createReusablePolicy -> POST /access/policies (allow, by email)", async () => {
    const { fake, client } = make({ result: { id: "users", reusable: true } });
    const policy = {
      name: "Appflare users",
      decision: "allow" as const,
      include: [{ email: { email: "a@example.com" } }],
    };
    expect((await client.access.createReusablePolicy(policy)).id).toBe("users");
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/access/policies`);
    expect(await req.request.json()).toEqual(policy);
  });

  it("createReusablePolicy -> POST /access/policies (non_identity, one service token)", async () => {
    const { fake, client } = make({ result: { id: "probes" } });
    await client.access.createReusablePolicy({
      name: "Appflare probes",
      decision: "non_identity",
      include: [{ service_token: { token_id: "tok1" } }],
    });
    expect(await fake.last().request.json()).toEqual({
      name: "Appflare probes",
      decision: "non_identity",
      include: [{ service_token: { token_id: "tok1" } }],
    });
  });

  it("updateReusablePolicy -> PUT /access/policies/{id}", async () => {
    const { fake, client } = make({ result: { id: "users", app_count: 2 } });
    const updated = await client.access.updateReusablePolicy("users", {
      name: "Appflare users",
      decision: "allow",
      include: [{ email: { email: "b@example.com" } }],
    });
    expect(updated.app_count).toBe(2);
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/access/policies/users`);
    expect(await req.request.json()).toMatchObject({
      include: [{ email: { email: "b@example.com" } }],
    });
  });

  it("deleteReusablePolicy -> DELETE /access/policies/{id}", async () => {
    const { fake, client } = make({ result: { id: "users" } });
    await client.access.deleteReusablePolicy("users");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/access/policies/users`);
  });

  it("listServiceTokens -> GET /access/service_tokens, following every page", async () => {
    const pages = makeFakeFetch((req) => {
      const page = Number(req.query.get("page"));
      return {
        result: [{ id: `tok${page}`, name: `t${page}`, client_id: `c${page}.access` }],
        result_info: { page, per_page: 100, total_pages: 2 },
      };
    });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: pages.fetch });
    expect((await client.access.listServiceTokens()).map((t) => t.id)).toEqual(["tok1", "tok2"]);
    expect(pages.calls[0]?.url.split("?")[0]).toBe(`${A}/access/service_tokens`);
    expect(pages.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
  });

  it("createServiceToken -> POST /access/service_tokens and returns the secret", async () => {
    const { fake, client } = make({
      result: {
        id: "tok1",
        name: "Appflare probes",
        client_id: "abc.access",
        client_secret: "secret-value",
        duration: "8760h",
      },
    });
    const token = await client.access.createServiceToken({
      name: "Appflare probes",
      duration: "8760h",
    });
    expect(token).toMatchObject({ id: "tok1", client_id: "abc.access" });
    expect(token.client_secret).toBe("secret-value");
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${A}/access/service_tokens`);
    expect(await req.request.json()).toEqual({ name: "Appflare probes", duration: "8760h" });
  });

  it("deleteServiceToken -> DELETE /access/service_tokens/{id}", async () => {
    const { fake, client } = make({ result: { id: "tok1", name: "t", client_id: "c" } });
    await client.access.deleteServiceToken("tok1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/access/service_tokens/tok1`);
  });

  it("deleteServiceToken surfaces a token still in a policy as recognisable (12139)", async () => {
    const { client } = make({
      status: 400,
      errors: [
        { code: ACCESS_SERVICE_TOKEN_IN_USE, message: "access.api.error.service_token_in_use" },
      ],
    });
    const error = await client.access.deleteServiceToken("tok1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(isServiceTokenInUse(error)).toBe(true);
  });

  it("isServiceTokenInUse is false for other failures", async () => {
    const { client } = make({ status: 404, errors: [{ code: 12130, message: "not found" }] });
    const error = await client.access.deleteServiceToken("tok1").catch((e: unknown) => e);
    expect(isServiceTokenInUse(error)).toBe(false);
    expect(isServiceTokenInUse(new Error("access.api.error.service_token_in_use"))).toBe(false);
  });

  it("refreshServiceToken -> POST /access/service_tokens/{id}/refresh", async () => {
    const { fake, client } = make({ result: { id: "tok1", name: "t", client_id: "c" } });
    await client.access.refreshServiceToken("tok1");
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${A}/access/service_tokens/tok1/refresh`);
  });

  it("rotateServiceToken -> POST /access/service_tokens/{id}/rotate", async () => {
    const { fake, client } = make({
      result: { id: "tok1", name: "t", client_id: "c", client_secret: "new-secret" },
    });
    expect((await client.access.rotateServiceToken("tok1")).client_secret).toBe("new-secret");
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${A}/access/service_tokens/tok1/rotate`);
    expect(await fake.last().request.json()).toEqual({});

    await client.access.rotateServiceToken("tok1", {
      previousSecretExpiresAt: "2026-10-01T00:00:00Z",
    });
    expect(await fake.last().request.json()).toEqual({
      previous_client_secret_expires_at: "2026-10-01T00:00:00Z",
    });
  });
});
