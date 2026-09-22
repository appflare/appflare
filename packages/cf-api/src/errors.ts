/**
 * A single error object from Cloudflare's response envelope
 * (`{ success, errors, messages, result }`). Carried verbatim on
 * {@link CloudflareApiError.errors} so callers can branch on `code`.
 */
export interface CloudflareError {
  code: number;
  message: string;
  /** Present on some endpoints; nested cause chain. Kept verbatim. */
  error_chain?: CloudflareError[];
}

export interface CloudflareApiErrorInit {
  status: number;
  method: string;
  /** Path only, already stripped of the API base and of any query string. */
  path: string;
  errors: CloudflareError[];
}

/**
 * Thrown for any non-2xx response or any envelope with `success: false`.
 *
 * The `message` is built only from the HTTP method, the (query-free) path, the
 * status code, and Cloudflare's own `errors[]` descriptions. It never contains
 * the bearer token or the request body — script uploads and `putSecret` bodies
 * carry secret values, so bodies are never serialized into the message or logged.
 */
export class CloudflareApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** Cloudflare's `errors[]`, verbatim (`{ code, message }`). */
  readonly errors: CloudflareError[];

  constructor(init: CloudflareApiErrorInit) {
    super(formatMessage(init));
    this.name = "CloudflareApiError";
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.errors = init.errors;
  }
}

function formatMessage({ status, method, path, errors }: CloudflareApiErrorInit): string {
  const head = `Cloudflare API request failed: ${method} ${path} -> ${status}`;
  if (errors.length === 0) {
    return head;
  }
  const detail = errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
  return `${head}: ${detail}`;
}
