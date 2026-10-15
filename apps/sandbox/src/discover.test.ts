import { CloudflareApiError } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import {
  type AccountReader,
  accountReader,
  discover,
  isOwned,
  type OwnedResourceNames,
} from "./discover";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "app-token-value-0123456789";
const PREFIX = "void-appflare-x0yzabcd";

type Handler = (url: URL) => Response | undefined;

function ok(result: unknown, resultInfo?: unknown): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  });
}

function refused(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });
}

/** An account reader over a scripted Cloudflare API; `seen` lists each request as `GET <path>?<query>`. */
function scripted(handler: Handler) {
  const seen: string[] = [];
  const reader = accountReader(TOKEN, ACCOUNT, async (input, init) => {
    const url = new URL(input);
    seen.push(`${init?.method ?? "GET"} ${url.pathname.replace("/client/v4", "")}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const answer = handler(url);
    if (answer === undefined) throw new Error(`unexpected ${url.pathname}`);
    return answer;
  });
  return { reader, seen };
}

describe("accountReader", () => {
  it("lists dispatch namespaces, Hyperdrive configurations and AI Gateways", async () => {
    const { reader, seen } = scripted((url) => {
      if (url.pathname.endsWith("/workers/dispatch/namespaces")) {
        return ok([
          { namespace_id: "ns-1", namespace_name: `${PREFIX}-users`, script_count: 0 },
          { namespace_name: "no-id" },
        ]);
      }
      if (url.pathname.endsWith("/hyperdrive/configs")) {
        return ok([{ id: "hd-1", name: `${PREFIX}-database` }], { total_count: 1 });
      }
      if (url.pathname.endsWith("/ai-gateway/gateways")) {
        // A full first page, then a short one ends the list.
        const page = Number(url.searchParams.get("page"));
        const count = page === 1 ? 50 : 2;
        return ok(Array.from({ length: count }, (_, i) => ({ id: `gw-${page}-${i}` })));
      }
      return undefined;
    });
    expect(await reader.dispatchNamespaces()).toEqual([{ id: "ns-1", name: `${PREFIX}-users` }]);
    expect(await reader.hyperdriveConfigs()).toEqual([{ id: "hd-1", name: `${PREFIX}-database` }]);
    const gateways = await reader.aiGateways();
    expect(gateways).toHaveLength(52);
    expect(gateways[0]).toEqual({ id: "gw-1-0", name: "gw-1-0" });
    expect(seen.filter((s) => s.includes("ai-gateway"))).toEqual([
      `GET /accounts/${ACCOUNT}/ai-gateway/gateways?page=1&per_page=50`,
      `GET /accounts/${ACCOUNT}/ai-gateway/gateways?page=2&per_page=50`,
    ]);
  });

  it("reports a refused list as cf-api's error, without the token", async () => {
    const { reader } = scripted(() =>
      refused(403, 10121, "You do not have access to dispatch namespaces"),
    );
    const error = await reader.dispatchNamespaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(403);
    expect((error as Error).message).toContain("10121");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("reads the token's id as a user token first, then as an account token", async () => {
    const user = scripted((url) =>
      url.pathname === "/client/v4/user/tokens/verify"
        ? ok({ id: "user-token-id", status: "active" })
        : undefined,
    );
    expect(await user.reader.tokenId()).toBe("user-token-id");
    expect(user.seen).toEqual(["GET /user/tokens/verify"]);

    const owned = scripted((url) =>
      url.pathname === "/client/v4/user/tokens/verify"
        ? refused(401, 1000, "Invalid API Token")
        : url.pathname.endsWith(`/accounts/${ACCOUNT}/tokens/verify`)
          ? ok({ id: "account-token-id", status: "active" })
          : undefined,
    );
    expect(await owned.reader.tokenId()).toBe("account-token-id");
    expect(owned.seen).toEqual([
      "GET /user/tokens/verify",
      `GET /accounts/${ACCOUNT}/tokens/verify`,
    ]);

    const neither = scripted(() => refused(401, 1000, "Invalid API Token"));
    const error = await neither.reader.tokenId().catch((e: unknown) => e);
    expect((error as CloudflareApiError).path).toBe(`/accounts/${ACCOUNT}/tokens/verify`);
  });
});

describe("discover", () => {
  const OWNED: OwnedResourceNames = {
    dispatch_namespace: [`${PREFIX}-users`],
    hyperdrive: [`${PREFIX}-database`],
    ai_gateway: [PREFIX],
    kv: [`${PREFIX}-routing`],
  };

  function reader(calls: string[], bindings: unknown[] = []): AccountReader {
    return {
      workerBindings: async () => bindings,
      workersDevEnabled: async () => false,
      accountSubdomain: async () => "acme",
      d1Names: async () => new Map(),
      kvTitles: async () =>
        new Map([
          ["kv-1", `${PREFIX}-routing`],
          ["kv-2", `${PREFIX}-project-blog-cache`],
        ]),
      dispatchNamespaces: async () => {
        calls.push("dispatch");
        return [
          { id: "ns-1", name: `${PREFIX}-users` },
          { id: "ns-2", name: `${PREFIX}-users-staging` },
        ];
      },
      hyperdriveConfigs: async () => {
        calls.push("hyperdrive");
        return [
          { id: "hd-1", name: `${PREFIX}-database` },
          { id: "hd-2", name: `${PREFIX}-project-blog-db` },
        ];
      },
      aiGateways: async () => {
        calls.push("gateways");
        return [
          { id: PREFIX, name: PREFIX },
          { id: `${PREFIX}-project-blog`, name: `${PREFIX}-project-blog` },
        ];
      },
      tokenId: async () => "id",
    };
  }

  it("reads no account-wide list without owned names, or without resources", async () => {
    const calls: string[] = [];
    await discover(reader(calls), ["app"], { withResources: true });
    await discover(reader(calls), ["app"], { withResources: false, owned: OWNED });
    expect(calls).toEqual([]);
    await discover(reader(calls), ["app"], { withResources: true, owned: { kv: ["x"] } });
    expect(calls).toEqual([]);
    await discover(reader(calls), ["app"], { withResources: true, owned: OWNED });
    expect(calls).toEqual(["dispatch", "hyperdrive", "gateways"]);
  });

  it("records only the exact names the installer gives the install's resources", async () => {
    const found = await discover(
      reader(
        [],
        [
          { type: "kv_namespace", name: "ROUTING", namespace_id: "kv-1" },
          // A resource of one of the platform's own users' projects.
          { type: "kv_namespace", name: "PROJECT_CACHE", namespace_id: "kv-2" },
          { type: "durable_object_namespace", name: "SANDBOX", class_name: "Sandbox" },
        ],
      ),
      ["app"],
      { withResources: true, owned: OWNED },
    );
    expect(found.resources.map((r) => `${r.kind} ${r.name}`)).toEqual([
      "worker app",
      `kv ${PREFIX}-routing`,
      "durable_object Sandbox",
      `dispatch_namespace ${PREFIX}-users`,
      `hyperdrive ${PREFIX}-database`,
      `ai_gateway ${PREFIX}`,
    ]);
    // Without owned names, every bound resource is recorded, as before.
    const all = await discover(
      reader([], [{ type: "kv_namespace", name: "PROJECT_CACHE", namespace_id: "kv-2" }]),
      ["app"],
    );
    expect(all.resources.map((r) => r.name)).toEqual(["app", `${PREFIX}-project-blog-cache`]);
  });

  it("passes Workers and what belongs to them whatever the names", () => {
    expect(isOwned(OWNED, "durable_object", "Anything")).toBe(true);
    expect(isOwned(OWNED, "kv", `${PREFIX}-routing`)).toBe(true);
    expect(isOwned(OWNED, "r2", `${PREFIX}-assets`)).toBe(false);
    expect(isOwned(null, "r2", "anything")).toBe(true);
  });
});
