import {
  CloudflareApiError,
  type CloudflareClient,
  createClient,
  type FetchLike,
} from "@appflare/cf-api";
import { InstallerError } from "./http";
import { logCloudflareRequest } from "./log";

/**
 * The Cloudflare client of one request: the visitor's access token, the
 * request's budgeted fetch, and log lines without names or ids. The token
 * lives in this closure for the length of the request and goes nowhere else.
 */
export function cloudflareFor(
  token: string,
  fetch: FetchLike,
  accountId: string,
): CloudflareClient {
  return createClient({ accountId, token, fetch, onRequest: logCloudflareRequest });
}

/** Error codes Cloudflare answers for a credential it does not accept at all. */
const AUTH_CODES: ReadonlySet<number> = new Set([6003, 9103, 9106, 9109, 10001]);

export type CloudflareFailure =
  /** The token is expired, revoked or not a token: the visitor connects again. */
  | "auth"
  /** The token is fine but may not do this. */
  | "forbidden"
  | "not_found"
  /** Rate limited, a server error, or no answer: try again shortly. */
  | "transient"
  | "other";

export function classifyCloudflareError(error: unknown): CloudflareFailure {
  if (!(error instanceof CloudflareApiError)) {
    // A fetch that threw: the network, not Cloudflare's answer.
    return error instanceof TypeError ? "transient" : "other";
  }
  if (error.status === 401 || error.errors.some((e) => AUTH_CODES.has(e.code))) return "auth";
  if (error.status === 429 || error.status >= 500 || error.status === 0) return "transient";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not_found";
  return "other";
}

export function hasCode(error: unknown, code: number): boolean {
  return error instanceof CloudflareApiError && error.errors.some((e) => e.code === code);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** The Cloudflare error codes of `error`, for a log line (numbers only). */
export function errorCodes(error: unknown): string {
  return error instanceof CloudflareApiError ? error.errors.map((e) => e.code).join(",") : "";
}

export const CONNECT_AGAIN =
  "Cloudflare no longer accepts this sign-in. Connect your Cloudflare account again, then continue.";

/**
 * A Cloudflare failure outside the deploy steps as the API answers it: the
 * deploy page reconnects on `cloudflare_auth` and offers a retry on
 * `cloudflare_unavailable`.
 */
export function cloudflareRequestError(error: unknown, forbidden: string): InstallerError {
  switch (classifyCloudflareError(error)) {
    case "auth":
      return new InstallerError(401, "cloudflare_auth", CONNECT_AGAIN);
    case "forbidden":
      return new InstallerError(403, "cloudflare_forbidden", forbidden);
    case "transient":
      return new InstallerError(
        502,
        "cloudflare_unavailable",
        "Cloudflare did not answer just now. Try again in a moment.",
        5_000,
      );
    default:
      return new InstallerError(
        502,
        "cloudflare_error",
        "Cloudflare could not complete the request. Try again in a moment.",
      );
  }
}
