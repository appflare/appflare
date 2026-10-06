import {
  type CatalogManifest,
  type CatalogSecret,
  catalogHomepage,
  type InstallTier,
  licenseFile,
  type Plan,
} from "@appflare/schema";
import {
  type AppLicense,
  type AppPopularity,
  categoryLabel,
  dateBuildDay,
  formatCount,
  licenseBadgeCopy,
  PLAN_STATS,
} from "@appflare/schema/catalog-display";
import { formatBytes, formatExactDateTime } from "../components/format";
import type { InstallVarField } from "../installs/install-vars";
import { licenseFileHref, licenseHref } from "./license";
import type { CatalogSource } from "./sources";

/**
 * What an app's catalog page says, worked out from the catalog data so the
 * page stays a thin view: the header's single action, where the
 * build comes from, the stat strip, the settings the install form will ask
 * for, and the links. Written for people who are not developers: plain words
 * first, the technical detail (variable names, commits, exact byte counts)
 * only in tooltips. Client-safe.
 */

/** A description split into paragraphs at blank lines; single line breaks stay inside a paragraph. */
export function descriptionParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p !== "");
}

/**
 * The header's one action. "Manage" once the app is installed here: the
 * install's page when there is one install, else `href` null and the page
 * scrolls to the list of installs. "Install" otherwise, which opens the
 * install form; disabled for a member (only admins install, and the tooltip says
 * so) and when the form cannot be shown (the catalog manifest did not load).
 */
export type HeaderAction =
  | { kind: "install"; disabled: boolean; reason: string | null }
  | { kind: "manage"; href: string | null; count: number };

/** Why a member's Install is disabled. */
export const ADMINS_ONLY = "Only admins can install apps";

export function headerAction(
  installs: ReadonlyArray<{ installId: string }>,
  installable: boolean,
  canInstall: boolean,
): HeaderAction {
  const [first] = installs;
  if (first === undefined) {
    if (!canInstall) return { kind: "install", disabled: true, reason: ADMINS_ONLY };
    return { kind: "install", disabled: !installable, reason: null };
  }
  return {
    kind: "manage",
    href: installs.length === 1 ? `/apps/${first.installId}` : null,
    count: installs.length,
  };
}

/** Where the code an install runs comes from, as one small badge in the header. */
export interface Provenance {
  kind: "catalog" | "yours" | "custom";
  label: string;
  tooltip: string;
}

/**
 * "Catalog build" for a release the official catalog built, "Your build" for
 * an app built (or set up by its own installer) in this account, "Custom
 * catalog: <name>" for an app from a catalog an admin added. Signing is
 * described as what it is, proof of where a build came from, not a review.
 */
export function provenance(source: CatalogSource | null, tier: InstallTier): Provenance {
  if (source !== null && !source.official) {
    return {
      kind: "custom",
      label: `Custom catalog: ${source.label}`,
      tooltip: `Listed by ${source.label}, a catalog an admin added. Appflare checks its releases with the key saved for that catalog on the Catalogs settings page. That shows where a release came from; it is not a review of the code.`,
    };
  }
  if (tier === "sandbox") {
    return {
      kind: "yours",
      label: "Your build",
      tooltip:
        "Your account builds this app from its source code, at the exact version the catalog lists, when you install it. Building needs the Workers Paid plan.",
    };
  }
  if (tier === "self-deploying") {
    return {
      kind: "yours",
      label: "Your build",
      tooltip:
        "The app's own installer sets it up from your account, at the exact version the catalog lists. It needs the Workers Paid plan and a Cloudflare token you create for the app.",
    };
  }
  return {
    kind: "catalog",
    label: "Catalog build",
    tooltip:
      "The Appflare catalog built this app from its source code, at an exact version, and signed the result. The signature shows where the build came from; it is not a review of the code.",
  };
}

/** One stat of the strip under the header: a small label, a value, an optional caption. */
export interface AppStat {
  id: "stars" | "installs" | "plan" | "license" | "version" | "size" | "tested" | "category";
  label: string;
  value: string;
  /** A quieter word under the value ("Source-available"), or null. */
  caption: string | null;
  /** The detail behind the value, in a sentence or two. */
  tooltip: string;
  /** `warning` shows the value as a warning badge ("No license"). */
  tone: "default" | "warning";
}

