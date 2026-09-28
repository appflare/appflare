import {
  categoryLabel,
  dateBuildDay,
  declaredServices,
  formatCount,
  licenseBadgeCopy,
  PLAN_STATS,
  serviceName,
  serviceNeedWords,
} from "@appflare/schema/catalog-display";
import type { SiteApp } from "./site-catalog.ts";

/**
 * What an app's page says, worked out from the catalog so the page stays a
 * thin view, in the words Appflare's own catalog page uses. Written for
 * people who are not developers: plain words first, the exact detail only in
 * a tooltip.
 */

/** A day as the pages show it: "Sep 26", with the year only when it is not the year of `now`. */
export function shortDate(iso: string, now: Date): string {
  const date = new Date(iso);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    // The site is built once for everyone, so it reads days in UTC.
    timeZone: "UTC",
  }).format(date);
}

/** A day with its year: "Sep 26, 2026". */
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(iso),
  );
}

/** One figure of the stat strip under the app's name. */
export interface AppStat {
  id: "stars" | "installs" | "plan" | "license" | "version" | "tested";
  label: string;
  value: string;
  /** Muted words next to the value ("Source-available"), or null. */
  caption: string | null;
  /** The sentence behind the figure, shown on hover. */
  tooltip: string;
  tone: "default" | "warning";
}

function installsStat(app: SiteApp): AppStat | null {
  const p = app.popularity;
  if (p === null || !p.installsKnown) return null;
  const base = { id: "installs", label: "Installs", caption: null, tone: "default" } as const;
  if (p.activeInstalls !== null) {
    return {
      ...base,
      value: formatCount(p.activeInstalls),
      tooltip: `${p.activeInstalls.toLocaleString("en-US")} Appflare users run this app, from anonymous usage data.`,
    };
  }
  if (p.installs30d !== null) {
    return {
      ...base,
      value: formatCount(p.installs30d),
      tooltip: `${p.installs30d.toLocaleString("en-US")} Appflare users installed this app in the last 30 days, from anonymous usage data.`,
    };
  }
  return {
    ...base,
    value: "Under 10",
    tooltip:
      "Fewer than 10 Appflare users run this app, from anonymous usage data; smaller counts are not published.",
  };
}

/**
 * The strip, in order: stars, installs, plan, license, version, last tested.
 * Stars and installs show only when the catalog's numbers were fresh when
 * the site was built.
 */
export function appStats(app: SiteApp, now: Date): AppStat[] {
  const stats: AppStat[] = [];
  const stars = app.popularity?.stars ?? null;
  // A count of zero says nothing worth the space.
  if (stars !== null && stars > 0) {
    stats.push({
      id: "stars",
      label: "Stars",
      value: formatCount(stars),
      caption: null,
      tooltip: `${stars.toLocaleString("en-US")} stars on the app's GitHub repository.`,
      tone: "default",
    });
  }
  const installs = installsStat(app);
  if (installs !== null) stats.push(installs);
  stats.push({
    id: "plan",
    label: "Plan",
    caption: null,
    tone: "default",
    ...PLAN_STATS[app.plan],
  });
  if (app.license !== null) {
    const copy = licenseBadgeCopy(app.license);
    stats.push({
      id: "license",
      label: "License",
      value: copy.label,
      caption: copy.prefix,
      tooltip: copy.tooltip,
      tone: copy.variant === "warning" ? "warning" : "default",
    });
  }
  const day = dateBuildDay(app.version);
  stats.push({
    id: "version",
    label: "Version",
    // A date build reads as its day; the full string is in the tooltip.
    value: day === null ? app.version : shortDate(`${day}T00:00:00Z`, now),
    caption: null,
    tooltip: `Version ${app.version}.`,
    tone: "default",
  });
  stats.push(
    app.lastVerified === null
      ? {
          id: "tested",
          label: "Last tested",
          value: "Not yet",
          caption: null,
          tooltip: "The catalog has not yet installed this version in a test account.",
          tone: "default",
        }
      : {
          id: "tested",
          label: "Last tested",
          value: shortDate(app.lastVerified, now),
          caption: null,
          tooltip: `The catalog installed this version in a test account and it answered, on ${longDate(app.lastVerified)}.`,
          tone: "default",
        },
  );
  return stats;
}

