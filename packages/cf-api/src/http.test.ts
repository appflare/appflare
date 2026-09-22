import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { makeFakeFetch } from "./fake-fetch";
import type { RequestLog } from "./http";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const BASE = "https://api.cloudflare.com/client/v4";

describe("http core", () => {
  it("sends bearer auth and Accept, and unwraps the envelope result", async () => {
    const fake = makeFakeFetch({ result: { id: "t1", status: "active" } });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });

    const result = await client.tokens.verify();

    expect(result).toEqual({ id: "t1", status: "active" });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${BASE}/accounts/${ACCOUNT}/tokens/verify`);
    expect(fake.last().authorization).toBe(`Bearer ${TOKEN}`);
    expect(fake.last().headers.get("accept")).toBe("application/json");
  });

  it("calls onRequest with method, path and status only (no base, no query, no token)", async () => {
    const logs: RequestLog[] = [];
    const fake = makeFakeFetch({ result: [] });
    const client = createClient({
      accountId: ACCOUNT,
      token: TOKEN,
      fetch: fake.fetch,
      onRequest: (log) => logs.push(log),
    });

    await client.kv.listNamespaces();

    expect(logs).toEqual([
      { method: "GET", path: `/accounts/${ACCOUNT}/storage/kv/namespaces`, status: 200 },
    ]);
    // The request URL carries the pagination query, but the hook path never does.
    expect(fake.last().query.get("page")).toBe("1");
    expect(logs[0]?.path).not.toContain("?");
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("throws CloudflareApiError carrying status/method/path/errors, without the token", async () => {
    const fake = makeFakeFetch({
      status: 404,
      success: false,
      errors: [{ code: 10007, message: "workers.api.error.script_not_found" }],
    });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });

    const error = await client.workers.deleteScript("missing").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CloudflareApiError);
    const cfError = error as CloudflareApiError;
    expect(cfError.status).toBe(404);
    expect(cfError.method).toBe("DELETE");
    expect(cfError.path).toBe(`/accounts/${ACCOUNT}/workers/scripts/missing`);
    expect(cfError.errors).toEqual([
      { code: 10007, message: "workers.api.error.script_not_found" },
    ]);
    expect(cfError.message).toContain("10007");
    expect(cfError.message).toContain("workers.api.error.script_not_found");
    expect(cfError.message).not.toContain(TOKEN);
  });

  it("throws on success:false even with a 200 status", async () => {
    const fake = makeFakeFetch({
      status: 200,
      success: false,
      errors: [{ code: 1, message: "bad request" }],
    });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });

    await expect(client.tokens.verify()).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it("still throws with a head-only message when errors[] is empty", async () => {
    const fake = makeFakeFetch({ status: 500, success: false, errors: [] });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });

    const error = (await client.tokens.verify().catch((e: unknown) => e)) as CloudflareApiError;
    expect(error.message).toBe(
      `Cloudflare API request failed: GET /accounts/${ACCOUNT}/tokens/verify -> 500`,
    );
  });

  it("treats a response without result_info as complete, even at an exact per_page multiple", async () => {
    // A full 100-row page with no result_info (e.g. GET /workers/scripts, which
    // ignores paging) must not trigger a second fetch.
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}` }));
    const fake = makeFakeFetch({ result: rows });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });

    const scripts = await client.workers.listScripts();

    expect(scripts).toHaveLength(100);
    expect(fake.calls).toHaveLength(1);
  });

  it("follows result_info pagination, sending page/per_page and concatenating results", async () => {
    const fake = makeFakeFetch((req) => {
      const page = Number(req.query.get("page"));
      const result = page === 1 ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }];
      return { result, result_info: { page, per_page: 100, total_pages: 2 } };
    });
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });

    const namespaces = await client.kv.listNamespaces();

    expect(namespaces.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.query.get("page")).toBe("1");
    expect(fake.calls[0]?.query.get("per_page")).toBe("100");
    expect(fake.calls[1]?.query.get("page")).toBe("2");
  });
});
