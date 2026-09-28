import { z } from "zod";
import { settingsPlace } from "../components/settings-links";

/**
 * GitHub access tokens, the client-safe part: what the "Add token" form
 * sends, the link to GitHub's page for a new fine-grained token, what each
 * token is used for, and the order in which tokens are tried for a
 * repository.
 */

/** Appflare's own repository, whose releases a token may be used to download. */
export const APPFLARE_REPOSITORY = "appflare/appflare";

/** One word of a repositories description: `owner/repo`, `owner/*`, `owner` or `*`. */
const REPOSITORY_PATTERN = /^(?:\*|[a-z0-9][a-z0-9-]{0,38}(?:\/(?:\*|[a-z0-9._-]{1,100}))?)$/;

export const addGithubTokenInput = z
  .object({
    label: z.string().trim().min(1, "Give the token a label.").max(100),
    /**
     * The repositories it covers, as the admin describes them. Optional: it
     * only orders the tokens tried for a build (see {@link storedRepositories}).
     */
    repositories: z
      .string()
      .trim()
      .max(500, "That is a long list. Name the owners instead, as owner/*.")
      .superRefine((text, ctx) => {
        const unreadable = unreadableRepositoryPatterns(text)[0];
        if (unreadable !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `Name repositories as owner/repo, or owner/* for all of an owner's, separated by commas. "${unreadable}" is neither.`,
          });
        }
      })
      .optional(),
    token: z
      .string()
      .trim()
      .min(1, "Paste the token.")
      .max(255, "That is longer than a GitHub token.")
      .regex(/^[A-Za-z0-9_]+$/, "That does not look like a GitHub token."),
    /** Builds of private repositories may use it. */
    forBuilds: z.boolean().default(true),
    /** Appflare reads its own releases with it; any other token marked so is unmarked. */
    forReleases: z.boolean().default(false),
  })
  .refine((input) => input.forBuilds || input.forReleases, {
    message: "Choose what Appflare uses the token for.",
    path: ["forBuilds"],
  });
export type AddGithubTokenInput = z.input<typeof addGithubTokenInput>;

/**
 * The repositories description a new token's record keeps: null when the
 * admin named none, or when the token is not used for builds (the
 * description only orders the tokens tried for a build).
 */
export function storedRepositories(
  input: Pick<z.output<typeof addGithubTokenInput>, "repositories" | "forBuilds">,
): string | null {
  const text = input.repositories?.trim() ?? "";
  return input.forBuilds && text.length > 0 ? text : null;
}

export const githubTokenIdInput = z.object({ id: z.string().min(1).max(64) });

