import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";

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
});

describe("access", () => {
  it("createApp -> POST /access/apps", async () => {
    const { fake, client } = make({ result: { id: "app1" } });
    await client.access.createApp({ name: "Appflare", domain: "x.example.com" });
    const req = fake.last();
    expect(req.url).toBe(`${A}/access/apps`);
    expect(await req.request.json()).toEqual({ name: "Appflare", domain: "x.example.com" });
  });

  it("deleteApp -> DELETE /access/apps/{id}", async () => {
    const { fake, client } = make();
    await client.access.deleteApp("app1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/access/apps/app1`);
  });

  it("createPolicy -> POST /access/apps/{id}/policies", async () => {
    const { fake, client } = make({ result: { id: "pol1" } });
    await client.access.createPolicy("app1", { name: "admins", decision: "allow" });
    const req = fake.last();
    expect(req.url).toBe(`${A}/access/apps/app1/policies`);
    expect(await req.request.json()).toEqual({ name: "admins", decision: "allow" });
  });

  it("getCerts -> GET /access/certs", async () => {
    const { fake, client } = make({ result: { keys: [] } });
    await client.access.getCerts();
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/access/certs`);
  });
});
