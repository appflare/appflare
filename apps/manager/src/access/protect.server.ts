import {
  type AccessApp,
  type AccessAppCoverage,
  type AccessDestination,
  type AccessPolicyArgs,
  accessAppCoverage,
  CloudflareApiError,
  type CloudflareClient,
  type CreateAccessAppArgs,
  isAccessTeamDomain,
  type WorkerDomain,
  type WorkerScript,
} from "@appflare/cf-api";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { install_access, installs, resources } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { installLabel } from "../installs/display-name";
import { recordedName } from "../installs/install-names.server";
import {
  ACCESS_APP_KIND,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  WILDCARD_DOMAIN_KIND,
} from "../installs/resource-kinds";
import { writeAcceptedBypass } from "./accepted-paths.server";
import {
  type BypassChange,
  type BypassOutcome,
  bypassPathsOfManifest,
  isBypassAppOf,
  MAX_ACCESS_APP_DESTINATIONS,
  recordedBypassAppId,
  removeInstallBypassLocked,
  syncInstallBypassLocked,
} from "./bypass.server";
import {
  accessAppResourceId,
  accessAppSettings,
  ensureAppAccessUsersPolicy,
  ensureInstallServiceToken,
  INSTALL_ACCESS_MESSAGES,
  type InstallAccessDeps,
  listAccessServiceTokens,
  policyReferences,
  probesPolicy,
  probesPolicyName,
  readInstallAccess,
  removeInstallAccess,
} from "./install-access.server";
import { listOf } from "./messages";
import { storedBypassPaths } from "./stored-access.server";
import {
  ACCESS_MESSAGES,
  ACCESS_SESSION_DURATION,
  AccessToggleError,
  withAccessLock,
} from "./toggle.server";

/**
 * Protecting one install with Cloudflare Access: one self-hosted Access
 * application per install whose destinations cover every address the
 * install has, letting in the "Appflare users" policy (precedence 1) and the
 * install's own service token through its inline `non_identity` policy
 * (precedence 2), so Appflare's health checks still reach the app
 * (install-access.server.ts). Sessions last 24 hours; the application is
 * not shown in the App Launcher.
 *
 * Destinations:
 *
 * - one `worker` destination per Worker of the install (the primary one and
 *   every other, whether it has a workers.dev address or not). A `worker`
 *   destination covers the Worker's workers.dev URL, every version preview
 *   URL (later ones too), its Workers custom domains and the zone Worker
 *   routes that send to it (verified live 2026-09-30, with controls: a
 *   custom domain and a route each answered with the Access sign-in with
 *   only the `worker` destination, and served the app once the application
 *   was deleted);
 * - next to it, a `public` destination for the Worker's
 *   `<worker>.<subdomain>.workers.dev` hostname, and one per custom domain
 *   of the app. Access picks a hostname over a `worker` destination, so
 *   without these an application made by hand for
 *   `*.<subdomain>.workers.dev` or `*.example.com` would decide who reaches
 *   the app (and refuse Appflare's own health checks). Its version
 *   previews' pattern (`*-<worker>.<subdomain>.workers.dev`) only while
 *   another application covers those previews, and never while the account
 *   has another Worker whose name ends in `-<worker>`, whose own address the
 *   pattern matches too. A wildcard domain's base and `*.<base>` likewise,
 *   each only while another application covers it, and never while another
 *   Worker of the account has a custom domain or a route it matches
 *   (`planDestinations`). Verified live 2026-10-11: the hostname
 *   destinations made the install's application answer on both hostnames
 *   against such a wildcard, and a `PUT` giving them to an application made
 *   with the `worker` destination alone (as earlier versions made it) was
 *   accepted and kept its audience tag; without the previews' pattern, the
 *   wildcard answered on a preview (the main address stayed the install's).
 *   A WebSocket upgrade with the install's service token was let through
 *   (101) with or without them, and refused (403) without the token. Past
 *   Cloudflare's limit of 50 destinations, the hostnames a `worker`
 *   destination covers anyway, and no other application covers too, are
 *   left out, and the cron names one once another application covers it
 *   (`patternsOutOfStep`);
 * - before a Worker exists (an install protected from its first upload on),
 *   those `public` destinations alone, which Access accepts and enforces
 *   from the first request; the install job adds the `worker` destinations
 *   after its uploads, and the application keeps its audience tag across
 *   the switch;
 * - one `public` destination per external domain (a Cloudflare for SaaS
 *   custom hostname served through the gateway Worker). These pass through
 *   the gateway Worker before the app's Worker, so a `worker` destination
 *   does not name them. Verified live 2026-10-01: a hostname routed through
 *   a gateway Worker to the app's Worker over a service binding answered
 *   200 under an application with only the app Worker's `worker`
 *   destination, and Access's sign-in (302) once the application also had
 *   a `public` destination for that hostname. A new external domain is
 *   covered before its custom hostname is made, and a removed one taken off
 *   after its custom hostname is deleted (installs/external-domains.server.ts).
 *
 * Cloudflare refuses an application a hostname or pattern another one names
 * itself (409), and that other application then decides who reaches the app
 * there. Protecting the app refuses it (`overlap`), unless it is another
 * Worker's custom domain or route under one of the app's wildcard domains,
 * which the app does not answer on. For an app already
 * protected, bringing its addresses in step (`syncInstallAccessDestinations`)
 * leaves those to the other application instead of failing on every try:
 * the install's application keeps its Workers and every other address, and
 * records what it left and to which application (`taken`). The cron covers
 * them again once no other application names them
 * (`releaseFreedAddresses`).
 *
 * Every function that changes Cloudflare takes the Access lock itself
 * (`withAccessLock`), so they run from a server function or a job unit
 * alike. Each is idempotent and resumable: an application whose creation
 * was not recorded is found again by its token policy's name (which carries
 * the install id), or by its own name when everything it covers is this
 * install's, and adopted instead of made twice.
 *
 * An install whose catalog entry lists public paths (`access.bypass`) also
 * gets a second application that keeps those paths public on every address
 * (bypass.server.ts); it follows the install's application in every change
 * here, and goes before it when protection comes off. A path is more
 * specific than a hostname, so its `<host>/<path>` destinations still win
 * over the install's `public <host>` one (verified live 2026-10-11).
 *
 * The lock is a lease of 60 seconds (toggle.server.ts). `protectInstall`
 * makes about 8 to 18 Cloudflare calls under it, each well under a second,
 * so it finishes long before another change could take the lease over.
 */

/** A Worker of the install, as the protection covers it. */
export interface ProtectWorker {
  name: string;
  /**
   * Its script tag (`ScriptUploadResult.tag`). `null`: not uploaded yet, so
   * only its future workers.dev hostnames are covered. Left out: read from
   * the account's script list, where the Worker must be.
   */
  tag?: string | null;
}

/** A hostname or pattern of the install that another Access application names itself. */
export interface TakenAddress {
  /** As the install's `public` destination would name it. */
  uri: string;
  /** The other application's name (its id when it has none). */
  app: string;
}

/** What an install's application covers, as last written. */
export interface AccessCoverageRecord {
  destinations: AccessDestination[];
  /** Script tag by Worker name, for each Worker a `worker` destination covers. */
  workerTags: Record<string, string>;
  /**
   * The install's addresses left out of `destinations` because another
   * application names them itself; together they are what the install's
   * addresses asked for when last written. Empty when none.
   */
  taken: TakenAddress[];
  /**
   * Hostnames left out to stay within Cloudflare's limit of destinations
   * (`DestinationPlan.overLimit`), which the install's Workers cover by
   * their own destinations. The cron watches them (`patternsOutOfStep`):
   * once another application covers one, the install is due a resync.
   * Empty when none.
   */
  overLimit: string[];
}

/** An install's protection as recorded. */
export interface InstallProtection {
  accessAppId: string;
  probesPolicyId: string | null;
  /** The application's audience tag: the `aud` claim of the JWTs Access sends the app. */
  aud: string | null;
  /** `<team>.cloudflareaccess.com`: the issuer of those JWTs, and where their keys are. */
  teamDomain: string | null;
  coverage: AccessCoverageRecord | null;
  /**
   * When bringing its Access applications in step with its addresses or
   * public paths last failed outside a job; the cron tries again. Null when
   * the last sync succeeded.
   */
  syncFailedAt: Date | null;
  /**
   * When bringing them in step became due, nothing having failed (a catalog
   * revision changed its public paths, an address left to another
   * application is free again, Appflare was updated); the cron does it.
   * Null when none is due.
   */
  resyncDueAt: Date | null;
  /** The "Appflare users" policy its application references, as last protected. */
  usersPolicyId: string | null;
  /**
   * When the cron found its Access application, or its public paths' one,
   * gone from the account; null while both exist. Protecting it clears it.
   */
  appMissingAt: Date | null;
}

