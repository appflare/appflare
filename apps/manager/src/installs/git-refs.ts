import type { FetchLike } from "@appflare/cf-api";
import { isCommitSha } from "@appflare/schema";

/**
 * The branches and tags of a public GitHub repository, read the way `git
 * ls-remote` reads them: one GET of the smart HTTP ref advertisement
 * (`<repo>.git/info/refs?service=git-upload-pack`). No GitHub API call, so
 * no API rate limit and no token; a private or missing repository answers
 * 401 or 404. The manager uses it to check a ref before a build and to see
 * whether a branch has moved ("Check for changes").
 */

/** Ref names (`refs/heads/main`, `refs/tags/v1.0.0`, `refs/tags/v1.0.0^{}`) to commits. */
export interface RemoteRefs {
  refs: Map<string, string>;
  /** The branch HEAD points at (`refs/heads/main`), when the server says. */
  head: string | null;
}

/** The repository could not be read, or has no such branch or tag. */
export class GitRefError extends Error {
  override name = "GitRefError";
}

/** The most of an advertisement the manager reads (a repository with very many tags). */
const MAX_ADVERTISEMENT_BYTES = 8 * 1024 * 1024;

/** Parses a smart HTTP ref advertisement (pkt-lines). Throws `GitRefError` on anything else. */
export function parseAdvertisement(body: string): RemoteRefs {
  const refs = new Map<string, string>();
  let head: string | null = null;
  let offset = 0;
  let sawService = false;
  while (offset < body.length) {
    const size = Number.parseInt(body.slice(offset, offset + 4), 16);
    if (Number.isNaN(size) || !/^[0-9a-f]{4}$/i.test(body.slice(offset, offset + 4))) {
      throw new GitRefError("GitHub answered with something that is not a list of refs");
    }
    if (size === 0) {
      offset += 4;
      continue;
    }
    if (size < 4) throw new GitRefError("GitHub's list of refs is malformed");
    const line = body.slice(offset + 4, offset + size).replace(/\n$/, "");
    offset += size;
    if (line.startsWith("# service=")) {
      sawService = true;
      continue;
    }
    const [refPart, capabilities] = line.split("\0");
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(refPart ?? "");
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const symref = /(?:^| )symref=HEAD:(\S+)/.exec(capabilities ?? "")?.[1];
    if (symref !== undefined) head = symref;
    // An empty repository advertises only "capabilities^{}" with a zero id.
    if (match[2] !== "capabilities^{}") refs.set(match[2], match[1]);
  }
  if (!sawService && refs.size === 0) {
    throw new GitRefError("GitHub answered with something that is not a list of refs");
  }
  return { refs, head };
}

/** Where a branch, tag or commit points, and the name it is recorded under. */
export interface ResolvedRef {
  commit: string;
  /** The branch or tag name (the default branch's when none was asked for), or the commit. */
  ref: string;
  kind: "branch" | "tag" | "commit";
}

/**
 * Resolves `ref` against the advertisement, as `git clone --branch` does
 * (a branch first, then a tag, peeled to its commit). Null means the default
 * branch. A full commit SHA is taken as it is: whether the repository has it
 * shows when the build fetches it.
 */
export function resolveRef(remote: RemoteRefs, ref: string | null, repo: string): ResolvedRef {
  if (ref !== null && isCommitSha(ref)) return { commit: ref, ref, kind: "commit" };
  if (ref === null) {
    const target = remote.head;
    const commit =
      remote.refs.get("HEAD") ?? (target === null ? undefined : remote.refs.get(target));
    if (commit === undefined) {
      throw new GitRefError(`${repo} has no commits on its default branch`);
    }
    return {
      commit,
      ref: target?.replace(/^refs\/heads\//, "") ?? commit,
      kind: target === null ? "commit" : "branch",
    };
  }
  const branch = remote.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return { commit: branch, ref, kind: "branch" };
  const tag = remote.refs.get(`refs/tags/${ref}^{}`) ?? remote.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return { commit: tag, ref, kind: "tag" };
  throw new GitRefError(`${repo} has no branch or tag named ${ref}`);
}

/** The ref advertisement URL of a GitHub repository. */
export function advertisementUrl(repo: string): string {
  return `https://github.com/${repo}.git/info/refs?service=git-upload-pack`;
}

/** Reads the branches and tags of `repo` (`owner/repo`). Throws `GitRefError`. */
export async function listRemoteRefs(fetchImpl: FetchLike, repo: string): Promise<RemoteRefs> {
  let response: Response;
  try {
    response = await fetchImpl(advertisementUrl(repo), {
      headers: { "user-agent": "git/2.45.0 (Appflare)", accept: "*/*" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GitRefError(
      `GitHub could not be reached to read ${repo} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    throw new GitRefError(
      `${repo} was not found on GitHub, or is not public. Appflare builds public repositories only.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitRefError(`GitHub answered HTTP ${response.status} for ${repo}; try again later`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_ADVERTISEMENT_BYTES) {
    await response.body?.cancel();
    throw new GitRefError(`${repo} has too many branches and tags for Appflare to read`);
  }
  const body = await response.text();
  if (body.length > MAX_ADVERTISEMENT_BYTES) {
    throw new GitRefError(`${repo} has too many branches and tags for Appflare to read`);
  }
  return parseAdvertisement(body);
}
