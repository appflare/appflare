/**
 * `@appflare/schema/links`: the names that go into addresses, a catalog
 * slug and a GitHub repository, and how what someone typed or linked is
 * read as a repository. Plain checks with no dependencies, so a browser
 * bundle (the install pages of the public site) can check an install link
 * without the whole schema or Zod; the Zod schemas built on them are in
 * `repository.ts`.
 */

/**
 * The strict form of a catalog slug: lowercase letters, digits and dashes,
 * starting with a letter or digit, at most 63 characters. Slugs become Worker
 * names, sandbox ids and page addresses, so every place that builds one of
 * those from a slug checks it against this.
 */
export const CATALOG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A GitHub owner (user or organization): letters, digits, single hyphens, at most 39. */
const GITHUB_OWNER = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
/** A GitHub repository name: letters, digits, `.`, `_` and `-`, at most 100, never `.` or `..`. */
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether `value` is a GitHub repository as `owner/repo`. */
export function isGithubRepository(value: string): boolean {
  const [owner, name, ...rest] = value.split("/");
  return (
    rest.length === 0 &&
    owner !== undefined &&
    name !== undefined &&
    GITHUB_OWNER.test(owner) &&
    GITHUB_REPO.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.toLowerCase().endsWith(".git")
  );
}

/** Whether `ref` is a full commit SHA rather than a branch or tag name. */
export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

/** The characters a branch, tag or commit may use. */
export const GIT_REF_CHARACTERS = /^[A-Za-z0-9._/+-]+$/;
/** The longest branch, tag or commit accepted. */
export const MAX_GIT_REF_LENGTH = 200;

/**
 * Whether `ref`, already made of {@link GIT_REF_CHARACTERS}, is shaped as
 * git accepts it: no `..` or `//`, not starting with `-` or `/`, not ending
 * with `/`, `.` or `.lock`.
 */
export function isGitRefShape(ref: string): boolean {
  return (
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//")
  );
}

/**
 * Whether `ref` is a branch, tag or full commit SHA, as git accepts it on
 * the command line and in a URL: letters, digits and `. _ / + -`, at most
 * 200 characters, and shaped as {@link isGitRefShape} says.
 */
export function isGitRef(ref: string): boolean {
  return (
    ref.length >= 1 &&
    ref.length <= MAX_GIT_REF_LENGTH &&
    GIT_REF_CHARACTERS.test(ref) &&
    isGitRefShape(ref)
  );
}

/** `https://github.com/<owner>/<repo>`: how a repository is shown and recorded. */
export function repositoryUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

/** What an admin typed as a repository, understood; or why it cannot be one. */
export type RepositoryInput =
  | { ok: true; repo: string; ref: string | null }
  | { ok: false; error: string };

/**
 * Reads what an admin typed: `owner/repo`, `github.com/owner/repo`, or a
 * GitHub URL, with or without `.git`, and optionally pointing at a branch,
 * tag or commit (`/tree/<ref>`, `/commit/<sha>`), which becomes the ref.
 */
export function parseRepositoryInput(text: string): RepositoryInput {
  let rest = text.trim();
  const refused = {
    ok: false as const,
    error: "Enter a GitHub repository, such as https://github.com/owner/repo.",
  };
  if (rest.length === 0 || rest.length > 400) return refused;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    let url: URL;
    try {
      url = new URL(rest);
    } catch {
      return refused;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return refused;
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      return { ok: false, error: "Only repositories on github.com can be installed." };
    }
    if (url.search !== "" || url.username !== "" || url.password !== "") return refused;
    try {
      rest = decodeURIComponent(url.pathname);
    } catch {
      // A malformed escape (`%E0` alone) names no repository.
      return refused;
    }
  } else if (/^(www\.)?github\.com\//i.test(rest)) {
    rest = rest.replace(/^(www\.)?github\.com/i, "");
  }
  const parts = rest.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  const [owner, rawName, kind, ...refParts] = parts;
  if (owner === undefined || rawName === undefined) return refused;
  const name = rawName.replace(/\.git$/i, "");
  const repo = `${owner}/${name}`;
  if (!isGithubRepository(repo)) return refused;
  if (kind === undefined) return { ok: true, repo, ref: null };
  if ((kind !== "tree" && kind !== "commit") || refParts.length === 0) return refused;
  const ref = refParts.join("/");
  if (!isGitRef(ref) || (kind === "commit" && !isCommitSha(ref))) {
    return { ok: false, error: `"${ref}" is not a branch, tag or commit Appflare can build.` };
  }
  return { ok: true, repo, ref };
}