export const PROTECT_MESSAGES = {
  noInstall: "This app is not installed.",
  removing: "This app is being uninstalled, so it cannot be protected.",
  selfDeploying: (name: string) =>
    `${name} is deployed by its own installer, which decides its Workers and addresses, so Appflare cannot protect it with Cloudflare Access yet. Add an Access application for it under Zero Trust, Access, Applications instead.`,
  noWorkers: "This app has no Worker yet, so there is nothing to protect.",
  workerMissing: (name: string) =>
    `The Worker "${name}" of this app is not in the Cloudflare account, so its addresses cannot be covered.`,
  noSubdomain:
    "This account has no workers.dev subdomain yet, so the app's workers.dev address cannot be covered.",
  conflict: (other: string, covered: readonly string[]) =>
    `The Cloudflare Access application "${other}" already covers ${listOf(covered)}, an address of this app. Delete it under Zero Trust, Access, Applications, or keep using it and leave Appflare's protection off for this app.`,
  overridden: (other: string, patterns: readonly string[]) =>
    `The Cloudflare Access application "${other}" also covers ${listOf(patterns)}; Appflare's application takes precedence on this app's addresses.`,
  taken: INSTALL_ACCESS_MESSAGES.addressTaken,
  previewsLeft: (p: { worker: string; uri: string; apps: string[]; sharedWith: string[] }) =>
    `The version previews of the Worker "${p.worker}" stay under the Cloudflare Access application ${listOf(p.apps.map((a) => `"${a}"`))}, which also covers them: naming them in Appflare's application (${p.uri}) would also cover the Worker ${listOf(p.sharedWith.map((w) => `"${w}"`))}, whose name ends the same way.`,
  wildcardLeft: (p: { uri: string; apps: string[]; sharedWith: WorkerAddress[] }) =>
    `This app's ${p.uri} stays under the Cloudflare Access application ${listOf(p.apps.map((a) => `"${a}"`))}, which also covers it: naming it in Appflare's application would also cover ${listOf(p.sharedWith.map((s) => `${s.address} of the Worker "${s.worker}"`))}.`,
  overLimit: (hosts: readonly string[]) =>
    `Cloudflare allows ${MAX_ACCESS_APP_DESTINATIONS} destinations on one Access application, so Appflare's application leaves out ${listOf(hosts)}; the app's Worker is still covered there through its own destination, and Appflare names one of them once another Access application comes to cover it.`,
  tooManyDestinations: (count: number) =>
    `Appflare's Cloudflare Access application for this app would need ${count} destinations (one per Worker and per external domain, and one per address another Access application also covers), more than the ${MAX_ACCESS_APP_DESTINATIONS} Cloudflare allows on one application. Remove some of the app's domains, or the other Access applications that cover them, then try again.`,
  appMissing:
    "This app's Cloudflare Access application no longer exists. Protect the app again to make a new one.",
} as const;

/** The application's name: says it is Appflare's, and which app and Worker it protects. */
export function accessAppName(label: string, workerName: string): string {
  return `Appflare: ${label} (${workerName})`;
}

/** `<worker>.<subdomain>.workers.dev`. */
function workersDevHost(worker: string, subdomain: string): string {
  return `${worker}.${subdomain}.workers.dev`.toLowerCase();
}

/** The Worker's version previews: `<first 8 hex of the version>-<worker>.<subdomain>.workers.dev`. */
function previewsPattern(worker: string, subdomain: string): string {
  return `*-${workersDevHost(worker, subdomain)}`;
}

/** The install's primary Worker first, the others in the order given. */
function primaryFirst<W extends { name: string }>(workers: readonly W[], primary: string): W[] {
  return [
    ...workers.filter((w) => w.name === primary),
    ...workers.filter((w) => w.name !== primary),
  ];
}

/**
 * For each hostname or pattern of the install, the other applications whose
 * patterns cover it more broadly than the install's own destination would
 * (`*.<subdomain>.workers.dev` over `cut.<subdomain>.workers.dev`), with a
 * path or not. Access picks such a pattern over a `worker` destination, and
 * an exact hostname over the pattern (verified live 2026-10-11), so those
 * addresses must be named.
 */
function broaderAppsOf(others: readonly AccessApp[]): (host: string) => string[] {
  const named = others.map((app) => ({
    name: app.name ?? app.id,
    hosts: accessAppCoverage(app).hostnames,
  }));
  return (host) =>
    named
      .filter((o) => o.hosts.some((theirs) => !inside(theirs, host) && hostMatcher(theirs)(host)))
      .map((o) => o.name);
}

/**
 * The install's Worker whose version previews' pattern is left out: another
 * application covers those previews, and naming them would also name
 * another Worker of the account whose name ends the same way
 * (`browser-relay` next to `relay`).
 */
export interface PreviewsLeft {
  worker: string;
  /** The pattern left out. */
  uri: string;
  /** The applications that decide who reaches those previews instead. */
  apps: string[];
  /** The account's Workers, not the install's, that the pattern would cover too. */
  sharedWith: string[];
}

/** An address a Worker of the account answers on in one of its zones. */
export interface WorkerAddress {
  /** The Worker's name. */
  worker: string;
  /** A Workers custom domain (`api.example.com`), or a zone route's pattern (`example.com/hooks/*`). */
  address: string;
}

/**
 * A hostname or pattern of one of the install's wildcard domains left out:
 * another application covers it, and naming it would also cover an address
 * of another Worker of the account (`api.<base>`, a custom domain of an
 * unrelated Worker).
 */
export interface WildcardLeft {
  /** The base, or `*.<base>`. */
  uri: string;
  /** The applications that decide who reaches it instead. */
  apps: string[];
  /** The addresses of the account's other Workers it would cover too. */
  sharedWith: WorkerAddress[];
}

export interface DestinationPlan {
  destinations: AccessDestination[];
  previewsLeft: PreviewsLeft[];
  wildcardLeft: WildcardLeft[];
  /**
   * Hostnames left out to stay within {@link MAX_ACCESS_APP_DESTINATIONS}: each
   * one a Worker's own destination covers, and that no other application
   * covers more broadly. Empty almost always.
   */
  overLimit: string[];
}

export interface DestinationInput {
  workers: ReadonlyArray<{ name: string; tag: string | null }>;
  /** The account's workers.dev subdomain; null: none, so the Workers are covered by tag alone. */
  subdomain: string | null;
  customDomains?: readonly string[];
  wildcardBases?: readonly string[];
  externalHosts: readonly string[];
  /** The account's other Access applications: neither the install's own nor its public paths'. */
  others?: readonly AccessApp[];
  /**
   * Whether a hostname or pattern one of `others` names itself is left to
   * it (`takenAddresses`), as for an app already protected, rather than
   * refused. Such an address is planned but never sent, so it does not
   * count toward Cloudflare's limit. Default false.
   */
  leaveTaken?: boolean;
  /**
   * Every Worker of the account by name (its script list). Read only when
   * another application covers one of the install's Workers' version
   * previews ({@link previewsCoveredElsewhere}).
   */
  scripts?: readonly string[];
  /**
   * Every custom domain and zone route of the account's Workers
   * ({@link workerAddressesOf}). Read only when another application covers
   * one of the install's wildcard domains ({@link wildcardsCoveredElsewhere}).
   */
  workerAddresses?: readonly WorkerAddress[];
}

/** Whether another application covers the version previews of one of the install's Workers. */
export function previewsCoveredElsewhere(
  input: Pick<DestinationInput, "workers" | "subdomain" | "others">,
): boolean {
  const { subdomain } = input;
  if (subdomain === null) return false;
  const broader = broaderAppsOf(input.others ?? []);
  return input.workers.some((w) => broader(previewsPattern(w.name, subdomain)).length > 0);
}

/** A wildcard domain's base, then the pattern for every name under it. */
function wildcardUris(base: string): [string, string] {
  const lower = base.toLowerCase();
  return [lower, `*.${lower}`];
}

/** Whether another application covers the base or the names of one of the install's wildcard domains. */
export function wildcardsCoveredElsewhere(
  input: Pick<DestinationInput, "wildcardBases" | "others">,
): boolean {
  const broader = broaderAppsOf(input.others ?? []);
  return (input.wildcardBases ?? []).some((base) =>
    wildcardUris(base).some((uri) => broader(uri).length > 0),
  );
}

/**
 * The account's Workers' addresses in its zones: each Workers custom domain
 * (`domains`) and each zone route, which the script list carries per Worker
 * (`routes`), so no zone's own route list is read.
 */
export function workerAddressesOf(
  scripts: readonly WorkerScript[],
  domains: readonly WorkerDomain[],
): WorkerAddress[] {
  return [
    ...domains.map((d) => ({ worker: d.service, address: d.hostname.toLowerCase() })),
    ...scripts.flatMap((s) =>
      (s.routes ?? []).map((r) => ({ worker: s.id, address: r.pattern.toLowerCase() })),
    ),
  ];
}

/**
 * The addresses of Workers not in `own` that `uri` matches as written: a
 * custom domain, or a route's host (`*.<base>` matches `api.<base>/*` and
 * `*.eu.<base>/*`; `<base>` matches `<base>/hooks/*`). The install's own
 * routes are never among them.
 */