export interface AppStatsInput {
  plan: Plan;
  version: string;
  lastVerified: string | null;
  /** GitHub stars of the upstream repository; null when the catalog publishes none. */
  stars: number | null;
  /** Install counts from anonymous usage data; null when the catalog publishes none. */
  installs: Pick<AppPopularity, "activeInstalls" | "installs30d" | "installsKnown"> | null;
  license: AppLicense | null;
  /** Bytes of Worker code the install uploads; null when not known before a build. */
  moduleBytes: number | null;
  categories: readonly string[];
  /** The commit the version was built from, for the version's tooltip; null when unknown. */
  pin: string | null;
}

export interface DateOptions {
  now?: Date;
  locale?: string;
  timeZone?: string;
}

function yearOf(date: Date, options: DateOptions): string {
  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    year: "numeric",
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }).format(date);
}

/** A day as the strip shows it: "Sep 26", with the year only when it is not this year's. */
export function shortDate(iso: string, options: DateOptions = {}): string {
  const date = new Date(iso);
  const sameYear = yearOf(date, options) === yearOf(options.now ?? new Date(), options);
  return new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }).format(date);
}

/**
 * A version in a few characters, for places one short line must hold it: a
 * date build (`0.0.0-20260921.4fd08b5`) by its day, "Sep 21"; a tagged
 * version as it is, "1.2.3". The full string belongs in a tooltip.
 */
export function shortVersion(
  version: string,
  options: DateOptions = {},
): { kind: "build" | "tagged"; text: string } {
  const day = dateBuildDay(version);
  if (day === null) return { kind: "tagged", text: version };
  // The day is a calendar date, not an instant: read it in UTC so no time zone moves it.
  return { kind: "build", text: shortDate(`${day}T00:00:00Z`, { ...options, timeZone: "UTC" }) };
}

function licenseStat(license: AppLicense): AppStat {
  const copy = licenseBadgeCopy(license);
  const base = { id: "license", label: "License", tooltip: copy.tooltip } as const;
  if (copy.kind === "none") return { ...base, value: copy.label, caption: null, tone: "warning" };
  return {
    ...base,
    value: copy.label,
    caption: copy.kind === "source-available" ? "Source-available" : null,
    tone: "default",
  };
}

/**
 * Managers running the app, else those that installed it in 30 days; "Under
 * 10" when the catalog read counts but publishes none that small. Null when
 * there are no counts.
 */
