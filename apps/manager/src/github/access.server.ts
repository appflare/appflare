import type { FetchLike } from "@appflare/cf-api";
import { githubTokenSecretName } from "@appflare/schema";
import { GitRefError, listRemoteRefs, type RemoteRefs } from "../installs/git-refs";
import { type SandboxBuildsBinding, sandboxBinding, sandboxGithubFetch } from "../sandbox/binding";
import { GITHUB_ACCESS_PLACE, orderTokensFor } from "./tokens";
import {
  addedJustNow,
  justAddedMessage,
  markGithubTokenUsed,
  readGithubTokens,
} from "./tokens.server";

/**
 * Reading GitHub with the admin's GitHub access tokens. The manager never
 * holds a token's value: requests that need one go through the sandbox
 * Worker (`githubFetch`), naming the token's secret there.
 */

/** A token that was used, by id and label (never its value). */
export interface UsedGithubToken {
  id: string;
  label: string;
}

/** A repository's branches and tags, and the token that read them (null: public). */
export interface AccessedRefs extends RemoteRefs {
  token: UsedGithubToken | null;
}

export interface RepositoryReader {
  db: D1Database;
  /** The manager's own fetch, which carries no token. */
  fetch: FetchLike;
  /** The `SANDBOX` binding, where the tokens are; absent when sandbox builds are off. */
  sandbox?: SandboxBuildsBinding | undefined;
  now?: () => Date;
}

/**
 * The branches and tags of `repo`, as a public repository first (no token
 * spent on a public repository), and when GitHub refuses that, with each
 * GitHub access token for builds of `repo` in turn: those whose repositories
 * name it first, then its owner's, then `*`, then those naming none (for any
 * repository). A token that names only other repositories, or is only for
 * release downloads, is never tried. The token that worked is returned (the
 * build clones with the same one) and its last use recorded. Throws
 * `GitRefError`.
 */
export async function readRepositoryRefs(
  reader: RepositoryReader,
  repo: string,
): Promise<AccessedRefs> {
  let refusal: GitRefError;
  try {
    return { ...(await listRemoteRefs(reader.fetch, repo)), token: null };
  } catch (error) {
    if (!(error instanceof GitRefError) || !error.refused) throw error;
    refusal = error;
  }
  // Only the tokens for builds of this repository: one that names other
  // repositories, or is only for release downloads, is never sent for it.
  const all = await readGithubTokens(reader.db);
  const tokens = orderTokensFor(all, repo);
  if (tokens.length === 0) {
    const others = all.some((token) => token.forBuilds)
      ? ` None of the GitHub access tokens is for ${repo}.`
      : "";
    throw new GitRefError(
      `${refusal.message}${others} To build a private repository, add a GitHub access token that can read it in ${GITHUB_ACCESS_PLACE}.`,
      true,
    );
  }
  if (reader.sandbox === undefined) {
    throw new GitRefError(
      `${refusal.message} The GitHub access tokens are kept on the sandbox Worker, and sandbox builds are off.`,
      true,
    );
  }
  const now = (reader.now ?? (() => new Date()))();
  let unreachable: string | null = null;
  /** A token added a moment ago that the answering sandbox Worker version does not hold yet. */
  let notYetHeld: string | null = null;
  for (const token of tokens) {
    try {
      const refs = await listRemoteRefs(
        sandboxGithubFetch(reader.sandbox, githubTokenSecretName(token.id)),
        repo,
      );
      await markGithubTokenUsed(reader.db, token.id, now);
      return { ...refs, token: { id: token.id, label: token.label } };
    } catch (error) {
      if (error instanceof GitRefError && error.refused) continue;
      // A token GitHub never saw (the sandbox Worker lost it, or did not
      // answer): try the next one, and say so if none works.
      unreachable = error instanceof Error ? error.message : String(error);
      if (unreachable.includes("does not hold") && addedJustNow(token, now)) {
        notYetHeld = token.label;
      }
    }
  }
  if (notYetHeld !== null) {
    const message = justAddedMessage(notYetHeld);
    throw new GitRefError(`${message[0]?.toUpperCase() ?? ""}${message.slice(1)}.`, true);
  }
  const tried =
    tokens.length === 1
      ? `the GitHub access token in ${GITHUB_ACCESS_PLACE} cannot read it`
      : `none of the ${tokens.length} GitHub access tokens in ${GITHUB_ACCESS_PLACE} can read it`;
  throw new GitRefError(
    `${repo} was not found on GitHub, or ${tried}.${unreachable === null ? "" : ` Last problem: ${unreachable}.`}`,
    true,
  );
}

/**
 * The manager's own reader of a repository: its fetch, and the sandbox
 * Worker's for the tokens.
 */
export function repositoryReader(env: { DB: D1Database; SANDBOX?: unknown }): RepositoryReader {
  return {
    db: env.DB,
    fetch: (input, init) => fetch(input, init),
    sandbox: sandboxBinding(env),
  };
}
