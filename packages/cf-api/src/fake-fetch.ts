import type { CloudflareError } from "./errors";
import type { FetchLike } from "./http";

/**
 * Test-only fetch double (imported only by `*.test.ts`). Records every request as
 * a real `Request` so tests can re-parse JSON and multipart bodies, and returns a
 * Cloudflare-shaped envelope from a per-call spec.
 */

export interface CapturedRequest {
  method: string;
  url: string;
  /** Pathname only (no origin, no query). */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  authorization: string | null;
  /** The reconstructed request; clone before reading the body more than once. */
  request: Request;
}

export interface FakeResponseSpec {
  status?: number;
  /** Unwrapped `result` for the success envelope. */
  result?: unknown;
  result_info?: unknown;
  errors?: CloudflareError[];
  /** Full envelope override; wins over `result`/`errors`. */
  envelope?: unknown;
  /** Raw (non-JSON) body; wins over everything. */
  text?: string;
  /** Force `success` regardless of status. */
  success?: boolean;
}

export type FakeHandler = (req: CapturedRequest, index: number) => FakeResponseSpec | undefined;

export interface FakeFetch {
  fetch: FetchLike;
  calls: CapturedRequest[];
  last(): CapturedRequest;
}

function toResponse(spec: FakeResponseSpec): Response {
  const status = spec.status ?? 200;
  if (spec.text !== undefined) {
    return new Response(spec.text, { status });
  }
  const body =
    spec.envelope !== undefined
      ? spec.envelope
      : {
          success: spec.success ?? status < 400,
          errors: spec.errors ?? [],
          messages: [],
          result: spec.result ?? null,
          ...(spec.result_info === undefined ? {} : { result_info: spec.result_info }),
        };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param handler returns the response spec for each call. A plain object (not a
 * function) is used as the spec for every call.
 */
export function makeFakeFetch(handler?: FakeHandler | FakeResponseSpec): FakeFetch {
  const calls: CapturedRequest[] = [];
  const resolve: FakeHandler = typeof handler === "function" ? handler : () => handler ?? {};

  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const captured: CapturedRequest = {
      method: request.method,
      url: request.url,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      authorization: request.headers.get("authorization"),
      request,
    };
    calls.push(captured);
    return toResponse(resolve(captured, calls.length - 1) ?? {});
  };

  return {
    fetch,
    calls,
    last() {
      const call = calls[calls.length - 1];
      if (!call) throw new Error("makeFakeFetch: no request was made");
      return call;
    },
  };
}