function othersUnder(
  uri: string,
  addresses: readonly WorkerAddress[],
  own: ReadonlySet<string>,
): WorkerAddress[] {
  const matches = hostMatcher(uri);
  return addresses.filter((a) => {
    if (own.has(a.worker.toLowerCase())) return false;
    const host = a.address.replace(/^https?:\/\//, "").split("/", 1)[0] ?? "";
    return matches(host);
  });
}

/**
 * The destinations that cover the install, each once, in this order: each
 * Worker's workers.dev hostname (and its previews' pattern, see below), the
 * custom domains, the wildcard domains' bases and `*.<base>` (see below),
 * the external domains, then each Worker that exists by its tag. Cloudflare sets an
 * application's `domain` to its first destination when that is a hostname,
 * and to nothing when it is a Worker (checked live 2026-10-11), so this
 * order names the application by the primary Worker's workers.dev address,
 * before and after the Workers are uploaded.
 *
 * Required, whatever the limit: each `worker` destination; the workers.dev
 * hostname of a Worker not uploaded yet, which only it covers; each
 * external domain, which reaches the Worker through the gateway Worker and
 * so is not named by a `worker` destination; and every hostname or pattern
 * another application covers more broadly. The other workers.dev and
 * custom domain hostnames are named too, so an application made later for
 * a broader pattern does not take them over, as long as Cloudflare's limit
 * leaves room; past it they are left out (`overLimit`), the Worker's
 * destination covering them still. More required destinations than the
 * limit are refused. An address another application names itself, when
 * left to it (`leaveTaken`), is planned whatever the limit but counts
 * toward nothing: the caller takes it out before writing.
 *
 * A Worker's previews' pattern (`*-<worker>`) is named only when another
 * application covers those previews (its `worker` destination covers them
 * otherwise), since it also matches the address of any Worker whose name
 * ends in `-<worker>`. With such a Worker in the account (`scripts`), not
 * the install's own, the pattern is left out (`previewsLeft`) and the other
 * application keeps deciding there.
 *
 * A wildcard domain's base and `*.<base>` follow the same rule, each on its
 * own: the domain's two routes send them to the Worker, so its `worker`
 * destination covers them, and they are named only when another
 * application covers them. `*.<base>` also matches a custom domain or a
 * route of another Worker under the base (`api.<base>`, which the domain's
 * routes do not take), and `<base>` a route of another Worker on a path of
 * it; with such an address in the account (`workerAddresses`), the one
 * that matches it is left out (`wildcardLeft`).
 */
export function planDestinations(input: DestinationInput): DestinationPlan {
  const broader = broaderAppsOf(input.others ?? []);
  const candidates: Array<{ destination: AccessDestination; required: boolean }> = [];
  const add = (destination: AccessDestination, required: boolean) => {
    const key = destinationKey(destination);
    const known = candidates.find((c) => destinationKey(c.destination) === key);
    if (known === undefined) candidates.push({ destination, required });
    else known.required ||= required;
  };
  const host = (uri: string, required = false) => {
    const lower = uri.toLowerCase();
    add({ type: "public", uri: lower }, required || broader(lower).length > 0);
  };
  const sorted = (hosts: readonly string[] | undefined) =>
    [...new Set((hosts ?? []).map((h) => h.toLowerCase()))].sort();
  const own = new Set(input.workers.map((w) => w.name.toLowerCase()));
  const previewsLeft: PreviewsLeft[] = [];
  for (const w of input.workers) {
    if (input.subdomain === null) {
      // Before its upload a Worker has no tag, so only its hostname can cover it.
      if (w.tag === null) throw new AccessToggleError(PROTECT_MESSAGES.noSubdomain);
      continue;
    }
    host(workersDevHost(w.name, input.subdomain), w.tag === null);
    const previews = previewsPattern(w.name, input.subdomain);
    const apps = broader(previews);
    if (apps.length === 0) continue;
    if (input.scripts === undefined) {
      throw new Error("planDestinations needs the account's script list");
    }
    const suffix = `-${w.name.toLowerCase()}`;
    const sharedWith = input.scripts.filter(
      (s) => s.toLowerCase().endsWith(suffix) && !own.has(s.toLowerCase()),
    );
    if (sharedWith.length > 0) {
      previewsLeft.push({ worker: w.name, uri: previews, apps, sharedWith });
    } else {
      add({ type: "public", uri: previews }, true);
    }
  }
  for (const domain of sorted(input.customDomains)) host(domain);
  const wildcardLeft: WildcardLeft[] = [];
  for (const base of sorted(input.wildcardBases)) {
    for (const uri of wildcardUris(base)) {
      const apps = broader(uri);
      if (apps.length === 0) continue;
      if (input.workerAddresses === undefined) {
        throw new Error("planDestinations needs the account's Worker addresses");
      }
      const sharedWith = othersUnder(uri, input.workerAddresses, own);
      if (sharedWith.length > 0) wildcardLeft.push({ uri, apps, sharedWith });
      else add({ type: "public", uri }, true);
    }
  }
  for (const external of sorted(input.externalHosts)) host(external, true);
  for (const w of input.workers) {
    if (w.tag !== null) add({ type: "worker", worker_id: w.tag }, true);
  }
  const ownerOf = namedItselfBy(input.leaveTaken === true ? (input.others ?? []) : []);
  const unsent = (d: AccessDestination) => d.type === "public" && ownerOf(d.uri) !== undefined;
  const required = candidates.filter((c) => c.required && !unsent(c.destination)).length;
  if (required > MAX_ACCESS_APP_DESTINATIONS) {
    throw new AccessToggleError(PROTECT_MESSAGES.tooManyDestinations(required));
  }
  let room = MAX_ACCESS_APP_DESTINATIONS - required;
  const destinations: AccessDestination[] = [];
  const overLimit: string[] = [];
  for (const { destination, required } of candidates) {
    if (unsent(destination) || required) destinations.push(destination);
    else if (room > 0) {
      room -= 1;
      destinations.push(destination);
    } else if (destination.type === "public") overLimit.push(destination.uri);
  }
  return { destinations, previewsLeft, wildcardLeft, overLimit };
}

/** What the plan left out, as warnings for the job's or the cron's log. */
export function planWarnings(
  plan: Pick<DestinationPlan, "previewsLeft" | "wildcardLeft" | "overLimit">,
): string[] {
  return [
    ...plan.previewsLeft.map((p) => PROTECT_MESSAGES.previewsLeft(p)),
    ...plan.wildcardLeft.map((p) => PROTECT_MESSAGES.wildcardLeft(p)),
    ...(plan.overLimit.length > 0 ? [PROTECT_MESSAGES.overLimit(plan.overLimit)] : []),
  ];
}

function destinationKey(d: { type: string }): string {
  const fields = d as Record<string, unknown>;
  if (d.type === "worker") return `worker:${String(fields.worker_id)}`;
  if (d.type === "public") return `public:${String(fields.uri).toLowerCase()}`;
  return `${d.type}:${JSON.stringify(d)}`;
}

/** Whether two lists name the same hostnames, in any order. */
function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return sameDestinations(
    a.map((uri) => ({ type: "public", uri })),
    b.map((uri) => ({ type: "public", uri })),
  );
}

