import type { FetchLike, RequestLog } from "@appflare/cf-api";

/**
 * Test-only stand-in for the Cloudflare REST API, keyed by `METHOD /path`
 * (path without `/client/v4` and without the query). `@appflare/cf-api`'s own
 * fake fetch is not exported, and this one routes by path, which suits flows
 * that make many different calls. Unrouted requests get a 404 envelope.
 */

export interface FakeRoute {
  status?: number;
  result?: unknown;
  errors?: Array<{ code: number; message: string }>;
  result_info?: { page?: number; per_page?: number; total_pages?: number; cursor?: string };
}

export interface FakeCall {
  key: string;
  authorization: string | null;
  body: string | null;
}

export function fakeCloudflare(
  routes: Record<string, FakeRoute | ((url: URL) => FakeRoute) | "network-error">,
) {
  const calls: FakeCall[] = [];
  const logs: RequestLog[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname.replace(/^\/client\/v4/, "")}`;
    calls.push({
      key,
      authorization: request.headers.get("authorization"),
      body: request.body === null ? null : await request.text(),
    });
    const route = routes[key];
    if (route === "network-error") throw new TypeError("fetch failed");
    const spec: FakeRoute =
      route === undefined
        ? { status: 404, errors: [{ code: 7003, message: "No route for that URI" }] }
        : typeof route === "function"
          ? route(url)
          : route;
    const status = spec.status ?? 200;
    return Response.json(
      {
        success: status < 400,
        errors: spec.errors ?? [],
        messages: [],
        result: spec.result ?? null,
        ...(spec.result_info === undefined ? {} : { result_info: spec.result_info }),
      },
      { status },
    );
  };
  return {
    fetch,
    calls,
    logs,
    onRequest: (log: RequestLog) => logs.push(log),
    keys: () => calls.map((c) => c.key),
  };
}

export const INVALID_TOKEN: FakeRoute = {
  status: 401,
  errors: [{ code: 1000, message: "Invalid API Token" }],
};

export const FORBIDDEN: FakeRoute = {
  status: 403,
  errors: [{ code: 10000, message: "Authentication error" }],
};

export const active = (extra: Record<string, unknown> = {}): FakeRoute => ({
  result: { id: "tok-id", status: "active", ...extra },
});
