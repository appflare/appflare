import { z } from "zod";
import { SANDBOX_PROTOCOL_VERSION } from "./sandbox";

/**
 * GitHub access tokens: fine-grained, read-only tokens an admin adds so the
 * manager can build private repositories (and, optionally, read Appflare's
 * own releases while they are not public).
 *
 * Custody: each token is a secret on the sandbox Worker, named by
 * {@link githubTokenSecretName}. The manager records only the token's id,
 * label and the repositories the admin says it covers; requests to the
 * sandbox Worker name the secret, and the sandbox Worker reads the value from
 * its own environment. The value never crosses RPC, never reaches the
 * manager's database, and is never shown again.
 */

/** The `info().features` entry of a sandbox Worker that uses GitHub access tokens. */
export const SANDBOX_FEATURE_GITHUB_TOKENS = "github-tokens";

/** A token's id (a ULID): upper-case letters and digits, part of its secret's name. */
export const githubTokenIdSchema = z
  .string()
  .regex(/^[0-9A-Z]{10,32}$/, "must be 10-32 upper-case letters or digits");

const SECRET_PREFIX = "GITHUB_TOKEN_";

/** The sandbox Worker secret that holds a GitHub access token. */
export function githubTokenSecretName(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

/**
 * The name of a GitHub access token's secret, as requests carry it. Only
 * these names: a request can never make the sandbox Worker send another of
 * its secrets (an app's token) to GitHub.
 */
export const githubTokenSecretNameSchema = z
  .string()
  .regex(/^GITHUB_TOKEN_[0-9A-Z]{10,32}$/, "must name a GitHub access token secret");

/** Hosts the sandbox Worker sends a GitHub access token to. */
export const GITHUB_TOKEN_HOSTS: readonly string[] = ["github.com", "api.github.com"];

/** Whether `url` is an https URL on one of {@link GITHUB_TOKEN_HOSTS}. */
export function isGithubTokenUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      GITHUB_TOKEN_HOSTS.includes(u.hostname) &&
      u.username === "" &&
      u.password === "" &&
      u.port === ""
    );
  } catch {
    return false;
  }
}

/**
 * `SandboxBuilds.githubFetch()` input: one GET to GitHub with the named
 * token. The answer is GitHub's response as it is, redirects included (the
 * caller follows them, so the token never reaches the host a redirect names).
 */
export const githubFetchRequestSchema = z.object({
  protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
  url: z
    .string()
    .max(2048)
    .refine(isGithubTokenUrl, "must be an https URL on github.com or api.github.com"),
  tokenSecret: githubTokenSecretNameSchema,
  /** The request headers GitHub needs; nothing else is passed on. */
  headers: z
    .object({
      accept: z.string().max(200).optional(),
      range: z.string().max(200).optional(),
      "user-agent": z.string().max(200).optional(),
      "if-none-match": z.string().max(200).optional(),
      "x-github-api-version": z.string().max(40).optional(),
    })
    .default({}),
});
export type GithubFetchRequest = z.input<typeof githubFetchRequestSchema>;

/** Header names {@link githubFetchRequestSchema} passes on. */
export const GITHUB_FETCH_HEADERS = [
  "accept",
  "range",
  "user-agent",
  "if-none-match",
  "x-github-api-version",
] as const;