/** One line of "What it needs on your account". */
export interface NeedItem {
  key: string;
  name: string;
  /** "This app needs it" or "This app uses it"; null in the plain list. */
  words: string | null;
}

export interface AccountNeeds {
  items: NeedItem[];
  /** A quiet line under the list, when it may be incomplete. */
  note: string | null;
}

/** A requirement without a service of its own, spelled out from its id. */
function requirementName(requirement: string): string {
  const name = serviceName(requirement);
  if (name !== null) return name;
  return requirement.charAt(0).toUpperCase() + requirement.slice(1).replaceAll("-", " ");
}

/**
 * Everything the app counts on in a Cloudflare account: Workers Paid when it
 * needs it, then each service. A service its `requires` names reads "This app
 * needs it"; one the catalog worked out from the app's bindings reads "This
 * app uses it". An index row that does not list the services gives the plain
 * list of requirements.
 */
export function accountNeeds(app: SiteApp): AccountNeeds {
  const items: NeedItem[] = [];
  if (app.plan === "paid") {
    items.push({ key: "plan", name: "Workers Paid plan", words: serviceNeedWords(true) });
  }
  if (app.services === null) {
    for (const requirement of app.requires) {
      items.push({ key: requirement, name: requirementName(requirement), words: null });
    }
  } else {
    const declared: ReadonlySet<string> = declaredServices(app.requires);
    // A requirement the services leave out still gets its line.
    const ids = [...new Set([...app.services, ...declared])];
    for (const id of ids) {
      const name = serviceName(id);
      if (name === null) continue;
      items.push({ key: id, name, words: serviceNeedWords(declared.has(id)) });
    }
    for (const requirement of app.requires) {
      if (serviceName(requirement) !== null) continue;
      items.push({ key: requirement, name: requirementName(requirement), words: null });
    }
  }
  return { items, note: needsNote(app) };
}

function needsNote(app: SiteApp): string | null {
  if (app.tier === "self-deploying") {
    return "Its own installer creates what it needs; this is what its token allows.";
  }
  if (app.tier === "sandbox") return "It is built in your account, so the rest is known then.";
  if (app.services === null) return "The catalog lists only what this app requires.";
  return null;
}

/** One entry of the Links section. */
export interface AppLink {
  kind: "repository" | "website";
  label: string;
  href: string;
  /** Where it goes, shortened ("github.com/acme/cut"). */
  detail: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The source code, and the website unless it is the repository. */
export function appLinks(app: Pick<SiteApp, "repo" | "homepage">): AppLink[] {
  const repoUrl = `https://github.com/${app.repo}`;
  const links: AppLink[] = [
    { kind: "repository", label: "Source code", href: repoUrl, detail: `github.com/${app.repo}` },
  ];
  if (app.homepage.replace(/\/$/, "") !== repoUrl) {
    links.push({
      kind: "website",
      label: "Website",
      href: app.homepage,
      detail: hostOf(app.homepage),
    });
  }
  return links;
}

/** A person's links: website, GitHub, X, where given. */
export function authorLinks(author: SiteApp["authors"][number]): Array<{
  label: string;
  href: string;
}> {
  const links: Array<{ label: string; href: string }> = [];
  if (author.url !== undefined) links.push({ label: hostOf(author.url), href: author.url });
  if (author.github !== undefined) {
    links.push({ label: "GitHub", href: `https://github.com/${author.github}` });
  }
  if (author.x !== undefined) {
    links.push({ label: "X (Twitter)", href: `https://x.com/${author.x}` });
  }
  return links;
}

/** A GitHub login as the catalog's maintainers list it. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** A maintainer's name and, for a GitHub login, their profile. */
export function maintainerProfile(handle: string): { label: string; href: string | null } {
  const login = handle.replace(/^@/, "");
  return GITHUB_LOGIN.test(login)
    ? { label: login, href: `https://github.com/${login}` }
    : { label: handle, href: null };
}

/** The page title: `"<Name>: <tagline> | Appflare"`. */
export function appPageTitle(app: Pick<SiteApp, "name" | "pitch">, siteName: string): string {
  return `${app.name}: ${app.pitch} | ${siteName}`;
}

/** The categories as the page lists them, with labels. */
export function appCategories(
  app: Pick<SiteApp, "categories">,
): Array<{ id: string; label: string }> {
  return app.categories.map((id) => ({ id, label: categoryLabel(id) }));
}
