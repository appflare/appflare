import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";
import { R2_CATALOG_NOT_FOUND_CODE } from "./namespaces/r2-catalog";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const SINK_TOKEN = "sink-token-DO-NOT-LEAK-456";
const ACCOUNT = "acc-123";
const A = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function make(spec?: FakeResponseSpec | ((index: number) => FakeResponseSpec)) {
  const fake = makeFakeFetch(typeof spec === "function" ? (_req, i) => spec(i) : spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

describe("pipelines", () => {
  it("createStream -> POST /pipelines/v1/streams with the body as given", async () => {
    const { fake, client } = make({ result: { id: "s1", name: "traks_events_stream" } });
    const args = {
      name: "traks_events_stream",
      format: { type: "json" as const },
      schema: { fields: [{ name: "ts", type: "timestamp", required: true }] },
      http: { enabled: false, authentication: false },
      worker_binding: { enabled: true },
    };
    expect(await client.pipelines.createStream(args)).toEqual({
      id: "s1",
      name: "traks_events_stream",
    });
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${A}/pipelines/v1/streams`);
    expect(await fake.last().request.json()).toEqual(args);
  });

  it("lists read every page by total_count, which the v1 lists report instead of total_pages", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, name: `n${from + i}` }));
    const { fake, client } = make((i) =>
      i === 0
        ? { result: page(100, 0), result_info: { page: 1, per_page: 100, total_count: 101 } }
        : { result: page(1, 100), result_info: { page: 2, per_page: 100, total_count: 101 } },
    );
    expect(await client.pipelines.listStreams()).toHaveLength(101);
    expect(fake.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
    expect(fake.calls[0]?.path).toBe(`/client/v4/accounts/${ACCOUNT}/pipelines/v1/streams`);
  });

  it("listSinks and listPipelines stop after a short page", async () => {
    const { fake, client } = make({
      result: [{ id: "x", name: "a" }],
      result_info: { page: 1, per_page: 100, count: 1, total_count: 1 },
    });
    await client.pipelines.listSinks();
    await client.pipelines.listPipelines();
    expect(fake.calls.map((c) => c.path)).toEqual([
      `/client/v4/accounts/${ACCOUNT}/pipelines/v1/sinks`,
      `/client/v4/accounts/${ACCOUNT}/pipelines/v1/pipelines`,
    ]);
  });

  it("probeStreams asks for one stream only", async () => {
    const { fake, client } = make({ result: [] });
    await client.pipelines.probeStreams();
    expect(fake.last().query.get("per_page")).toBe("1");
  });

  it("probeStreams surfaces the refusal a token without Pipelines gets", async () => {
    const { client } = make({ status: 403, errors: [{ code: 100, message: "Forbidden" }] });
    const error = await client.pipelines.probeStreams().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(403);
    expect((error as CloudflareApiError).errors[0]?.code).toBe(100);
  });

  it("createSink sends the catalog sink and never puts its token in an error", async () => {
    const { fake, client } = make({
      status: 400,
      errors: [{ code: 1012, message: "Cannot create sink for existing catalog table" }],
    });
    const args = {
      name: "traks_events_sink",
      type: "r2_data_catalog" as const,
      format: { type: "parquet" as const, compression: "zstd" },
      config: {
        account_id: ACCOUNT,
        bucket: "traks-events",
        namespace: "traks",
        table_name: "events",
        token: SINK_TOKEN,
        rolling_policy: { interval_seconds: 60 },
      },
    };
    const error = await client.pipelines.createSink(args).catch((e: unknown) => e);
    expect(await fake.last().request.json()).toEqual(args);
    expect(fake.last().url).toBe(`${A}/pipelines/v1/sinks`);
    expect(String((error as Error).message)).toContain("[1012]");
    expect(String((error as Error).message)).not.toContain(SINK_TOKEN);
    expect(JSON.stringify(error)).not.toContain(SINK_TOKEN);
  });

  it("createPipeline, get and delete address each object by id", async () => {
    const { fake, client } = make({ result: { id: "p1", name: "p" } });
    await client.pipelines.createPipeline({ name: "p", sql: "INSERT INTO k SELECT * FROM s" });
    expect(await fake.last().request.json()).toEqual({
      name: "p",
      sql: "INSERT INTO k SELECT * FROM s",
    });
    await client.pipelines.getPipeline("p 1");
    expect(fake.last().url).toBe(`${A}/pipelines/v1/pipelines/p%201`);
    await client.pipelines.deletePipeline("p1");
    await client.pipelines.deleteSink("k1");
    await client.pipelines.deleteStream("s1");
    await client.pipelines.getSink("k1");
    await client.pipelines.getStream("s1");
    expect(fake.calls.slice(2).map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${A}/pipelines/v1/pipelines/p1`,
      `DELETE ${A}/pipelines/v1/sinks/k1`,
      `DELETE ${A}/pipelines/v1/streams/s1`,
      `GET ${A}/pipelines/v1/sinks/k1`,
      `GET ${A}/pipelines/v1/streams/s1`,
    ]);
  });
});

describe("r2Catalog", () => {
  it("get, enable, and remove (force) address the bucket's catalog", async () => {
    const { fake, client } = make({ result: { id: "c1", bucket: "b", status: "active" } });
    expect((await client.r2Catalog.get("b")).status).toBe("active");
    await client.r2Catalog.enable("b");
    await client.r2Catalog.remove("b", { force: true });
    await client.r2Catalog.remove("b");
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${A}/r2-catalog/b`,
      `POST ${A}/r2-catalog/b/enable`,
      `POST ${A}/r2-catalog/b/delete?force=true`,
      `POST ${A}/r2-catalog/b/delete`,
    ]);
  });

  it("a bucket without a catalog is a 404 with code 40401", async () => {
    const { client } = make({
      status: 404,
      errors: [{ code: R2_CATALOG_NOT_FOUND_CODE, message: "Catalog not found" }],
    });
    const error = await client.r2Catalog.get("b").catch((e: unknown) => e);
    expect((error as CloudflareApiError).errors[0]?.code).toBe(40401);
  });

  it("stores the credential and updates maintenance with the API schema's field names", async () => {
    const { fake, client } = make({ status: 200, result: null });
    await client.r2Catalog.storeCredential("b", SINK_TOKEN);
    expect(fake.last().url).toBe(`${A}/r2-catalog/b/credential`);
    expect(await fake.last().request.json()).toEqual({ token: SINK_TOKEN });
    await client.r2Catalog.updateMaintenance("b", {
      compaction: { state: "enabled" },
      snapshot_expiration: { state: "enabled", max_snapshot_age: "30d", min_snapshots_to_keep: 5 },
    });
    expect(await fake.last().request.json()).toEqual({
      compaction: { state: "enabled" },
      snapshot_expiration: { state: "enabled", max_snapshot_age: "30d", min_snapshots_to_keep: 5 },
    });
  });

  it("never puts the credential in an error", async () => {
    const { client } = make({ status: 403, errors: [{ code: 10000, message: "Forbidden" }] });
    const error = await client.r2Catalog.storeCredential("b", SINK_TOKEN).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(SINK_TOKEN);
    expect(String((error as Error).message)).not.toContain(SINK_TOKEN);
  });
});
