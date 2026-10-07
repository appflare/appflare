import {
  CATALOG_SLUG_PATTERN,
  isGithubRepository,
  parseRepositoryInput,
} from "@appflare/schema/links";
import { installPath } from "../catalog/urls.ts";
import { isAppflareOrigin } from "./address.ts";

/**
 * What an install link asks for, and where it leads in the visitor's own
 * Appflare. The site's links are `/install/<slug>/` for a catalog app and
 * `/install/?repo=<owner>/<repo>` for a GitHub repository; the Appflare
 * pages they open are `<origin>/install/<slug>` and
 * `<origin>/install/github/<owner>/<repo>`. Every part is checked against
 * the rules a real slug or repository follows before it goes into an
 * address, and the site takes no other destination from a link: there is
 * no `redirect=` or `next=`.
 */

export type InstallRequest =
  | { kind: "app"; slug: string }
  /** `owner/repo` on github.com. */
  | { kind: "repo"; repo: string };

/** A catalog app, as the install pages show and look it up. */
export interface InstallApp {
  slug: string;
  name: string;
  pitch: string;
  icon: string | null;
  /** Its GitHub repository, `owner/repo`. */
  repo: string;
  /** Its build repository when it differs from the public repository. */
  sourceRepo?: string;
}

/** The request for a catalog app, or null when `slug` cannot be one. */
export function appRequest(slug: string): InstallRequest | null {
  return CATALOG_SLUG_PATTERN.test(slug) ? { kind: "app", slug } : null;
}

/**
 * The repository `?repo=` names, with the repository parsing Appflare itself
 * uses: `owner/repo`, or its github.com address, which is reduced to
 * `owner/repo`. A branch, tag or commit is refused, because the link opens
 * the repository as a whole; so is a second `repo`.
 */
export function repoRequestFromSearch(search: string): InstallRequest | null {
  const values = new URLSearchParams(search).getAll("repo");
  const [value] = values;
  if (values.length !== 1 || value === undefined) return null;
  const parsed = parseRepositoryInput(value);
  if (!parsed.ok || parsed.ref !== null || !isGithubRepository(parsed.repo)) return null;
  return { kind: "repo", repo: parsed.repo };
}

/** Whether a request is well formed, as one read back from storage must be. */
export function isInstallRequest(value: unknown): value is InstallRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === "app") {
    return typeof request.slug === "string" && CATALOG_SLUG_PATTERN.test(request.slug);
  }
  if (request.kind === "repo")
    return typeof request.repo === "string" && isGithubRepository(request.repo);
  return false;
}

export function sameRequest(a: InstallRequest, b: InstallRequest): boolean {
  if (a.kind === "app" && b.kind === "app") return a.slug === b.slug;
  if (a.kind === "repo" && b.kind === "repo") return a.repo.toLowerCase() === b.repo.toLowerCase();
  return false;
}

/**
 * The page of the visitor's Appflare that opens the request, or null when
 * the address or the request does not pass its check. The only addresses
 * this site ever sends a visitor to are built here.
 */
export function installTarget(origin: string, request: InstallRequest): string | null {
  if (!isAppflareOrigin(origin) || !isInstallRequest(request)) return null;
  if (request.kind === "app") return `${origin}/install/${request.slug}`;
  return `${origin}/install/github/${request.repo}`;
}

/**
 * This site's install page for a request. A checked repository holds only
 * letters, digits, `.`, `_`, `-` and one `/`, none of which a query escapes.
 */
export function installPagePath(request: InstallRequest): string {
  return request.kind === "app" ? installPath(request.slug) : `/install/?repo=${request.repo}`;
}

/** The catalog app for a public or build repository. GitHub names ignore case. */
export function catalogAppForRepo<App extends Pick<InstallApp, "repo" | "sourceRepo">>(
  apps: readonly App[],
  repo: string,
): App | undefined {
  const wanted = repo.toLowerCase();
  return apps.find(
    (app) => app.repo.toLowerCase() === wanted || app.sourceRepo?.toLowerCase() === wanted,
  );
}

/** How a request reads in a sentence: the app's name, or the repository. */
export function requestLabel(
  request: InstallRequest,
  apps: ReadonlyArray<Pick<InstallApp, "slug" | "name">>,
): string {
  if (request.kind === "repo") return request.repo;
  return apps.find((app) => app.slug === request.slug)?.name ?? request.slug;
}