/** Whether two destination lists cover the same, in any order. */
export function sameDestinations(
  a: ReadonlyArray<{ type: string }>,
  b: ReadonlyArray<{ type: string }>,
): boolean {
  const ka = [...new Set(a.map(destinationKey))].sort();
  const kb = [...new Set(b.map(destinationKey))].sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** A hostname pattern (`*.example.com`, `*-name.sub.workers.dev`) as a matcher. */
function hostMatcher(pattern: string): (host: string) => boolean {
  const p = pattern.toLowerCase();
  if (!p.includes("*")) return (host) => host === p;
  const re = new RegExp(
    `^${p
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return (host) => re.test(host);
}

/**
 * Whether `theirs` (a hostname or pattern) names nothing but addresses
 * `mine` names. The install's version previews pattern (`*-<worker>.…`)
 * stands for `<first 8 hex of the version>-<worker>` hostnames only, so
 * another Worker's own address that ends the same way (`my-cut.…` next to
 * `cut`), or that Worker's previews pattern, is not inside it.
 */
function inside(theirs: string, mine: string): boolean {
  if (theirs === mine) return true;
  if (!mine.startsWith("*-")) return hostMatcher(mine)(theirs);
  const rest = mine.slice(1);
  if (!theirs.endsWith(rest)) return false;
  const prefix = theirs.slice(0, -rest.length);
  return prefix.includes("*") ? /^[0-9a-f*]+$/.test(prefix) : /^[0-9a-f]{8}$/.test(prefix);
}

/** What the install's protection must not share with another application. */
interface InstallFootprint {
  /** Exact hostnames and patterns of the install's addresses. */
  hostnames: string[];
  /** Script tags of its Workers. */
  tags: string[];
  /**
   * Custom domains and zone routes of the account's other Workers under
   * one of the install's patterns (`api.<base>` under `*.<base>`): the
   * install does not answer there, and leaves them out of its application
   * (`othersUnder`), so another application naming one, as another
   * protected app's names its custom domain, does not overlap it.
   */
  othersAddresses?: readonly string[];
}

/** How another application's coverage meets the install's addresses. */
export interface Overlap {
  /**
   * The install's addresses it covers as narrowly as the install's
   * application, or more narrowly (a shared Worker, the same hostname or
   * pattern, a hostname or pattern inside one of the install's, with a path
   * or not): Access could pick it over the install's application there.
   */
  blocking: string[];
  /**
   * Its patterns (`*.example.com`, with a path or not) that also cover
   * addresses of the install, and cover them more broadly. The install's
   * application names each such address as a hostname of its own, which
   * Access picks over a broader pattern.
   */
  broader: string[];
}

/**
 * Where `coverage` (another application's) meets the install's addresses. A
 * pattern counts as covering an address when its matcher accepts the
 * address as written, so `*.sub.workers.dev` covers `*-cut.sub.workers.dev`
 * (every hostname that matches the second matches the first). A false
 * conflict is cheaper than two applications on one address.
 *
 * Verified live 2026-10-11: with an application of `worker`, `public <host>`
 * and `public *-<host>` destinations for a Worker, and another one with
 * `public *.<sub>.workers.dev`, the first answered on both hostnames; with
 * the `worker` destination alone, the wildcard did. The same held for a
 * wildcard with a path (`*.<sub>.workers.dev/<path>/*`): the exact hostname
 * answered on that path too. Cloudflare itself refuses a second application
 * with the same Worker, hostname or pattern (409), and accepts a broader
 * pattern or the same hostname with a path.
 */
export function overlap(coverage: AccessAppCoverage, ours: InstallFootprint): Overlap {
  const blocking = new Set<string>();
  const broader = new Set<string>();
  for (const tag of coverage.workerIds) {
    if (ours.tags.includes(tag)) blocking.add("one of its Workers");
  }
  for (const uri of coverage.uris) {
    const theirs = uri.split("/", 1)[0] as string;
    const covers = hostMatcher(theirs);
    const elsewhere = (ours.othersAddresses ?? []).some((address) => answersOn(address, uri));
    for (const mine of ours.hostnames) {
      if (inside(theirs, mine)) {
        if (theirs !== mine && elsewhere) continue;
        blocking.add(mine);
      } else if (covers(mine)) broader.add(uri);
    }
  }
  return { blocking: [...blocking], broader: [...broader] };
}

/**
 * Whether a Worker's `address` (a custom domain, or a zone route's pattern)
 * takes all of `uri` (a hostname or pattern, with a path or not): a custom
 * domain or a `/*` route every path of its hostname, a route with a path
 * the paths under it. A false "no" only costs a refusal.
 */
function answersOn(address: string, uri: string): boolean {
  const bare = address.replace(/^https?:\/\//, "").toLowerCase();
  const slash = bare.indexOf("/");
  const host = slash === -1 ? bare : bare.slice(0, slash);
  const path = slash === -1 ? "" : bare.slice(slash);
  const at = uri.indexOf("/");
  const uriHost = at === -1 ? uri : uri.slice(0, at);
  const uriPath = at === -1 ? "" : uri.slice(at);
  if (!hostMatcher(host)(uriHost)) return false;
  if (path === "" || path === "/*") return true;
  return path.endsWith("*") ? uriPath.startsWith(path.slice(0, -1)) : uriPath === path;
}

/** Whether everything `app` covers is one of the install's own addresses (and it covers something). */
function coversOnly(app: AccessApp, ours: InstallFootprint): boolean {
  const coverage = accessAppCoverage(app);
  if (coverage.uris.length + coverage.workerIds.length === 0) return false;
  if (coverage.uris.some((uri) => uri.includes("/"))) return false;
  return (
    coverage.workerIds.every((tag) => ours.tags.includes(tag)) &&
    coverage.hostnames.every((host) => ours.hostnames.some((mine) => hostMatcher(mine)(host)))
  );
}

/**
 * Which of `destinations` (the install's) an application of `others` names
 * itself, without a path, and which application does. A `worker`
 * destination is never among them.
 */
export function takenAddresses(
  others: readonly AccessApp[],
  destinations: ReadonlyArray<{ type: string; uri?: unknown }>,
): TakenAddress[] {
  const ownerOf = namedItselfBy(others);
  const out: TakenAddress[] = [];
  for (const d of destinations) {
    if (d.type !== "public" || typeof d.uri !== "string") continue;
    const uri = d.uri.toLowerCase();
    const owner = ownerOf(uri);
    if (owner !== undefined) out.push({ uri, app: owner.name ?? owner.id });
  }
  return out;
}

/** The application of `others` that names a hostname or pattern itself, without a path. */
function namedItselfBy(others: readonly AccessApp[]): (uri: string) => AccessApp | undefined {
  const named = others.map((app) => ({ app, uris: accessAppCoverage(app).uris }));
  return (uri) => named.find((o) => o.uris.includes(uri.toLowerCase()))?.app;
}

/** `destinations` without those `taken` names. */
function withoutTaken(
  destinations: readonly AccessDestination[],
  taken: readonly TakenAddress[],
): AccessDestination[] {
  return destinations.filter(
    (d) => d.type !== "public" || !taken.some((t) => t.uri === d.uri.toLowerCase()),
  );
}

// ---------------------------------------------------------------- records

type Row = typeof install_access.$inferSelect;

function parseCoverage(json: string | null): AccessCoverageRecord | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as Partial<AccessCoverageRecord>;
    if (!Array.isArray(value.destinations)) return null;
    return {
      destinations: value.destinations,
      workerTags:
        typeof value.workerTags === "object" && value.workerTags !== null ? value.workerTags : {},
      // Absent from a record written before addresses could be left to another application.
      taken: Array.isArray(value.taken) ? value.taken : [],
      overLimit: Array.isArray(value.overLimit) ? value.overLimit : [],
    };
  } catch {
    return null;
  }
}

function protectionOf(row: Row): InstallProtection | null {
  if (row.access_app_id === null) return null;
  return {
    accessAppId: row.access_app_id,
    probesPolicyId: row.probes_policy_id,
    aud: row.access_aud,
    teamDomain: row.access_team_domain,
    coverage: parseCoverage(row.access_destinations_json),
    syncFailedAt: row.access_sync_failed_at ?? null,
    resyncDueAt: row.access_resync_due_at ?? null,
    usersPolicyId: row.users_policy_id ?? null,
    appMissingAt: row.access_app_missing_at ?? null,
  };
}

/**
 * Records that bringing the install's Access applications in step failed
 * (`at`), or that it succeeded (null), which settles a resync that was due
 * too. The cron tries again while either is set
 * (`resyncInstallAccessIfFailed`).
 */
export async function recordAccessSyncFailure(
  d1: D1Database,
  installId: string,
  at: Date | null,
): Promise<void> {
  await createDb(d1)
    .update(install_access)
    .set(
      at === null
        ? { access_sync_failed_at: null, access_resync_due_at: null }
        : { access_sync_failed_at: at },
    )
    .where(eq(install_access.install_id, installId));
}

/**
 * The install's protection as recorded, or null when Appflare does not
 * protect it. Its `aud` and `teamDomain` are what an app verifies Access's
 * JWTs with. D1 only.
 */
export async function readInstallProtection(
  d1: D1Database,
  installId: string,
): Promise<InstallProtection | null> {
  const [row] = await createDb(d1)
    .select()
    .from(install_access)
    .where(eq(install_access.install_id, installId))
    .limit(1);
  return row === undefined ? null : protectionOf(row);
}

async function recordProtection(
  deps: Pick<InstallAccessDeps, "db" | "now">,
  installId: string,
  app: { id: string; name: string },
  protection: {
    probesPolicyId: string | null;
    aud: string;
    teamDomain: string;
    coverage: AccessCoverageRecord;
    usersPolicyId: string;
  },
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const orm = createDb(deps.db);
  await orm.batch([
    orm
      .update(install_access)
      .set({
        access_app_id: app.id,
        probes_policy_id: protection.probesPolicyId,
        access_aud: protection.aud,
        access_team_domain: protection.teamDomain,
        access_destinations_json: JSON.stringify(protection.coverage),
        users_policy_id: protection.usersPolicyId,
        access_app_missing_at: null,
        updated_at: at,
      })
      .where(eq(install_access.install_id, installId)),
    orm
      .insert(resources)
      .values({
        id: accessAppResourceId(installId),
        install_id: installId,
        kind: ACCESS_APP_KIND,
        binding: null,
        name: app.name,
        cf_id: app.id,
        created_at: at,
      })
      .onConflictDoUpdate({
        target: resources.id,
        set: { name: app.name, cf_id: app.id, deleted_at: null, retained_at: null },
      }),
  ]);
}

async function recordCoverage(
  deps: Pick<InstallAccessDeps, "db" | "now">,
  installId: string,
  coverage: AccessCoverageRecord,
): Promise<void> {
  await createDb(deps.db)
    .update(install_access)
    .set({
      access_destinations_json: JSON.stringify(coverage),
      updated_at: (deps.now ?? (() => new Date()))(),
    })
    .where(eq(install_access.install_id, installId));
}

/** The install's addresses as recorded (not deleted). */
async function recordedAddresses(d1: D1Database, installId: string) {
  const rows = await createDb(d1)
    .select({ kind: resources.kind, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, [
          "worker",
          CUSTOM_DOMAIN_KIND,
          CUSTOM_HOSTNAME_KIND,
          WILDCARD_DOMAIN_KIND,
        ]),
        isNull(resources.deleted_at),
      ),
    );
  const of = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.name);
  return {
    workers: of("worker"),
    customDomains: of(CUSTOM_DOMAIN_KIND),
    wildcardBases: of(WILDCARD_DOMAIN_KIND),
    externalDomains: of(CUSTOM_HOSTNAME_KIND),
  };
}

/** The install's primary Worker's name, or null when the install is not recorded. */
async function primaryWorkerName(d1: D1Database, installId: string): Promise<string | null> {
  const [row] = await createDb(d1)
    .select({ workerName: installs.worker_name })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  return row?.workerName ?? null;
}

// ---------------------------------------------------------------- Cloudflare

function isForbidden(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 403 || error.status === 401);
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/**
 * Cloudflare refusing an application a destination another application
 * names itself (verified live 2026-10-11): the same hostname answers 409
 * [11010], the same pattern (`*-<host>`) or Worker 409 [12132].
 */
