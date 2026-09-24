import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gateway, { clearGatewayCache, type GatewayEnv } from "./gateway-worker.js";
import source from "./gateway-worker.js?raw";

/**
 * The gateway Worker's routing, run as the module the manager uploads: the
 * zone's own hosts pass through, registered external hosts go to their
 * app's service binding with the request unchanged, anything else passes
 * through.
 */

function routes(table: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    get: async (key: string) => {
      reads.push(key);
      return table[key] ?? null;
    },
  };
}

function app(name: string) {
  const seen: Request[] = [];
  return {
    seen,
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response(`from ${name}`);
    },
  };
}

let origin: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearGatewayCache();
  origin = vi.fn(async (request: Request) => new Response(`origin ${new URL(request.url).host}`));
  vi.stubGlobal("fetch", origin);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function env(extra: Partial<GatewayEnv> = {}, table: Record<string, string> = {}) {
  const kv = routes(table);
  return {
    kv,
    env: {
      ZONE_NAME: "gateway.example",
      CNAME_TARGET: "appflare-gateway.gateway.example",
      GATEWAY_VERSION: "1",
      ROUTES: kv,
      ...extra,
    } as GatewayEnv,
  };
}

describe("gateway Worker", () => {
  it("passes the zone's own hostnames through without a lookup", async () => {
    const { env: e, kv } = env();
    for (const url of ["https://gateway.example/", "https://www.gateway.example/a?b=1"]) {
      const res = await gateway.fetch(new Request(url), e);
      expect(await res.text()).toBe(`origin ${new URL(url).host}`);
    }
    expect(origin).toHaveBeenCalledTimes(2);
    expect(kv.reads).toEqual([]);
  });

  it("answers on its own hostname", async () => {
    const { env: e } = env();
    const res = await gateway.fetch(new Request("https://appflare-gateway.gateway.example/"), e);
    expect(await res.json()).toEqual({ service: "appflare-gateway", version: "1" });
    expect(origin).not.toHaveBeenCalled();
  });

  it("forwards a registered hostname to its app with the original URL and Host", async () => {
    const cut = app("cut");
    const { env: e } = env({ APP_I1: cut }, { "go.customer.test": "APP_I1" });
    const request = new Request("https://go.customer.test/x?y=1", {
      method: "POST",
      headers: { "x-test": "1" },
      body: "hi",
    });
    const res = await gateway.fetch(request, e);
    expect(await res.text()).toBe("from cut");
    expect(cut.seen[0]?.url).toBe("https://go.customer.test/x?y=1");
    expect(cut.seen[0]?.method).toBe("POST");
    expect(cut.seen[0]?.headers.get("x-test")).toBe("1");
    expect(origin).not.toHaveBeenCalled();
  });

  it("passes through a hostname that is not registered", async () => {
    const { env: e } = env();
    expect(await (await gateway.fetch(new Request("https://new.customer.test/"), e)).text()).toBe(
      "origin new.customer.test",
    );
  });

  it("answers 502 for a registered hostname whose binding is missing", async () => {
    const { env: e } = env({}, { "old.customer.test": "APP_GONE" });
    const res = await gateway.fetch(new Request("https://old.customer.test/"), e);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("No app answers for old.customer.test at the moment.");
    expect(origin).not.toHaveBeenCalled();
  });

  it("answers 502 when the routing table cannot be read", async () => {
    const { env: e } = env({
      ROUTES: {
        get: async () => {
          throw new Error("KV unavailable");
        },
      },
    });
    const res = await gateway.fetch(new Request("https://go.customer.test/"), e);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("could not read its routing table");
    expect(origin).not.toHaveBeenCalled();
  });

  it("caches a lookup in the isolate", async () => {
    const cut = app("cut");
    const { env: e, kv } = env({ APP_I1: cut }, { "go.customer.test": "APP_I1" });
    await gateway.fetch(new Request("https://go.customer.test/"), e);
    await gateway.fetch(new Request("https://GO.customer.test/"), e);
    expect(kv.reads).toEqual(["go.customer.test"]);
    expect(cut.seen).toHaveLength(2);
  });

  it("is one module with no imports, as it is uploaded", () => {
    expect(source).toContain("export default");
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
