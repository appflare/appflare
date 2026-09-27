import { z } from "zod";
import { settingsPlace } from "../components/settings-links";

/**
 * GitHub access tokens, the client-safe part: what the "Add token" form
 * sends, the link to GitHub's page for a new fine-grained token, and the
 * order in which tokens are tried for a repository.
 */

export const addGithubTokenInput = z.object({
  label: z.string().trim().min(1, "Give the token a label.").max(100),
  /** The repositories it covers, as the admin describes them. */
  repositories: z.string().trim().min(1, "Say which repositories it covers.").max(500),
  token: z
    .string()
    .trim()
    .min(1, "Paste the token.")
    .max(255, "That is longer than a GitHub token.")
    .regex(/^[A-Za-z0-9_]+$/, "That does not look like a GitHub token."),
  /** Appflare reads its own releases with it; any other token marked so is unmarked. */
  forReleases: z.boolean().default(false),
});
export type AddGithubTokenInput = z.input<typeof addGithubTokenInput>;

export const githubTokenIdInput = z.object({ id: z.string().min(1).max(64) });

/** A token as the list shows it; never its value. */
export interface GithubTokenView {
  id: string;
  label: string;
  repositories: string;
  forReleases: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601; null until a build, a check or a release download used it. */
  lastUsedAt: string | null;
}

/** Where the GitHub access tokens are listed and added in the manager, as a link inside a message. */
export const GITHUB_ACCESS_PLACE = settingsPlace("building", "github-access");

/** GitHub's page for a new fine-grained personal access token. */
export const NEW_FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * The words of a repositories description, normalised: `owner/repo`,
 * `owner/*`, `owner` or `*`, lower case, with any `https://github.com/`
 * prefix, `.git` suffix and trailing slash dropped.
 */
export function repositoryPatterns(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((word) =>
      word
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^(www\.)?github\.com\//, "")
        .replace(/\/+$/, "")
        .replace(/\.git$/, ""),
    )
    .filter((word) => word.length > 0);
}

/** How closely a token's description names `repo` (`owner/repo`); lower comes first. */
export function repositoryMatchRank(text: string, repo: string): number {
  const wanted = repo.toLowerCase();
  const owner = wanted.split("/")[0] ?? "";
  let rank = 3;
  for (const pattern of repositoryPatterns(text)) {
    if (pattern === wanted) return 0;
    if (pattern === `${owner}/*` || pattern === owner) rank = Math.min(rank, 1);
    else if (pattern === "*" || pattern === "all") rank = Math.min(rank, 2);
  }
  return rank;
}

/**
 * The order tokens are tried for `repo`: the ones whose description names
 * the repository first, then those naming its owner (`owner/*` or `owner`),
 * then `*`, then the others; oldest first within each.
 */
export function orderTokensFor<T extends { repositories: string; createdAt: number }>(
  tokens: readonly T[],
  repo: string,
): T[] {
  return tokens
    .map((token, index) => ({ token, index, rank: repositoryMatchRank(token.repositories, repo) }))
    .sort((a, b) => a.rank - b.rank || a.token.createdAt - b.token.createdAt || a.index - b.index)
    .map((entry) => entry.token);
}

/**
 * GitHub's new fine-grained token page, filled in: a name, a description,
 * Contents read-only (GitHub adds Metadata read-only itself), and the owner
 * of the first repository described, when there is one. The admin still
 * picks the repositories there.
 */
export function newTokenUrl(label: string, repositories: string): string {
  const url = new URL(NEW_FINE_GRAINED_TOKEN_URL);
  url.searchParams.set("name", (label.trim() || "Appflare").slice(0, 40));
  url.searchParams.set("description", "Appflare: read-only access to build private repositories");
  const owner = repositoryPatterns(repositories)
    .map((pattern) => pattern.split("/")[0] ?? "")
    .find((name) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(name));
  if (owner !== undefined) url.searchParams.set("target_name", owner);
  url.searchParams.set("contents", "read");
  url.searchParams.set("metadata", "read");
  return url.toString();
}
