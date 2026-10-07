import {
  CLOUDFLARE_OAUTH_REVOKE_URL,
  CLOUDFLARE_OAUTH_TOKEN_URL,
  type FetchLike,
} from "@appflare/cf-api";
import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";

/**
 * Test-only stand-in for Cloudflare's OAuth token and revocation endpoints,
 * in front of another fake (the REST API). Every refresh rotates the refresh
 * token and issues a new access token, both distinctive enough that a test
 * can look for them in logs, settings and errors. `next` queues special
 * answers for the coming refreshes (a 503, `invalid_grant`, no new refresh
 * token, a network failure, a wait); afterwards refreshes succeed again.
 */

export type RefreshAnswer =
  | "rotate"
  /** A success without `refresh_token`: the one sent stays valid. */
  | "keep-refresh-token"
  | "invalid_grant"
  | "invalid_client"
  | { status: number }
  | "network-error"
  /** A 200 whose body is not a token response. */
  | "malformed"
  /** Waits for `release()` before answering with a rotation. */
  | "hold";

export interface RefreshCall {
  clientId: string;
  refreshToken: string;
}

export interface FakeOAuth {
  fetch: FetchLike;
  refreshes: RefreshCall[];
  revokes: RefreshCall[];
  /** Answers for the next refreshes, in order. */
  next: RefreshAnswer[];
  /** Answers every refresh held by `"hold"`. */
  release(): void;
  /** Resolves once a held refresh is waiting. */
  held(): Promise<void>;
  /** Every token value this fake issued (to look for leaks). */
  issued: string[];
}

/** Access tokens this fake issues last this long. */
export const FAKE_ACCESS_TTL_S = 3600;

export function fakeOAuth(
  api: FetchLike,
  options: { scopes?: readonly string[]; prefix?: string } = {},
): FakeOAuth {
  const prefix = options.prefix ?? "SECRET";
  const refreshes: RefreshCall[] = [];
  const revokes: RefreshCall[] = [];
  const issued: string[] = [];
  const next: RefreshAnswer[] = [];
  let count = 0;
  let releaseHeld: (() => void) | null = null;
  let heldWaiter: (() => void) | null = null;
  const holdGate = () =>
    new Promise<void>((resolve) => {
      releaseHeld = resolve;
      heldWaiter?.();
    });

  const tokenResponse = (refresh: boolean) => {
    count += 1;
    const access = `cf-access-${prefix}-${count}`;
    issued.push(access);
    const body: Record<string, unknown> = {
      access_token: access,
      expires_in: FAKE_ACCESS_TTL_S,
      token_type: "bearer",
      scope: (options.scopes ?? MANAGER_OAUTH_SCOPES).join(" "),
    };
    if (refresh) {
      const rotated = `cf-refresh-${prefix}-${count}`;
      issued.push(rotated);
      body.refresh_token = rotated;
    }
    return Response.json(body);
  };

  const fetch: FetchLike = async (input, init) => {
    if (input === CLOUDFLARE_OAUTH_TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      refreshes.push({
        clientId: form.get("client_id") ?? "",
        refreshToken: form.get("refresh_token") ?? "",
      });
      const answer = next.shift() ?? "rotate";
      if (answer === "network-error") throw new TypeError("fetch failed");
      if (answer === "malformed") return Response.json({ unexpected: true });
      if (answer === "hold") {
        await holdGate();
        return tokenResponse(true);
      }
      if (answer === "invalid_grant" || answer === "invalid_client") {
        return Response.json(
          { error: answer, error_description: "The refresh token is invalid." },
          { status: answer === "invalid_grant" ? 400 : 401 },
        );
      }
      if (typeof answer === "object") return new Response("upstream down", answer);
      return tokenResponse(answer === "rotate");
    }
    if (input === CLOUDFLARE_OAUTH_REVOKE_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      revokes.push({
        clientId: form.get("client_id") ?? "",
        refreshToken: form.get("token") ?? "",
      });
      return new Response(null, { status: 200 });
    }
    return api(input, init);
  };

  return {
    fetch,
    refreshes,
    revokes,
    next,
    issued,
    release() {
      releaseHeld?.();
      releaseHeld = null;
    },
    held() {
      return new Promise<void>((resolve) => {
        if (releaseHeld !== null) resolve();
        else heldWaiter = resolve;
      });
    },
  };
}
