import { type AccessJwk, type FetchLike, fetchAccessCerts } from "@appflare/cf-api";
import type { AccessKeyLookup } from "./jwt";

/**
 * The Access team's signing keys, cached per isolate. One fetch of
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` serves every
 * request for `ttlMs`. A token signed with a key id the cache does not know
 * triggers a refetch (Access rotates its keys), at most once per
 * `minRefreshMs`, so a flood of made-up key ids cannot turn into a flood of
 * fetches. When a refetch fails, the keys already held stay in use. When the
 * first fetch fails (no keys held), the failure is remembered for
 * `coldFailureMs`, so a cold isolate refuses requests without refetching on
 * every one of them.
 *
 * In-flight fetches are not shared between requests: workerd ties I/O to the
 * request that started it.
 */

export interface AccessKeyStoreOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** How long fetched keys are used before they are fetched again. */
  ttlMs?: number;
  /** Least time between two fetches for the same team. */
  minRefreshMs?: number;
  /** How long a failed first fetch is reused before trying again. */
  coldFailureMs?: number;
}

interface TeamKeys {
  keys: Map<string, CryptoKey>;
  /** When the keys were last fetched successfully. */
  fetchedAt: number;
  /** When a fetch was last attempted, successful or not. */
  attemptedAt: number;
}

export interface AccessKeyStore {
  lookup(teamDomain: string): AccessKeyLookup;
  /** Forgets every cached key (tests, and after protection is turned off). */
  clear(): void;
}

const RSA_VERIFY = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

async function importKeys(jwks: readonly AccessJwk[]): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks) {
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        RSA_VERIFY,
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // A key this runtime cannot import can verify nothing; the others still can.
    }
  }
  return keys;
}

export function createAccessKeyStore(options: AccessKeyStoreOptions = {}): AccessKeyStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  const minRefreshMs = options.minRefreshMs ?? 60 * 1000;
  const coldFailureMs = options.coldFailureMs ?? 10 * 1000;
  const teams = new Map<string, TeamKeys>();
  /** Teams whose first fetch failed, and when. */
  const coldFailures = new Map<string, number>();

  async function refresh(teamDomain: string, held: TeamKeys | undefined): Promise<TeamKeys> {
    const attemptedAt = now();
    try {
      const certs = await fetchAccessCerts(teamDomain, { fetch: options.fetch });
      const entry = { keys: await importKeys(certs.keys), fetchedAt: attemptedAt, attemptedAt };
      teams.set(teamDomain, entry);
      coldFailures.delete(teamDomain);
      return entry;
    } catch (error) {
      if (held === undefined) {
        coldFailures.set(teamDomain, attemptedAt);
        throw error;
      }
      held.attemptedAt = attemptedAt;
      return held;
    }
  }

  return {
    lookup(teamDomain) {
      return async (kid) => {
        let entry = teams.get(teamDomain);
        const failedAt = coldFailures.get(teamDomain);
        if (entry === undefined && failedAt !== undefined && now() - failedAt < coldFailureMs) {
          throw new Error("The Access team's signing keys could not be fetched recently");
        }
        const canRetry = entry === undefined || now() - entry.attemptedAt >= minRefreshMs;
        if (entry === undefined || (now() - entry.fetchedAt >= ttlMs && canRetry)) {
          entry = await refresh(teamDomain, entry);
        }
        const key = entry.keys.get(kid);
        if (key !== undefined) return key;
        if (now() - entry.attemptedAt < minRefreshMs) return null;
        entry = await refresh(teamDomain, entry);
        return entry.keys.get(kid) ?? null;
      };
    },
    clear() {
      teams.clear();
      coldFailures.clear();
    },
  };
}