function isNamedElsewhere(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 409;
}

async function policiesCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isForbidden(error)) throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.policiesPermission);
    throw error;
  }
}

/** The team domain, refusing an account without Zero Trust or a token that cannot read it. */
async function teamDomainOf(client: CloudflareClient): Promise<string> {
  let domain: string;
  try {
    domain = (await client.access.getOrganization()).auth_domain;
  } catch (error) {
    if (isNotFound(error)) throw new AccessToggleError(ACCESS_MESSAGES.noOrganization);
    if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.organizationPermission);
    throw error;
  }
  if (!isAccessTeamDomain(domain)) {
    throw new AccessToggleError(
      `The Zero Trust organization's team domain "${domain}" is not a cloudflareaccess.com domain, which Appflare cannot verify tokens from.`,
    );
  }
  return domain;
}

/** The account's workers.dev subdomain: from settings, else asked once and kept. */
async function accountSubdomain(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
): Promise<string | null> {
  const orm = createDb(deps.db);
  const cached = (await readSettings(orm, [SETTING.accountSubdomain])).account_subdomain;
  if (cached) return cached;
  try {
    const found = (await deps.client.workers.getAccountSubdomain()).subdomain;
    if (!found) return null;
    await writeSettings(
      orm,
      { [SETTING.accountSubdomain]: found },
      (deps.now ?? (() => new Date()))(),
    );
    return found;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Fills in the tags left out (`tag` undefined) from one script list; a
 * Worker not listed is refused. Answers the account's script list too when
 * it read it.
 */
async function withTags(
  client: CloudflareClient,
  workers: readonly ProtectWorker[],
  known: Readonly<Record<string, string>> = {},
): Promise<{ workers: Array<{ name: string; tag: string | null }>; scripts?: WorkerScript[] }> {
  const resolved = workers.map((w) => ({
    name: w.name,
    tag: w.tag === undefined ? (known[w.name] ?? undefined) : w.tag,
  }));
  if (resolved.every((w) => w.tag !== undefined)) {
    return { workers: resolved as Array<{ name: string; tag: string | null }> };
  }
  const scripts = await client.workers.listScripts();
  const out: Array<{ name: string; tag: string | null }> = [];
  for (const w of resolved) {
    if (w.tag !== undefined) {
      out.push({ name: w.name, tag: w.tag });
      continue;
    }
    const tag = scripts.find((s) => s.id === w.name)?.tag;
    if (typeof tag !== "string" || tag.length === 0) {
      throw new AccessToggleError(PROTECT_MESSAGES.workerMissing(w.name));
    }
    out.push({ name: w.name, tag });
  }
  return { workers: out, scripts };
}

/**
 * The account's Workers, each list read once at most and only when asked
 * for: the script list, unless `scripts` (from `withTags`) is that list
 * already, and the Workers custom domains (one call, every one in one page).
 */
export function accountWorkersOf(
  client: CloudflareClient,
  scripts?: readonly WorkerScript[],
): AccountWorkers {
  let listed: Promise<readonly WorkerScript[]> | null =
    scripts === undefined ? null : Promise.resolve(scripts);
  let addresses: Promise<WorkerAddress[]> | null = null;
  const list = () => {
    listed ??= client.workers.listScripts();
    return listed;
  };
  return {
    scripts: async () => (await list()).map((s) => s.id),
    addresses: () => {
      addresses ??= Promise.all([list(), client.workerDomains.listDomains()]).then(
        ([all, domains]) => workerAddressesOf(all, domains),
      );
      return addresses;
    },
  };
}

/**
 * The install's destinations against the account's other applications
 * (`planDestinations`), reading what the plan needs of the account's
 * Workers only when it needs it: the script list when another application
 * covers a Worker's version previews or a wildcard domain, and for the
 * latter the Workers custom domains too.
 */
async function planAgainst(
  input: Omit<DestinationInput, "scripts" | "workerAddresses">,
  account: AccountWorkers,
): Promise<DestinationPlan> {
  const wildcards = wildcardsCoveredElsewhere(input);
  const scripts =
    wildcards || previewsCoveredElsewhere(input) ? await account.scripts() : undefined;
  const workerAddresses = wildcards ? await account.addresses() : undefined;
  return planDestinations({
    ...input,
    ...(scripts === undefined ? {} : { scripts }),
    ...(workerAddresses === undefined ? {} : { workerAddresses }),
  });
}

function coverageOf(
  workers: ReadonlyArray<{ name: string; tag: string | null }>,
  destinations: AccessDestination[],
  taken: TakenAddress[],
  overLimit: string[],
): AccessCoverageRecord {
  const workerTags: Record<string, string> = {};
  for (const w of workers) if (w.tag !== null) workerTags[w.name] = w.tag;
  return { destinations, workerTags, taken, overLimit };
}

/** The inline token policy, at precedence 2 behind "Appflare users". */
function probesPolicyArgs(installId: string, tokenId: string): AccessPolicyArgs {
  return { ...probesPolicy(installId, tokenId), precedence: 2 };
}

/** The policy entry of the install's own token policy on `app`, by its recorded id or its name. */
function probesEntry(
  app: AccessApp,
  installId: string,
  probesPolicyId: string | null,
): { id: string; precedence?: number } | undefined {
  return (app.policies ?? []).find(
    (p) =>
      (probesPolicyId !== null && p.id === probesPolicyId) ||
      p.name === probesPolicyName(installId),
  );
}

export type ProtectOutcome =
  /** A new application was made. */
  | "created"
  /** An application made earlier for this install, whose id was not recorded, was taken over. */
  | "adopted"
  /** The application existed and was rewritten. */
  | "updated"
  /** The application already covered everything as wanted. */
  | "unchanged";

export interface ProtectRequest {
  installId: string;
  /**
   * The install's Workers. Default: those recorded, each looked up in the
   * account's script list. The install job names them itself: before their
   * uploads with `tag: null`, after with the tags the uploads answered.
   */
  workers?: readonly ProtectWorker[];
  /** The app's name, when the install has no recorded manifest yet (the install job). */
  appName?: string;
  /** External domains about to be added: covered before they serve anything. */
  pendingExternalHosts?: readonly string[];
  /**
   * The public paths the admin accepts by protecting the app: the entry's
   * (`access.bypass`) as the install job read it. Default: those of the
   * release the install runs.
   */
  acceptPaths?: readonly string[];
}

export interface ProtectResult {
  outcome: ProtectOutcome;
  accessAppId: string;
  appName: string;
  aud: string;
  teamDomain: string;
  destinations: AccessDestination[];
  /**
   * Other Access applications whose broader patterns also cover addresses of
   * the app (`overlap`), and those patterns. Left as they are: the app's own
   * application takes precedence on its addresses.
   */
  overridden: Array<{ name: string; patterns: string[] }>;
  /**
   * Addresses of an app already protected that another application names
   * itself, left to it as the sync leaves them (`syncInstallAccessDestinations`);
   * mostly none.
   */
  taken: TakenAddress[];
  /** What the application leaves out besides (`planWarnings`), for the job's log. */
  warnings: string[];
  /** What happened to the app's public paths (bypass.server.ts). */
  bypass: { outcome: BypassOutcome; uris: string[] } | null;
  /**
   * Why the public paths could not be brought in step: they then ask for a
   * sign-in like the rest of the app. Null when they could.
   */
  bypassProblem: string | null;
}

/**
 * Protects the install with its own Access application, or brings the one
 * it has in step (idempotent; see the module comment). Checks everything
 * that can be checked first (the install, the Zero Trust organization, that
 * no other application covers any of the install's addresses as narrowly as
 * its own would, that the token reads service tokens), then makes
 * sure "Appflare users" and the install's token exist, then creates or
 * rewrites the application, then records it. Throws `AccessToggleError`
 * with a message for people on a refusal.
 *
 * For an app already protected ("Protect again"), an address another
 * application names itself is left to it (`taken`) as the sync leaves it,
 * instead of refusing: such an application can only have named it first,
 * and refusing would also refuse the repairs protecting again is for (a
 * new "Appflare users" policy, an application deleted in the dashboard). A
 * pending external domain it names is still refused.
 */
export function protectInstall(
  deps: InstallAccessDeps,
  request: ProtectRequest,
): Promise<ProtectResult> {
  return withAccessLock(deps.db, () => protectLocked(deps, request));
}

async function protectLocked(
  deps: InstallAccessDeps,
  request: ProtectRequest,
): Promise<ProtectResult> {
  const { installId } = request;
  const { client } = deps;
  const [install] = await createDb(deps.db)
    .select({
      id: installs.id,
      status: installs.status,
      buildKind: installs.build_kind,
      workerName: installs.worker_name,
      displayName: installs.display_name,
      appSlug: installs.app_slug,
      manifestJson: installs.manifest_json,
      artifactDigest: installs.artifact_digest,
    })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) throw new AccessToggleError(PROTECT_MESSAGES.noInstall);
  const name =
    request.appName ??
    recordedName({ app_slug: install.appSlug, manifest_json: install.manifestJson });
  if (install.buildKind === "self-deploying") {
    throw new AccessToggleError(PROTECT_MESSAGES.selfDeploying(name));
  }
  if (install.status === "uninstalling" || install.status === "uninstalled") {
    throw new AccessToggleError(PROTECT_MESSAGES.removing);
  }
  const appName = accessAppName(
    installLabel({ displayName: install.displayName, name }),
    install.workerName,
  );

  // Read-only checks first: nothing is made for an install that cannot be protected.
  const recorded = await recordedAddresses(deps.db, installId);
  const wanted: ProtectWorker[] = primaryFirst(
    request.workers ?? recorded.workers.map((w) => ({ name: w })),
    install.workerName,
  );
  if (wanted.length === 0) throw new AccessToggleError(PROTECT_MESSAGES.noWorkers);
  const record = await readInstallAccess(deps.db, installId);
  const known = (await readInstallProtection(deps.db, installId))?.coverage?.workerTags ?? {};
  const { workers, scripts } = await withTags(client, wanted, known);
  const subdomain = await accountSubdomain(deps);
  const teamDomain = await teamDomainOf(client);
  const apps = await policiesCall(() => client.access.listApps());
  // The service token permission too, before "Appflare users" is made below.
  const serviceTokens = await listAccessServiceTokens(client);
  const pending = new Set((request.pendingExternalHosts ?? []).map((h) => h.toLowerCase()));
  const externalHosts = [
    ...new Set([...recorded.externalDomains.map((h) => h.toLowerCase()), ...pending]),
  ];
  const footprint: InstallFootprint = {
    hostnames: [
      ...(subdomain === null
        ? []
        : workers.flatMap((w) => [
            workersDevHost(w.name, subdomain),
            previewsPattern(w.name, subdomain),
          ])),
      ...recorded.customDomains,
      ...recorded.wildcardBases.flatMap((b) => [b, `*.${b}`]),
      ...externalHosts,
    ].map((h) => h.toLowerCase()),
    tags: workers.flatMap((w) => (w.tag === null ? [] : [w.tag])),
  };
  const byId = record?.accessAppId ?? null;
  const bypassId = await recordedBypassAppId(deps.db, installId);
  // An unrecorded application is this install's when its token policy says
  // so (the name carries the install id), or when it has this install's
  // application name and covers nothing but this install's addresses; an
  // application made by hand under that name for more is never taken over.
  const ours =
    apps.find((a) => byId !== null && a.id === byId) ??
    apps.find((a) => (a.policies ?? []).some((p) => p.name === probesPolicyName(installId))) ??
    apps.find((a) => a.name === appName && coversOnly(a, footprint));
  const others = (list: readonly AccessApp[]) =>
    list.filter((a) => a.id !== ours?.id && !isBypassAppOf(a, installId, bypassId));
  const account = accountWorkersOf(client, scripts);
  const plan = await planAgainst(
    {
      workers,
      subdomain,
      customDomains: recorded.customDomains,
      wildcardBases: recorded.wildcardBases,
      externalHosts,
      others: others(apps),
      leaveTaken: byId !== null,
    },
    account,
  );
  // Addresses another application names itself: left to it for an app
  // already protected; a refusal below for one being protected now.
  const takenFrom = (list: readonly AccessApp[]) => {
    if (byId === null) return [];
    const taken = takenAddresses(others(list), plan.destinations);
    const notYet = taken.find((t) => pending.has(t.uri));
    if (notYet !== undefined) {
      throw new AccessToggleError(PROTECT_MESSAGES.conflict(notYet.app, [notYet.uri]));
    }
    return taken;
  };
  // Under a wildcard domain's `*.<base>`, another Worker's custom domain or
  // route is not the install's (`othersUnder`): read only when another
  // application names something under that pattern, once.
  const own = new Set(workers.map((w) => w.name.toLowerCase()));
  const wildcardNames = recorded.wildcardBases.map((b) => `*.${b.toLowerCase()}`);
  let othersAddresses: string[] | null = null;
  const footprintFor = async (coverage: AccessAppCoverage): Promise<InstallFootprint> => {
    const under = coverage.hostnames.some((h) =>
      wildcardNames.some((p) => h !== p && hostMatcher(p)(h)),
    );
    if (under && othersAddresses === null) {
      const addresses = await account.addresses();
      othersAddresses = wildcardNames.flatMap((p) =>
        othersUnder(p, addresses, own).map((a) => a.address),
      );
    }
    return othersAddresses === null ? footprint : { ...footprint, othersAddresses };
  };
  // Another application on the same addresses, or on part of them, is
  // refused; one whose patterns are broader (a `*.<sub>.workers.dev` made by
  // hand) is left as it is, as the install's application names each of its
  // addresses as a hostname of its own and so takes precedence there.
  // The install's own public paths cover its own addresses, by design.
  const refuseConflicts = async (list: readonly AccessApp[], taken: readonly TakenAddress[]) => {
    for (const other of others(list)) {
      const coverage = accessAppCoverage(other);
      const blocking = overlap(coverage, await footprintFor(coverage)).blocking.filter(
        (mine) => !taken.some((t) => t.uri === mine && coverage.uris.includes(mine)),
      );
      if (blocking.length > 0) {
        throw new AccessToggleError(PROTECT_MESSAGES.conflict(other.name ?? other.id, blocking));
      }
    }
  };
  let taken = takenFrom(apps);
  await refuseConflicts(apps, taken);
  const overridden: ProtectResult["overridden"] = [];
  for (const other of others(apps)) {
    const { broader } = overlap(accessAppCoverage(other), footprint);
    if (broader.length > 0) overridden.push({ name: other.name ?? other.id, patterns: broader });
  }
  /**
   * Cloudflare refused a destination another application names: one made
   * since the listing above. Refused in the same words as one found there,
   * or, for an app already protected, written again without what it names.
   */
  const write = async (
    run: (to: AccessDestination[]) => Promise<AccessApp>,
  ): Promise<AccessApp> => {
    try {
      return await policiesCall(() => run(withoutTaken(plan.destinations, taken)));
    } catch (error) {
      if (!isNamedElsewhere(error)) throw error;
      const listed = await policiesCall(() => client.access.listApps());
      const again = takenFrom(listed);
      await refuseConflicts(listed, again);
      if (again.every((t) => taken.some((k) => k.uri === t.uri))) throw error;
      taken = again;
      return policiesCall(() => run(withoutTaken(plan.destinations, taken)));
    }
  };

  // Then what the application references, then the application.
  const users = await ensureAppAccessUsersPolicy(deps);
  const token = await ensureInstallServiceToken(deps, installId, serviceTokens);
  // Read again: a token made anew points the recorded application's policy at itself.
  const probesPolicyId = (await readInstallAccess(deps.db, installId))?.probesPolicyId ?? null;

  let outcome: ProtectOutcome;
  let written: AccessApp;
  if (ours === undefined) {
    written = await write((destinations) =>
      client.access.createApp({
        type: "self_hosted",
        name: appName,
        destinations,
        session_duration: ACCESS_SESSION_DURATION,
        app_launcher_visible: false,
        policies: [
          { id: users.policyId, precedence: 1 },
          probesPolicyArgs(installId, token.tokenId),
        ],
      }),
    );
    outcome = "created";
  } else {
    const adopted = ours.id !== byId;
    // An adopted application gets a new token policy: the one it has may name an older token.
    const probes = adopted ? undefined : probesEntry(ours, installId, probesPolicyId);
    const kept = policyReferences(
      (ours.policies ?? []).filter(
        (p) =>
          p.id === probes?.id ||
          (p.id !== probesPolicyId && p.name !== probesPolicyName(installId)),
      ),
    );
    const next = (): number => Math.max(0, ...kept.map((p) => p.precedence ?? 0)) + 1;
    const policies: Array<{ id: string; precedence?: number } | AccessPolicyArgs> = [...kept];
    if (!kept.some((p) => p.id === users.policyId)) {
      policies.push({ id: users.policyId, precedence: next() });
    }
    if (probes === undefined) {
      policies.push({ ...probesPolicy(installId, token.tokenId), precedence: next() });
    }
    const upToDate =
      !adopted &&
      probes !== undefined &&
      policies.length === kept.length &&
      ours.name === appName &&
      sameDestinations(ours.destinations ?? [], withoutTaken(plan.destinations, taken));
    if (upToDate) {
      written = ours;
      outcome = "unchanged";
    } else {
      try {
        written = await write((destinations) =>
          client.access.updateApp(ours.id, {
            ...accessAppSettings(ours),
            type: "self_hosted",
            name: appName,
            destinations,
            policies,
          } as CreateAccessAppArgs),
        );
      } catch (error) {
        if (isNotFound(error)) throw new AccessToggleError(PROTECT_MESSAGES.appMissing);
        throw error;
      }
      outcome = adopted ? "adopted" : "updated";
    }
  }
  const destinations = withoutTaken(plan.destinations, taken);
  const probesId =
    probesEntry(written, installId, outcome === "unchanged" ? probesPolicyId : null)?.id ??
    (written.policies ?? []).find((p) => p.decision === "non_identity")?.id ??
    null;
  const aud = written.aud || ours?.aud || "";
  await recordProtection(
    deps,
    installId,
    { id: written.id, name: appName },
    {
      probesPolicyId: probesId,
      aud,
      teamDomain,
      coverage: coverageOf(workers, destinations, taken, plan.overLimit),
      usersPolicyId: users.policyId,
    },
  );
  // Protecting is an admin's action, so it accepts the entry's public paths:
  // those the caller carries (an install, whose record has no release yet),
  // else those of the release the install runs.
  const orm = createDb(deps.db);
  await writeAcceptedBypass(
    orm,
    installId,
    request.acceptPaths ?? (await storedBypassPaths(orm, install)),
  );
  // The public paths, once the rest is protected. A failure leaves them
  // protected too (failing closed) and never undoes the protection.
  let bypass: ProtectResult["bypass"] = null;
  let bypassProblem: string | null = null;
  try {
    const synced = await syncInstallBypassLocked(deps, installId, { subdomain, apps });
    bypass = { outcome: synced.outcome, uris: synced.destinations.map((d) => d.uri) };
  } catch (error) {
    bypassProblem = error instanceof Error ? error.message : String(error);
  }
  return {
    outcome,
    accessAppId: written.id,
    appName,
    aud,
    teamDomain,
    destinations,
    overridden,
    taken,
    warnings: planWarnings(plan),
    bypass,
    bypassProblem,
  };
}

export type SyncOutcome =
  /** Appflare does not protect the install: nothing to keep in step (no Cloudflare call). */
  "not-protected" | "unchanged" | "updated";

export interface SyncResult {
  outcome: SyncOutcome;
  /** The addresses this sync left to another application that names them itself; mostly none. */
  taken: TakenAddress[];
  /** What the application leaves out besides (`planWarnings`), when this sync wrote it; mostly none. */
  warnings: string[];
}

/** Each application once, with the addresses `taken` leaves to it. */
export function takenByApp(taken: readonly TakenAddress[]): Array<{ app: string; uris: string[] }> {
  const out = new Map<string, string[]>();
  for (const t of taken) out.set(t.app, [...(out.get(t.app) ?? []), t.uri]);
  return [...out].map(([app, uris]) => ({ app, uris }));
}

/**
 * Brings the install's application in step with its addresses after they
 * changed: its Workers, by their recorded tags (a Worker without one is
 * looked up; one the account does not list is refused), with their
 * workers.dev hostnames, its custom and wildcard domains, and its external
 * domains, with `pendingExternalHosts` covered before they serve, planned
 * against the account's other applications (`planDestinations`; `apps`
 * when the caller listed them already). Writes only when the destinations
 * differ from those last written: a read of the application, then a `PUT`
 * of it as it is with the new destinations (so settings an admin changed in
 * the Zero Trust dashboard stay). A custom or wildcard domain comes off
 * after it is removed: until then the Worker's own destination covers it
 * as well.
 *
 * A hostname or pattern another application names itself is left to it
 * (never a `worker` destination): Cloudflare would refuse the `PUT` with it
 * (409). Those are recorded (`taken`) and answered, and the sync counts as
 * done, so neither a job nor the cron fails on it again. When Cloudflare
 * refuses anyway (an application made since the listing), a second listing
 * finds which, and the `PUT` goes again without them; a refusal that
 * listing does not explain is thrown as it came. A pending external domain
 * another application names is refused instead: it does not serve the app
 * yet.
 *
 * Then the install's public paths (bypass.server.ts), which do follow every
 * address, workers.dev being turned on or off included: nothing when the
 * entry lists none and none was made, else a read of the bypass application
 * and a rewrite when it changed. A failure there is thrown after the
 * install's own application is in step, and leaves the paths protected.
 */
export async function syncInstallAccessDestinations(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installId: string,
  opts: {
    pendingExternalHosts?: readonly string[];
    change?: BypassChange;
    apps?: readonly AccessApp[];
  } = {},
): Promise<SyncResult> {
  const none: SyncResult = { outcome: "not-protected", taken: [], warnings: [] };
  if ((await readInstallProtection(deps.db, installId)) === null) return none;
  return withAccessLock(deps.db, async (): Promise<SyncResult> => {
    const protection = await readInstallProtection(deps.db, installId);
    if (protection === null) return none;
    const recorded = await recordedAddresses(deps.db, installId);
    // A Worker whose tag cannot be found is refused, never left uncovered.
    const { workers, scripts } = await withTags(
      deps.client,
      primaryFirst(
        recorded.workers.map((name) => ({ name })),
        (await primaryWorkerName(deps.db, installId)) ?? "",
      ),
      protection.coverage?.workerTags ?? {},
    );
    const subdomain = await accountSubdomain(deps);
    const pending = new Set((opts.pendingExternalHosts ?? []).map((h) => h.toLowerCase()));
    const bypassId = await recordedBypassAppId(deps.db, installId);
    const othersOf = (list: readonly AccessApp[]) =>
      list.filter((a) => a.id !== protection.accessAppId && !isBypassAppOf(a, installId, bypassId));
    let apps = opts.apps ?? (await policiesCall(() => deps.client.access.listApps()));
    const plan = await planAgainst(
      {
        workers,
        subdomain,
        customDomains: recorded.customDomains,
        wildcardBases: recorded.wildcardBases,
        externalHosts: [...new Set([...recorded.externalDomains, ...pending])],
        others: othersOf(apps),
        leaveTaken: true,
      },
      accountWorkersOf(deps.client, scripts),
    );
    const takenFrom = (list: readonly AccessApp[]) => {
      const found = takenAddresses(othersOf(list), plan.destinations);
      const notYet = found.find((t) => pending.has(t.uri));
      if (notYet !== undefined) {
        throw new AccessToggleError(PROTECT_MESSAGES.conflict(notYet.app, [notYet.uri]));
      }
      return found;
    };
    let taken = takenFrom(apps);
    const bypassInStep = async () => {
      await syncInstallBypassLocked(deps, installId, {
        subdomain,
        apps,
        ...(opts.change === undefined ? {} : { change: opts.change }),
      });
      // Only a sync from the records settles a failure or a due resync; one ahead of a change does not.
      if (
        opts.change === undefined &&
        (protection.syncFailedAt !== null || protection.resyncDueAt !== null)
      ) {
        await recordAccessSyncFailure(deps.db, installId, null);
      }
    };
    const last = protection.coverage;
    // What the addresses asked for when last written: written, or left to another application.
    if (
      last !== null &&
      sameDestinations(
        [...last.destinations, ...last.taken.map((t) => ({ type: "public", uri: t.uri }))],
        plan.destinations,
      )
    ) {
      // What the limit leaves out can change alone (a domain removed that was
      // left out); the cron watches what is recorded.
      if (!sameHosts(last.overLimit, plan.overLimit)) {
        await recordCoverage(deps, installId, { ...last, overLimit: plan.overLimit });
      }
      await bypassInStep();
      return { outcome: "unchanged", taken: [], warnings: [] };
    }
    let app: AccessApp;
    try {
      app = await policiesCall(() => deps.client.access.getApp(protection.accessAppId));
    } catch (error) {
      if (isNotFound(error)) throw new AccessToggleError(PROTECT_MESSAGES.appMissing);
      throw error;
    }
    const put = async () => {
      const to = withoutTaken(plan.destinations, taken);
      if (sameDestinations(app.destinations ?? [], to)) return;
      const body = {
        ...accessAppSettings(app),
        type: "self_hosted",
        destinations: to,
        policies: policyReferences(app.policies),
      } as CreateAccessAppArgs;
      await policiesCall(() => deps.client.access.updateApp(app.id, body));
    };
    try {
      await put();
    } catch (error) {
      if (!isNamedElsewhere(error)) throw error;
      const listed = await policiesCall(() => deps.client.access.listApps());
      const again = takenFrom(listed);
      if (again.every((t) => taken.some((k) => k.uri === t.uri))) throw error;
      apps = listed;
      taken = again;
      await put();
    }
    await recordCoverage(
      deps,
      installId,
      coverageOf(workers, withoutTaken(plan.destinations, taken), taken, plan.overLimit),
    );
    await bypassInStep();
    return { outcome: "updated", taken, warnings: planWarnings(plan) };
  });
}

/**
 * Takes Appflare's protection off the install: deletes its public paths'
 * application first (so no path is left public on its own), then its
 * Access application (its token policy goes with it), then its token, then
 * "Appflare users" when no other app uses it, and forgets them. Already
 * gone counts as removed.
 */
export function unprotectInstall(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installId: string,
): ReturnType<typeof removeInstallAccess> {
  return withAccessLock(deps.db, () => removeInstallProtectionLocked(deps, installId));
}

/**
 * {@link unprotectInstall} for a caller that holds the Access lock (the
 * uninstall job). The public paths' application is looked for by name only
 * when the entry lists public paths, so an app without any costs no call.
 */
export async function removeInstallProtectionLocked(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installId: string,
): ReturnType<typeof removeInstallAccess> {
  await removePublicPathsLocked(deps, installId);
  return removeInstallAccess(deps, installId);
}

/**
 * Deletes the install's public paths' application (`removeInstallBypassLocked`),
 * looking for an unrecorded one by name only when the entry lists public
 * paths. The uninstall job runs it before any address is released. Caller
 * holds the Access lock.
 */
export async function removePublicPathsLocked(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installId: string,
): Promise<{ removed: boolean }> {
  const orm = createDb(deps.db);
  const [install] = await orm
    .select({ manifestJson: installs.manifest_json, artifactDigest: installs.artifact_digest })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  // The signed copy's paths too: a revision may have dropped paths that
  // were made public before it was recorded.
  const lookUp =
    install !== undefined &&
    (bypassPathsOfManifest(install.manifestJson).length > 0 ||
      (await storedBypassPaths(orm, install)).length > 0);
  return removeInstallBypassLocked(deps, installId, { lookUp });
}

/** At most this many installs are brought in step again per cron run (a few calls each). */
export const ACCESS_RESYNCS_PER_RUN = 3;

export interface AccessResync {
  installId: string;
  /** `busy`: another Access change held the lock, so it waits for the next run as it was. */
  outcome: SyncOutcome | "failed" | "busy";
  detail?: string;
  /** Addresses the sync left to another application that names them itself, when it did. */
  taken?: TakenAddress[];
  /** What the application leaves out besides, when the sync wrote it. */
  warnings?: string[];
}

function isBusy(error: unknown): boolean {
  return error instanceof AccessToggleError && error.message === ACCESS_MESSAGES.busy;
}

/**
 * The cron: brings in step again the Access applications of protected
 * installs whose last sync outside a job failed (a domain added or removed,
 * workers.dev turned on or off) or is due (a catalog revision changed their
 * public paths, Appflare was updated, an address left to another
 * application is free again), at most {@link ACCESS_RESYNCS_PER_RUN}. Due
 * and failed share one queue, oldest mark first (the failure's time for an
 * install marked both ways). A D1 read only when none is due. A failure is
 * recorded with this run's time, so an install that keeps failing goes
 * behind every install marked before it, and a long run of due ones never
 * holds up a failure older than them. Another Access change holding the
 * lock (a job) is no failure: the install keeps its marks for the next
 * run, and so do the ones after it. An install whose application the
 * upkeep found deleted (`access_app_missing_at`) waits, marks kept, until
 * it is protected again. `apps`: the account's applications, when the
 * caller listed them in this run already.
 */
export async function resyncInstallAccessIfFailed(deps: {
  db: D1Database;
  client: () => Promise<CloudflareClient>;
  now?: () => Date;
  apps?: readonly AccessApp[];
}): Promise<AccessResync[]> {
  const due = await createDb(deps.db)
    .select({ installId: install_access.install_id })
    .from(install_access)
    .where(
      and(
        or(
          isNotNull(install_access.access_sync_failed_at),
          isNotNull(install_access.access_resync_due_at),
        ),
        isNotNull(install_access.access_app_id),
        // An application deleted in the dashboard cannot be brought in step:
        // its page offers to protect the app again instead.
        isNull(install_access.access_app_missing_at),
      ),
    )
    .orderBy(
      sql`coalesce(${install_access.access_sync_failed_at}, ${install_access.access_resync_due_at})`,
    )
    .limit(ACCESS_RESYNCS_PER_RUN);
  if (due.length === 0) return [];
  const client = await deps.client();
  const out: AccessResync[] = [];
  for (const { installId } of due) {
    try {
      const { outcome, taken, warnings } = await syncInstallAccessDestinations(
        { db: deps.db, client, ...(deps.now === undefined ? {} : { now: deps.now }) },
        installId,
        deps.apps === undefined ? {} : { apps: deps.apps },
      );
      out.push({
        installId,
        outcome,
        ...(taken.length === 0 ? {} : { taken }),
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    } catch (error) {
      if (isBusy(error)) {
        out.push({ installId, outcome: "busy" });
        break;
      }
      await recordAccessSyncFailure(deps.db, installId, (deps.now ?? (() => new Date()))());
      out.push({
        installId,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/**
 * For the cron, with the account's applications listed (`apps`): forgets
 * each address the install's application left to another application
 * (`taken`) that no other application names any more, and marks the install
 * due for the resync above, which covers it again. Answers the addresses
 * freed; none, and no D1 write, when none is. A listing that left the other
 * application out costs one resync, which leaves the address to it again.
 * Caller holds the Access lock.
 */
export async function releaseFreedAddresses(
  deps: { db: D1Database; now?: () => Date },
  row: {
    installId: string;
    accessAppId: string;
    bypassAppId: string | null;
    coverageJson: string | null;
  },
  apps: readonly AccessApp[],
): Promise<string[]> {
  const coverage = parseCoverage(row.coverageJson);
  if (coverage === null || coverage.taken.length === 0) return [];
  const still = takenAddresses(
    apps.filter(
      (a) => a.id !== row.accessAppId && !isBypassAppOf(a, row.installId, row.bypassAppId),
    ),
    coverage.taken.map((t) => ({ type: "public", uri: t.uri })),
  );
  const freed = coverage.taken.filter((t) => !still.some((s) => s.uri === t.uri)).map((t) => t.uri);
  if (freed.length === 0) return [];
  const at = (deps.now ?? (() => new Date()))();
  const orm = createDb(deps.db);
  await orm
    .update(install_access)
    .set({
      access_destinations_json: JSON.stringify({ ...coverage, taken: still }),
      access_resync_due_at: sql`coalesce(${install_access.access_resync_due_at}, ${at.getTime()})`,
      updated_at: at,
    })
    .where(
      and(
        eq(install_access.install_id, row.installId),
        eq(install_access.access_app_id, row.accessAppId),
      ),
    );
  return freed;
}

/** What the account's Workers are, as the cron reads it for {@link patternsOutOfStep}: each read at most once a run. */
export interface AccountWorkers {
  /** Every Worker's name (the script list). */
  scripts: () => Promise<readonly string[]>;
  /** Every custom domain and zone route of the account's Workers ({@link workerAddressesOf}). */
  addresses: () => Promise<readonly WorkerAddress[]>;
}

/**
 * For the cron, with the account's applications listed (`apps`): whether
 * the install's application names its Workers' version previews, or its
 * wildcard domains' bases and names (`wildcardBases`, as recorded), where
 * the plan would not, or leaves them out where it would name them
 * (`planDestinations`), because another application covering them came or
 * went, or another Worker whose name ends like one of the install's, or
 * with a custom domain or route under a wildcard domain, did. Or whether
 * another application now covers a hostname left out past Cloudflare's
 * limit (`overLimit`), which the plan then names, or leaves to an
 * application that names it itself. The account's Workers are read
 * (`account`) only for a pattern another application covers. False
 * without a record of what the application covers; the previews are not
 * looked at without a workers.dev subdomain.
 */
export async function patternsOutOfStep(
  row: {
    installId: string;
    accessAppId: string;
    bypassAppId: string | null;
    coverageJson: string | null;
  },
  { subdomain, wildcardBases }: { subdomain: string | null; wildcardBases: readonly string[] },
  apps: readonly AccessApp[],
  account: AccountWorkers,
): Promise<boolean> {
  const coverage = parseCoverage(row.coverageJson);
  if (coverage === null) return false;
  const others = apps.filter(
    (a) => a.id !== row.accessAppId && !isBypassAppOf(a, row.installId, row.bypassAppId),
  );
  const broader = broaderAppsOf(others);
  const ownerOf = namedItselfBy(others);
  if (coverage.overLimit.some((h) => broader(h).length > 0 || ownerOf(h) !== undefined)) {
    return true;
  }
  const workers = Object.keys(coverage.workerTags).map((w) => w.toLowerCase());
  const named = new Set([
    ...coverage.destinations.flatMap((d) =>
      d.type === "public" && typeof d.uri === "string" ? [d.uri.toLowerCase()] : [],
    ),
    ...coverage.taken.map((t) => t.uri),
  ]);
  for (const worker of subdomain === null ? [] : workers) {
    const pattern = previewsPattern(worker, subdomain ?? "");
    const present = named.has(pattern);
    if (broader(pattern).length === 0) {
      if (present) return true;
      continue;
    }
    const shared = (await account.scripts()).some((s) => {
      const name = s.toLowerCase();
      return name.endsWith(`-${worker}`) && !workers.includes(name);
    });
    // Wanted exactly when no other Worker shares the pattern.
    if (present === shared) return true;
  }
  const own = new Set(workers);
  for (const base of wildcardBases) {
    for (const uri of wildcardUris(base)) {
      const present = named.has(uri);
      if (broader(uri).length === 0) {
        if (present) return true;
        continue;
      }
      const shared = othersUnder(uri, await account.addresses(), own).length > 0;
      if (present === shared) return true;
    }
  }
  return false;
}

/** Each protected install's wildcard domains (their bases), as recorded. D1 only. */
export async function recordedWildcardBases(d1: D1Database): Promise<Map<string, string[]>> {
  const rows = await createDb(d1)
    .select({ installId: resources.install_id, name: resources.name })
    .from(resources)
    .innerJoin(install_access, eq(install_access.install_id, resources.install_id))
    .where(
      and(
        eq(resources.kind, WILDCARD_DOMAIN_KIND),
        isNull(resources.deleted_at),
        isNotNull(install_access.access_app_id),
      ),
    );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.installId, [...(out.get(r.installId) ?? []), r.name]);
  return out;
}

/**
 * Marks the install due for the cron's resync (`resyncInstallAccessIfFailed`),
 * keeping an earlier mark, while it is protected by `accessAppId`.
 */
export async function markAccessResyncDue(
  d1: D1Database,
  row: { installId: string; accessAppId: string },
  at: Date,
): Promise<void> {
  await createDb(d1)
    .update(install_access)
    .set({
      access_resync_due_at: sql`coalesce(${install_access.access_resync_due_at}, ${at.getTime()})`,
    })
    .where(
      and(
        eq(install_access.install_id, row.installId),
        eq(install_access.access_app_id, row.accessAppId),
      ),
    );
}
