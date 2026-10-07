import { CloudflareOAuthError, refreshGrant } from "@appflare/cf-api/oauth";
import type { FetchLike } from "./installer-api.ts";
import type { Grant, Slot } from "./storage.ts";

/**
 * The Cloudflare grant this tab holds, in memory and in sessionStorage.
 *
 * The access token is renewed here, in the browser, at Cloudflare's token
 * endpoint (which answers this page's origin), once it has less than
 * {@link RENEW_BEFORE_MS} left, so a long deploy never stops on an expired
 * token. Cloudflare rotates the refresh token on every renewal; the new one
 * is kept before the access token is used, so the grant handed to the new
 * Appflare is always the newest. Once Appflare has it, the tab forgets it.
 */

/** Renew when less than this is left. */
export const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** Cloudflare no longer accepts the grant, or this tab has none: sign in again. */
export class AuthorizationNeeded extends Error {
  override name = "AuthorizationNeeded";
  constructor() {
    super("Cloudflare needs to be connected again.");
  }
}

export interface TokenKeeperOptions {
  slot: Slot<Grant>;
  fetch?: FetchLike;
  now?: () => number;
}

export class TokenKeeper {
  private current: Grant | null;
  private renewing: Promise<Grant> | null = null;
  /** Handoffs in progress; while any is, renewals do not rotate the grant. */
  private holding = 0;
  private readonly slot: Slot<Grant>;
  private readonly fetch: FetchLike | undefined;
  private readonly now: () => number;

  constructor(options: TokenKeeperOptions) {
    this.slot = options.slot;
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
    this.current = this.slot.read();
  }

  /** The grant held now, or null. */
  grant(): Grant | null {
    return this.current;
  }

  /** Keeps a new grant (from the callback, or a renewal). */
  keep(grant: Grant): void {
    this.current = grant;
    this.slot.write(grant);
  }

  /** Drops the grant: after the handoff, or when Cloudflare refused it. */
  forget(): void {
    this.current = null;
    this.renewing = null;
    this.slot.clear();
  }

  /** A usable access token, renewed first when it is close to expiring. */
  async accessToken(): Promise<string> {
    const grant = this.current;
    if (grant === null) throw new AuthorizationNeeded();
    if (grant.expiresAt - this.now() > RENEW_BEFORE_MS) return grant.accessToken;
    return (await this.renew()).accessToken;
  }

  /**
   * Runs `send` with the newest grant, for the handoff: first lets any renewal
   * in progress finish (its rotated refresh token replaces the one it sent),
   * then holds renewals back until `send` settles, so the refresh token handed
   * over is never one a renewal is replacing.
   */
  async handOver<T>(send: (grant: Grant) => Promise<T>): Promise<T> {
    while (this.renewing !== null) await this.renewing.catch(() => undefined);
    const grant = this.current;
    if (grant === null) throw new AuthorizationNeeded();
    this.holding++;
    try {
      return await send(grant);
    } finally {
      this.holding--;
    }
  }

  /** Renews the access token now; concurrent callers share one renewal. */
  renew(): Promise<Grant> {
    if (this.renewing !== null) return this.renewing;
    const grant = this.current;
    if (grant === null) return Promise.reject(new AuthorizationNeeded());
    // A handoff is sending this refresh token: keep the access token it goes with.
    if (this.holding > 0) {
      return grant.expiresAt > this.now()
        ? Promise.resolve(grant)
        : Promise.reject(new AuthorizationNeeded());
    }
    const run = (async () => {
      try {
        const tokens = await refreshGrant({
          clientId: grant.clientId,
          refreshToken: grant.refreshToken,
          now: this.now,
          ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
        });
        const next: Grant = {
          clientId: grant.clientId,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          refreshToken: tokens.refreshToken,
          scopes: tokens.scopes ?? grant.scopes,
        };
        // Forgotten meanwhile (handed off): keep nothing.
        if (this.current === grant) this.keep(next);
        return next;
      } catch (error) {
        if (error instanceof CloudflareOAuthError && error.reconnectNeeded) {
          if (this.current === grant) this.forget();
          throw new AuthorizationNeeded();
        }
        // Still valid for a while: a failed early renewal is not fatal.
        if (grant.expiresAt > this.now()) return grant;
        throw error;
      } finally {
        this.renewing = null;
      }
    })();
    this.renewing = run;
    return run;
  }
}
