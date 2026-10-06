import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const A = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const PASSWORD = "db-password-DO-NOT-LEAK";

function make(spec?: FakeResponseSpec | ((index: number) => FakeResponseSpec)) {
  const fake = makeFakeFetch(typeof spec === "function" ? (_req, i) => spec(i) : spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

const origin = {
  scheme: "postgres" as const,
  host: "db.example.com",
  port: 5432,
  database: "feedlog",
  user: "app",
  password: PASSWORD,
};

describe("hyperdrive", () => {
  it("createConfig -> POST /hyperdrive/configs with name and origin, caching only when given", async () => {
    const { fake, client } = make({ result: { id: "hd-1", name: "feedlog-hyperdrive" } });
    const made = await client.hyperdrive.createConfig({ name: "feedlog-hyperdrive", origin });
    expect(made).toEqual({ id: "hd-1", name: "feedlog-hyperdrive" });
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${A}/hyperdrive/configs`);
    expect(await fake.last().request.json()).toEqual({ name: "feedlog-hyperdrive", origin });

    await client.hyperdrive.createConfig({
      name: "cached",
      origin,
      caching: { disabled: true },
    });
    expect(await fake.last().request.json()).toMatchObject({ caching: { disabled: true } });
  });

  it("patchConfig -> PATCH /hyperdrive/configs/{id} with caching alone", async () => {
    const { fake, client } = make({
      result: { id: "hd-1", name: "mailbox-hyperdrive", caching: { disabled: true } },
    });
    const patched = await client.hyperdrive.patchConfig("hd-1", { caching: { disabled: true } });
    expect(patched.caching).toEqual({ disabled: true });
    expect(fake.last().method).toBe("PATCH");
    expect(fake.last().url).toBe(`${A}/hyperdrive/configs/hd-1`);
    expect(await fake.last().request.json()).toEqual({ caching: { disabled: true } });
  });

  it("never puts the password in an error", async () => {
    const { client } = make({
      status: 400,
      errors: [{ code: 2008, message: "Failed to connect to the origin database" }],
    });
    const error = await client.hyperdrive
      .createConfig({ name: "x", origin })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(String((error as Error).message)).toContain("[2008] Failed to connect");
    expect(String((error as Error).message)).not.toContain(PASSWORD);
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
  });

  it("listConfigs reads every page until a short page or the total", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `hd-${from + i}`, name: `c-${from + i}` }));
    const { fake, client } = make((i) =>
      i === 0
        ? { result: page(100, 0), result_info: { page: 1, per_page: 100, total_count: 130 } }
        : { result: page(30, 100), result_info: { page: 2, per_page: 100, total_count: 130 } },
    );
    const all = await client.hyperdrive.listConfigs();
    expect(all).toHaveLength(130);
    expect(fake.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
    expect(fake.calls[0]?.query.get("per_page")).toBe("100");
    expect(fake.calls[0]?.path).toBe(`/client/v4/accounts/${ACCOUNT}/hyperdrive/configs`);
  });

  it("listConfigs stops after one page when the account has few", async () => {
    const { fake, client } = make({ result: [{ id: "hd-1", name: "a" }] });
    expect(await client.hyperdrive.listConfigs()).toEqual([{ id: "hd-1", name: "a" }]);
    expect(fake.calls).toHaveLength(1);
  });

  it("getConfig and deleteConfig address one configuration by id", async () => {
    const { fake, client } = make({ result: null });
    await client.hyperdrive.getConfig("hd 1");
    expect(fake.last().url).toBe(`${A}/hyperdrive/configs/hd%201`);
    await client.hyperdrive.deleteConfig("hd-1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/hyperdrive/configs/hd-1`);
  });
});
