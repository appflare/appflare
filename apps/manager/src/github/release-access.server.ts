import type { FetchLike } from "@appflare/cf-api";
import { githubTokenSecretName } from "@appflare/schema";
import { eq } from "drizzle-orm";
import type { ReleaseFetchOptions } from "../catalog/release-fetch";
import { createDb } from "../db/client";
import { github_tokens } from "../db/schema";
import { sandboxBinding, sandboxGithubFetch } from "../sandbox/binding";

/**
 * Release downloads with the GitHub access token marked for them: the
 * sandbox Worker holds it and makes the requests to GitHub for the manager,
 * for Appflare's own repository only (see `releaseFetch`). The manager's
 * `GITHUB_TOKEN` secret stays the fallback.
 */

/**
 * The secret of the GitHub access token marked for release downloads, when
 * there is one and the sandbox Worker that holds it is connected. Null means
 * the release requests use `GITHUB_TOKEN`, if the manager has it, or no token.
 */
export async function releaseTokenSecret(env: {
  DB?: D1Database;
  SANDBOX?: unknown;
}): Promise<string | null> {
  if (env.DB === undefined || sandboxBinding(env) === undefined) return null;
  const [row] = await createDb(env.DB)
    .select({ id: github_tokens.id })
    .from(github_tokens)
    .where(eq(github_tokens.for_releases, true))
    .limit(1);
  return row === undefined ? null : githubTokenSecretName(row.id);
}

const SECRET_PREFIX = githubTokenSecretName("");

/**
 * The release fetch's token options: the marked token through the sandbox
 * Worker when `tokenSecret` is set and the binding is there, else the
 * manager's `GITHUB_TOKEN` (the fallback). `count` wraps the sandbox call so
 * a job unit counts it among its subrequests. With `DB`, the token's last
 * use is recorded after its first request that GitHub answered without an
 * error (once per options object, so a job's many reads write once).
 */
export function releaseTokenOptions(
  env: { GITHUB_TOKEN?: string; SANDBOX?: unknown; DB?: D1Database },
  tokenSecret: string | null | undefined,
  count: (fetch: FetchLike) => FetchLike = (f) => f,
  now: () => Date = () => new Date(),
): Pick<ReleaseFetchOptions, "token" | "github"> {
  const binding = sandboxBinding(env);
  if (tokenSecret == null || binding === undefined) return { token: env.GITHUB_TOKEN };
  const proxied = count(sandboxGithubFetch(binding, tokenSecret));
  const db = env.DB;
  if (db === undefined || !tokenSecret.startsWith(SECRET_PREFIX)) return { github: proxied };
  const id = tokenSecret.slice(SECRET_PREFIX.length);
  let recorded = false;
  return {
    github: async (input, init) => {
      const response = await proxied(input, init);
      if (!recorded && response.status < 400) {
        recorded = true;
        await createDb(db)
          .update(github_tokens)
          .set({ last_used_at: now() })
          .where(eq(github_tokens.id, id));
      }
      return response;
    },
  };
}
