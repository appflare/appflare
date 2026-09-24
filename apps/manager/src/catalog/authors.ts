import {
  type CatalogAuthor,
  type CatalogManifest,
  catalogAuthors,
  type IndexApp,
} from "@appflare/schema";

/**
 * Who wrote an app and who packages it for the catalog. Authors come from the
 * catalog index, which lists them for every app; an index published before
 * authors existed falls back to the signed catalog manifest's `authors`, then
 * to the owner of its repository. Maintainers package the app for the catalog
 * and appear only on the app's own page, as "Packaged by".
 */

/** A link shown next to a name. */
export interface ProfileLink {
  label: string;
  href: string;
}

/** The authors to show for `app`: the index's, else the catalog manifest's, else none. */
export function appAuthors(
  app: Pick<IndexApp, "authors">,
  catalog: Pick<CatalogManifest, "authors" | "repo"> | null,
): CatalogAuthor[] {
  if (app.authors !== undefined) return app.authors;
  return catalog === null ? [] : catalogAuthors(catalog);
}

const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** `Ada`, `Ada and Grace`, `Ada, Grace, and Linus`; empty for none. */
export function authorNames(authors: readonly Pick<CatalogAuthor, "name">[]): string {
  return names.format(authors.map((a) => a.name));
}

/** The author's website, GitHub profile, and X profile, in that order, where given. */
export function authorLinks(author: CatalogAuthor): ProfileLink[] {
  const links: ProfileLink[] = [];
  if (author.url !== undefined) links.push({ label: websiteLabel(author.url), href: author.url });
  if (author.github !== undefined) {
    links.push({ label: "GitHub", href: `https://github.com/${author.github}` });
  }
  if (author.x !== undefined) links.push({ label: "X", href: `https://x.com/${author.x}` });
  return links;
}

/** A website link's host without `www.`, or "Website" when the URL cannot be read. */
function websiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Website";
  } catch {
    return "Website";
  }
}

const GITHUB_LOGIN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const GITHUB_TEAM = /^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/([A-Za-z0-9_.-]+)$/;

/**
 * A catalog maintainer as shown under "Packaged by": a GitHub user
 * (`octocat`) links to the profile, a team (`acme/catalog`) to the team page.
 * A leading `@` is dropped; anything else is shown without a link.
 */
export function maintainerProfile(handle: string): { label: string; href: string | null } {
  const label = handle.replace(/^@/, "");
  if (GITHUB_LOGIN.test(label)) return { label, href: `https://github.com/${label}` };
  const team = GITHUB_TEAM.exec(label);
  if (team !== null) {
    return { label, href: `https://github.com/orgs/${team[1]}/teams/${team[2]}` };
  }
  return { label, href: null };
}
