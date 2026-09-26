import {
  GITHUB_FETCH_HEADERS,
  githubFetchRequestSchema,
  githubTokenSecretNameSchema,
} from "@appflare/schema";
import { z } from "zod";

/**
 * GitHub access tokens held by this Worker as secrets
 * (`GITHUB_TOKEN_<id>`, set by the manager through the Cloudflare API). A
 * request names the secret; the value is read here and sent only to GitHub:
 * as the password of an https clone in a build's checkout, and on the
 * requests `githubFetch` makes for the manager. It is never logged and never
 * returned.
 */

/** The value of the named GitHub access token secret, or null when this Worker does not hold it. */
export function heldGithubToken(env: object, secretName: string): string | null {
  if (!githubTokenSecretNameSchema.safeParse(secretName).success) return null;
  const value = (env as Record<string, unknown>)[secretName];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * `Authorization` for git over https with the token as the password: Basic
 * with the user name `x-access-token`, which GitHub accepts for every kind
 * of token (and ignores; the token decides).
 */
export function gitBasicAuthorization(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

/**
 * The environment that makes git send the token to github.com, and only
 * there, for one command: an `http.<url>.extraHeader` set through git's
 * `GIT_CONFIG_*` variables, so the token is neither on the command line nor
 * in the remote URL, nor written to the checkout's `.git/config`. Prompts
 * are off: a refused token fails the command instead of waiting for input.
 */
export function gitTokenEnv(token: string): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${gitBasicAuthorization(token)}`,
  };
}

/** Everything the log must never show for a token: the value and its Basic form. */
export function tokenRedactions(token: string): string[] {
  return [token, gitBasicAuthorization(token), btoa(`x-access-token:${token}`)];
}

/** A refused `githubFetch` request; its message never contains a token. */
export class GithubFetchError extends Error {
  override name = "GithubFetchError";
}

/**
 * One GET to github.com or api.github.com with the named token: Basic (the
 * token as the password) for github.com, where git's smart HTTP lives, and
 * Bearer for the API. Redirects are returned as they are, never followed, so
 * the token never goes to the host a redirect names (a release asset's
 * storage URL); the caller follows them without it. Throws
 * `GithubFetchError` for a request it refuses or a token it does not hold.
 */
export async function githubFetch(
  env: object,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const parsed = githubFetchRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new GithubFetchError(
      `the GitHub request is not valid: ${z.prettifyError(parsed.error).replace(/\s+/g, " ")}`,
    );
  }
  const request = parsed.data;
  const token = heldGithubToken(env, request.tokenSecret);
  if (token === null) {
    throw new GithubFetchError(
      `the sandbox Worker does not hold the GitHub access token ${request.tokenSecret}`,
    );
  }
  const headers = new Headers();
  for (const name of GITHUB_FETCH_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers.set(name, value);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", "Appflare");
  const host = new URL(request.url).hostname;
  headers.set(
    "authorization",
    host === "api.github.com" ? `Bearer ${token}` : gitBasicAuthorization(token),
  );
  const response = await fetchImpl(request.url, { method: "GET", headers, redirect: "manual" });
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_GITHUB_FETCH_BYTES) {
    await response.body?.cancel();
    throw new GithubFetchError(
      `GitHub answered with ${length} bytes, more than the ${MAX_GITHUB_FETCH_BYTES} the sandbox Worker passes on`,
    );
  }
  const out = new Headers(response.headers);
  out.delete("set-cookie");
  return new Response(
    response.body === null ? null : response.body.pipeThrough(byteLimit(MAX_GITHUB_FETCH_BYTES)),
    { status: response.status, headers: out },
  );
}

/**
 * The most of one GitHub answer `githubFetch` passes on: a ref advertisement
 * or a release list is far smaller, and release assets redirect to their
 * storage host, which the caller reads without the token.
 */
export const MAX_GITHUB_FETCH_BYTES = 8 * 1024 * 1024;

/** A stream that errors once more than `max` bytes went through it. */
export function byteLimit(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        controller.error(
          new GithubFetchError(`GitHub's answer is larger than the ${max} bytes allowed`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