function installsStat(installs: AppStatsInput["installs"], options: DateOptions): AppStat | null {
  if (installs === null || !installs.installsKnown) return null;
  const base = { id: "installs", label: "Installs", caption: null, tone: "default" } as const;
  if (installs.activeInstalls !== null) {
    return {
      ...base,
      value: formatCount(installs.activeInstalls),
      tooltip: `${installs.activeInstalls.toLocaleString(options.locale ?? "en-US")} Appflare users run this app, from anonymous usage data.`,
    };
  }
  if (installs.installs30d !== null) {
    return {
      ...base,
      value: formatCount(installs.installs30d),
      tooltip: `${installs.installs30d.toLocaleString(options.locale ?? "en-US")} Appflare users installed this app in the last 30 days, from anonymous usage data.`,
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
 * The strip, in order: stars, installs, plan, license, version, size, last
 * tested, category. A stat with nothing to say (no stars or installs
 * published, a size known only after a build, no category) is left out
 * rather than shown empty.
 */
export function appStats(input: AppStatsInput, options: DateOptions = {}): AppStat[] {
  const stats: AppStat[] = [];
  if (input.stars !== null) {
    stats.push({
      id: "stars",
      label: "Stars",
      value: formatCount(input.stars),
      caption: null,
      tooltip: `${input.stars.toLocaleString(options.locale ?? "en-US")} stars on the app's GitHub repository.`,
      tone: "default",
    });
  }
  const installs = installsStat(input.installs, options);
  if (installs !== null) stats.push(installs);
  const plan = PLAN_STATS[input.plan];
  stats.push({ id: "plan", label: "Plan", caption: null, tone: "default", ...plan });
  if (input.license !== null) stats.push(licenseStat(input.license));
  stats.push({
    id: "version",
    label: "Version",
    value: shortVersion(input.version, options).text,
    caption: null,
    tooltip:
      input.pin === null
        ? `Version ${input.version}.`
        : `Version ${input.version}, from commit ${input.pin.slice(0, 12)} of the app's repository.`,
    tone: "default",
  });
  if (input.moduleBytes !== null) {
    stats.push({
      id: "size",
      label: "Size",
      value: formatBytes(input.moduleBytes),
      caption: null,
      tooltip: `The app's code: ${input.moduleBytes.toLocaleString(options.locale ?? "en-US")} bytes uploaded to Cloudflare. Files it serves, such as images, are not counted.`,
      tone: "default",
    });
  }
  stats.push(
    input.lastVerified === null
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
          value: shortDate(input.lastVerified, options),
          caption: null,
          tooltip: `The catalog installed this version in a test account and it answered, on ${formatExactDateTime(input.lastVerified)}.`,
          tone: "default",
        },
  );
  const [category, ...more] = [...new Set(input.categories)];
  if (category !== undefined) {
    stats.push({
      id: "category",
      label: "Category",
      value: categoryLabel(category),
      caption: null,
      tooltip:
        more.length === 0
          ? `Listed under ${categoryLabel(category)}.`
          : `Listed under ${[category, ...more].map(categoryLabel).join(", ")}.`,
      tone: "default",
    });
  }
  return stats;
}

/** Bytes of Worker code across every Worker of an app. */
export function moduleBytes(workers: ReadonlyArray<{ modules: ReadonlyArray<{ size: number }> }>) {
  return workers.reduce((n, w) => n + w.modules.reduce((m, module) => m + module.size, 0), 0);
}

/** One thing the install form will ask for, by its label; `name` is shown on hover only. */
export interface SettingItem {
  label: string;
  name: string;
  hint: "Required" | "Optional" | "Filled in for you" | "Suggested value filled in";
  /** The catalog's help text for it; null when it has none. */
  description: string | null;
}

/**
 * The secrets and settings the install form asks for, in its order: secrets
 * first, then settings. Values Appflare works out itself (derived ones) are
 * left out, since nobody chooses them.
 */
export function settingsToChoose(
  secrets: ReadonlyArray<
    Pick<CatalogSecret, "name" | "label" | "help" | "generate" | "optional" | "derive">
  >,
  vars: ReadonlyArray<
    Pick<InstallVarField, "name" | "label" | "help" | "required" | "shownDefault" | "derivedFrom">
  >,
): SettingItem[] {
  const items: SettingItem[] = [];
  for (const secret of secrets) {
    if (secret.derive !== undefined) continue;
    items.push({
      label: secret.label,
      name: secret.name,
      hint:
        secret.generate !== undefined
          ? "Filled in for you"
          : secret.optional === true
            ? "Optional"
            : "Required",
      description: secret.help ?? null,
    });
  }
  for (const field of vars) {
    if (field.derivedFrom !== undefined) continue;
    items.push({
      label: field.label,
      name: field.name,
      hint:
        field.shownDefault !== ""
          ? "Suggested value filled in"
          : field.required
            ? "Required"
            : "Optional",
      description: field.help ?? null,
    });
  }
  return items;
}

/** One entry of the Links section. */
export interface AppLink {
  kind: "repository" | "website" | "license";
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

/**
 * The source code, the website (unless it is the repository), and the
 * license: its file at the pinned commit for a license of the app's own, else
 * a plain-language page about a single standard license.
 */
export function appLinks(
  catalog: Pick<CatalogManifest, "repo" | "homepage"> & { source: { sha: string } },
  license: AppLicense | null,
): AppLink[] {
  const repoUrl = `https://github.com/${catalog.repo}`;
  const links: AppLink[] = [
    {
      kind: "repository",
      label: "Source code",
      href: repoUrl,
      detail: `github.com/${catalog.repo}`,
    },
  ];
  const homepage = catalogHomepage(catalog);
  if (homepage.replace(/\/$/, "") !== repoUrl) {
    links.push({
      kind: "website",
      label: "Website",
      href: homepage,
      detail: hostOf(homepage),
    });
  }
  if (license !== null) {
    const expression = license.expression.trim();
    const file = licenseFileHref(expression, catalog.repo, catalog.source.sha);
    const about = file === null ? licenseHref(expression) : null;
    if (file !== null) {
      links.push({
        kind: "license",
        label: "License",
        href: file,
        detail: licenseFile(expression) ?? "License file",
      });
    } else if (about !== null) {
      links.push({
        kind: "license",
        label: `About ${expression}`,
        href: about,
        detail: hostOf(about),
      });
    }
  }
  return links;
}
