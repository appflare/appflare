import { CloudflareApiError, type CloudflareError } from "./errors";

/** Default Cloudflare REST API base. All method paths are relative to this. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * The subset of `fetch` this client relies on. Declared explicitly so the client
 * stays runtime-agnostic: the caller may pass a Worker `fetch`, Node 22's global
 * `fetch`, or a stub in tests. No Node built-ins are used here.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Payload handed to the {@link ClientOptions.onRequest} logger hook. */
export interface RequestLog {
  method: string;
  /** Path only: no API base, no query string, so never a secret. */
  path: string;
  status: number;
}

export interface ClientOptions {
  accountId: string;
  token: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Called once per response with method, path and status only. */
  onRequest?: (log: RequestLog) => void;
  /** Overridable for tests; defaults to {@link CLOUDFLARE_API_BASE}. */
  baseUrl?: string;
}

/** Cloudflare's standard response envelope. */
export interface CloudflareEnvelope<T> {
  success: boolean;
  errors: CloudflareError[];
  messages: unknown[];
  result: T;
  result_info?: ResultInfo;
}

export interface ResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  total_pages?: number;
  /** Cursor-paginated endpoints (R2 bucket list) return the next cursor here. */
  cursor?: string;
}

export type QueryValue = string | number | boolean | undefined;

export interface SendOptions {
  query?: Record<string, QueryValue>;
  /** JSON request body. Mutually exclusive with {@link SendOptions.form}. */
  json?: unknown;
  /** Multipart request body. The content-type (with boundary) is set by fetch. */
  form?: FormData;
  /** Bearer token override (e.g. the assets-upload-session JWT). */
  token?: string;
  /**
   * Raw request body with an explicit content type (single-file asset uploads).
   * Mutually exclusive with {@link SendOptions.json} and {@link SendOptions.form}.
   */
  raw?: { body: string | Uint8Array; contentType: string };
}

/**
 * Internal HTTP surface handed to each namespace factory. `result` unwraps the
 * envelope; `list` follows `result_info` pagination; `acct` prefixes the
 * account-scoped path.
 */
export interface HttpApi {
  readonly accountId: string;
  acct(suffix: string): string;
  send(method: string, path: string, opts?: SendOptions): Promise<CloudflareEnvelope<unknown>>;
  result<T>(method: string, path: string, opts?: SendOptions): Promise<T>;
  list<T>(method: string, path: string, opts?: SendOptions & { perPage?: number }): Promise<T[]>;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  if (!query) {
    return `${baseUrl}${path}`;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
}

async function parseEnvelope(res: Response): Promise<CloudflareEnvelope<unknown>> {
  const text = await res.text();
  if (text.length === 0) {
    return { success: res.ok, errors: [], messages: [], result: null };
  }
  try {
    return JSON.parse(text) as CloudflareEnvelope<unknown>;
  } catch {
    // Non-JSON body (e.g. an edge/gateway HTML page). The body is intentionally
    // not surfaced: it is not the structured envelope and could be noisy.
    return {
      success: res.ok,
      errors: res.ok ? [] : [{ code: 0, message: `Non-JSON response (HTTP ${res.status})` }],
      messages: [],
      result: text,
    };
  }
}

export function createHttpApi(options: ClientOptions): HttpApi {
  const baseUrl = options.baseUrl ?? CLOUDFLARE_API_BASE;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const { accountId, token, onRequest } = options;

  async function send(
    method: string,
    path: string,
    opts: SendOptions = {},
  ): Promise<CloudflareEnvelope<unknown>> {
    const url = buildUrl(baseUrl, path, opts.query);
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${opts.token ?? token}`);
    headers.set("Accept", "application/json");

    let body: RequestInit["body"];
    if (opts.raw !== undefined) {
      headers.set("Content-Type", opts.raw.contentType);
      // Type-only cast: under the DOM lib the body type wants `Uint8Array<ArrayBuffer>`.
      body = opts.raw.body as RequestInit["body"];
    } else if (opts.form !== undefined) {
      // Let fetch set `Content-Type: multipart/form-data; boundary=...`.
      body = opts.form;
    } else if (opts.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(opts.json);
    }

    const res = await fetchImpl(url, { method, headers, body });
    // `path` is already the query-free logical path, so it is safe to log.
    onRequest?.({ method, path, status: res.status });

    const envelope = await parseEnvelope(res);
    if (!res.ok || envelope.success === false) {
      throw new CloudflareApiError({
        status: res.status,
        method,
        path,
        errors: envelope.errors ?? [],
      });
    }
    return envelope;
  }

  async function result<T>(method: string, path: string, opts?: SendOptions): Promise<T> {
    const envelope = await send(method, path, opts);
    return envelope.result as T;
  }

  async function list<T>(
    method: string,
    path: string,
    opts: SendOptions & { perPage?: number } = {},
  ): Promise<T[]> {
    const { perPage = 100, query, ...rest } = opts;
    const acc: T[] = [];
    let page = 1;
    for (;;) {
      const envelope = await send(method, path, {
        ...rest,
        query: { ...query, page, per_page: perPage },
      });
      const rows = (envelope.result ?? []) as T[];
      acc.push(...rows);

      // No result_info means the endpoint returned the complete set in one page
      // (e.g. `GET /workers/scripts`, which ignores paging), so stop. Otherwise
      // page until the reported total_pages is reached.
      const info = envelope.result_info;
      if (info?.total_pages === undefined || page >= info.total_pages) break;
      if (rows.length === 0) break;
      page += 1;
      // Defensive cap; no Cloudflare account has this many pages of these resources.
      if (page > 10_000) break;
    }
    return acc;
  }

  return {
    accountId,
    acct: (suffix: string) => `/accounts/${accountId}${suffix}`,
    send,
    result,
    list,
  };
}
