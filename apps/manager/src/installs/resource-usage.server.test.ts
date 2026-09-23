import { createClient } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { readResourceUsage } from "./resource-usage.server";

const ACC = "acc1";

describe("readResourceUsage", () => {
  it("reads KV key counts and D1 sizes with one call each, skipping failures", async () => {
    const fake = fakeCloudflare({
      [`GET /accounts/${ACC}/storage/kv/namespaces/kv-1/keys`]: {
        result: [{ name: "a" }, { name: "b" }],
        result_info: {},
      },
      [`GET /accounts/${ACC}/storage/kv/namespaces/kv-2/keys`]: (url) => ({
        result: Array.from({ length: Number(url.searchParams.get("limit")) }, (_, i) => ({
          name: `k${i}`,
        })),
        result_info: { cursor: "next" },
      }),
      [`GET /accounts/${ACC}/d1/database/d1-1`]: {
        result: { uuid: "d1-1", name: "db", file_size: 12288 },
      },
      [`GET /accounts/${ACC}/d1/database/d1-2`]: { status: 500 },
    });
    const api = createClient({ accountId: ACC, token: "t", fetch: fake.fetch });
    const usage = await readResourceUsage(api, [
      { id: "a", kind: "kv", cfId: "kv-1" },
      { id: "b", kind: "kv", cfId: "kv-2" },
      { id: "c", kind: "d1", cfId: "d1-1" },
      { id: "d", kind: "d1", cfId: "d1-2" },
      { id: "e", kind: "r2", cfId: "bucket" },
      { id: "f", kind: "kv", cfId: null },
    ]);
    expect(usage).toEqual([
      { id: "a", kvKeys: { count: 2, more: false } },
      { id: "b", kvKeys: { count: 1000, more: true } },
      { id: "c", d1Bytes: 12288 },
    ]);
    expect(fake.keys()).toHaveLength(4);
  });
});