/** A token as the list shows it; never its value. */
export interface GithubTokenView {
  id: string;
  label: string;
  /** The repositories it covers, as the admin describes them; null when none are named. */
  repositories: string | null;
  /** Builds of private repositories may use it. */
  forBuilds: boolean;
  /** Appflare downloads its own releases with it. */
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
export function repositoryPatterns(text: string | null | undefined): string[] {
  // A token's record may name no repositories (null).
  return (text ?? "")
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

/** The words of a description that name no repository, owner or `*`. */
export function unreadableRepositoryPatterns(text: string): string[] {
  return repositoryPatterns(text).filter((pattern) => !REPOSITORY_PATTERN.test(pattern));
}

/** {@link repositoryMatchRank} of a token whose description names no repositories. */
export const ANY_REPOSITORY_RANK = 3;
/** {@link repositoryMatchRank} of a description that names others only: not for `repo`. */
export const NO_MATCH_RANK = 4;

/**
 * How closely a token's description names `repo` (`owner/repo`); lower comes
 * first: the repository itself, its owner (`owner/*` or `owner`), `*`, then
 * a description that names none (the token is for any repository). A
 * description that names only other repositories gets {@link NO_MATCH_RANK}.
 */
export function repositoryMatchRank(text: string | null, repo: string): number {
  const wanted = repo.toLowerCase();
  const owner = wanted.split("/")[0] ?? "";
  const patterns = repositoryPatterns(text);
  if (patterns.length === 0) return ANY_REPOSITORY_RANK;
  let rank = NO_MATCH_RANK;
  for (const pattern of patterns) {
    if (pattern === wanted) return 0;
    if (pattern === `${owner}/*` || pattern === owner) rank = Math.min(rank, 1);
    else if (pattern === "*" || pattern === "all") rank = Math.min(rank, 2);
  }
  return rank;
}

/**
 * The tokens tried for a build of `repo`, in order. Only those used for
 * builds, and of those only the ones for `repo`: a token that names
 * repositories is used for those alone, one that names none for any. The
 * most specific first (the repository itself, its owner, `*`, then the
 * tokens for any repository), oldest first within each.
 */
export function orderTokensFor<
  T extends { repositories: string | null; forBuilds: boolean; createdAt: number },
>(tokens: readonly T[], repo: string): T[] {
  return tokens
    .filter((token) => token.forBuilds)
    .map((token, index) => ({ token, index, rank: repositoryMatchRank(token.repositories, repo) }))
    .filter((entry) => entry.rank < NO_MATCH_RANK)
    .sort((a, b) => a.rank - b.rank || a.token.createdAt - b.token.createdAt || a.index - b.index)
    .map((entry) => entry.token);
}

/** The help under the form's "Appflare release downloads" choice. */
export const RELEASE_DOWNLOADS_HELP = `While Appflare's own repository on GitHub is private, updating Appflare needs a token that can read its releases. Such a token needs only read-only access to the contents of ${APPFLARE_REPOSITORY}; once that repository is public, no token is needed for this.`;

/** The help under the form's optional repositories field. */
export const REPOSITORIES_HELP =
  "Leave it empty to use the token for any private repository; name repositories to use it only for those: acme/api, or acme/* for all of an owner's.";

/**
 * What a token is used for, in plain words, one entry per use; "Not used"
 * for a token that lost its only use (release downloads moved to another).
 */
export function githubTokenUses(
  token: Pick<GithubTokenView, "repositories" | "forBuilds" | "forReleases">,
): string[] {
  const uses: string[] = [];
  if (token.forBuilds) {
    const named = repositoryPatterns(token.repositories);
    uses.push(
      named.length === 0 ? "Builds of any private repository" : `Builds of ${named.join(", ")}`,
    );
  }
  if (token.forReleases) uses.push("Appflare release downloads");
  return uses.length === 0 ? ["Not used"] : uses;
}

/**
 * The note under "Appflare release downloads" when another token has that
 * use now: it moves to the new token, and a token left with no use is said
 * to be so.
 */
export function releaseTakeoverNote(current: Pick<GithubTokenView, "label" | "forBuilds">): string {
  const moved = `"${current.label}" is used for this now. Only one token can be, so ticking it here moves it to this one.`;
  return current.forBuilds
    ? moved
    : `${moved} "${current.label}" will then be used for nothing; you can delete it.`;
}

/** What deleting a token does, for its confirmation. */
export function deleteTokenDescription(
  token: Pick<GithubTokenView, "forBuilds" | "forReleases">,
): string {
  const parts = ["Appflare deletes the token from the sandbox Worker."];
  if (token.forBuilds) {
    parts.push(
      "Apps already installed keep running, but a private repository no other token can read cannot be rebuilt.",
    );
  }
  if (token.forReleases) {
    parts.push(
      "Appflare then downloads its own releases without it, with the GitHub token Appflare was installed with, if there is one.",
    );
  }
  parts.push("Revoke the token on GitHub as well.");
  return parts.join(" ");
}

/**
 * GitHub's new fine-grained token page, filled in: a name, a description,
 * Contents read-only (GitHub adds Metadata read-only itself), and the owner
 * of the first repository described, or Appflare's own for a token only for
 * release downloads. The admin still picks the repositories there.
 */
export function newTokenUrl(
  label: string,
  repositories: string,
  uses: { forBuilds: boolean; forReleases: boolean } = { forBuilds: true, forReleases: false },
): string {
  const url = new URL(NEW_FINE_GRAINED_TOKEN_URL);
  url.searchParams.set("name", (label.trim() || "Appflare").slice(0, 40));
  const releasesOnly = uses.forReleases && !uses.forBuilds;
  url.searchParams.set(
    "description",
    releasesOnly
      ? "Appflare: read-only access to download its releases"
      : "Appflare: read-only access to build private repositories",
  );
  const named = releasesOnly
    ? [APPFLARE_REPOSITORY]
    : uses.forBuilds
      ? repositoryPatterns(repositories)
      : [];
  const owner = named
    .map((pattern) => pattern.split("/")[0] ?? "")
    .find((name) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(name));
  if (owner !== undefined) url.searchParams.set("target_name", owner);
  url.searchParams.set("contents", "read");
  url.searchParams.set("metadata", "read");
  return url.toString();
}
