import type { FetchLike } from "@appflare/cf-api";

/**
 * GETs that follow redirects one hop at a time, so every hop is one counted
 * subrequest (budget.ts), only ever to https, and never carrying a
 * credential: release files are public.
 */

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** A release host that answered badly; `retryable` for 429, 5xx and no answer. */
export class ReleaseFetchError extends Error {
  override name = "ReleaseFetchError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Why a release cannot be deployed:
 * - `missing`: GitHub names no Appflare release as the latest one;
 * - `signature`: `manifest.sig` does not verify with an Appflare key;
 * - `manifest`: the signed manifest is not a valid Appflare release manifest;
 * - `format`: the manifest is of a format this installer does not read;
 * - `files`: a file's bytes are not what the signed manifest says;
 * - `unsupported`, `too-old`: valid, but not one this installer deploys.
 */
export type ReleaseProblem =
  | "missing"
  | "signature"
  | "manifest"
  | "format"
  | "files"
  | "unsupported"
  | "too-old";

/** A release that cannot be deployed; `kind` says why (the message is for logs only). */
export class ReleaseError extends Error {
  override name = "ReleaseError";
  constructor(
    readonly kind: ReleaseProblem,
    message: string,
  ) {
    super(message);
  }
}

export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "the release host";
  }
}

export interface FollowedResponse {
  response: Response;
  /** The URL that answered (after redirects). */
  url: string;
}

/** GET `url`, following redirects by hand. The caller reads or cancels the body. */
export async function followGet(
  fetch: FetchLike,
  url: string,
  headers: Record<string, string> = {},
): Promise<FollowedResponse> {
  let current = url;
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "appflare-installer", ...headers },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "BudgetExceededError") throw error;
      throw new ReleaseFetchError(`GET ${describeUrl(current)} failed`, true);
    }
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return { response, url: current };
    }
    await response.body?.cancel();
    const next = new URL(location, current);
    if (hop >= MAX_REDIRECTS || next.protocol !== "https:") {
      throw new ReleaseFetchError(
        `GET ${describeUrl(url)}: redirected too often or not to https`,
        false,
      );
    }
    current = next.toString();
  }
}

/** A whole small file (`manifest.json`, `manifest.sig`). */
export async function fetchWhole(fetch: FetchLike, url: string): Promise<Uint8Array> {
  const { response, url: at } = await followGet(fetch, url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReleaseFetchError(
      `GET ${describeUrl(at)} -> ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
