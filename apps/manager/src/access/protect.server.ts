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
} from "@appflare/cf-api";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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
import {
  type BypassChange,
  type BypassOutcome,
  bypassPathsOfManifest,
  isBypassAppOf,
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
  policyReferences,
  probesPolicy,
  probesPolicyName,
  readInstallAccess,
  removeInstallAccess,
} from "./install-access.server";
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
 *   was deleted), so custom domains and wildcard domains need no
 *   destination of their own and nothing to keep in step;
 * - before a Worker exists (an install protected from its first upload on),
 *   a `public` destination for its future `<worker>.<subdomain>.workers.dev`
 *   hostname instead, which Access accepts and enforces from the first
 *   request; the install job switches to `worker` destinations after its
 *   uploads, and the application keeps its audience tag across the switch;
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
 * here, and goes before it when protection comes off.
 *
 * The lock is a lease of 60 seconds (toggle.server.ts). `protectInstall`
 * makes about 8 to 12 Cloudflare calls under it, each well under a second,
 * so it finishes long before another change could take the lease over.
 */

/** A Worker of the install, as the protection covers it. */
export interface ProtectWorker {
  name: string;
  /**
   * Its script tag (`ScriptUploadResult.tag`). `null`: not uploaded yet, so
   * its future workers.dev hostname is covered instead. Left out: read from
   * the account's script list, where the Worker must be.
   */
  tag?: string | null;
}

/** What an install's application covers, as last written. */
export interface AccessCoverageRecord {
  destinations: AccessDestination[];
  /** Script tag by Worker name, for each Worker a `worker` destination covers. */
  workerTags: Record<string, string>;
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
    `The Cloudflare Access application "${other}" already covers ${covered.length === 1 ? covered[0] : `${covered.slice(0, -1).join(", ")} and ${covered.at(-1)}`}, an address of this app. Delete it under Zero Trust, Access, Applications, or keep using it and leave Appflare's protection off for this app.`,
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

/**
 * The destinations that cover the install: its Workers (by tag, or by their
 * future workers.dev hostname before they exist), then its external domains,
 * each once.
 */
export function installDestinations(input: {
  workers: ReadonlyArray<{ name: string; tag: string | null }>;
  subdomain: string | null;
  externalHosts: readonly string[];
}): AccessDestination[] {
  const out: AccessDestination[] = [];
  const seen = new Set<string>();
  const add = (d: AccessDestination) => {
    const key = destinationKey(d);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  for (const w of input.workers) {
    if (w.tag !== null) {
      add({ type: "worker", worker_id: w.tag });
      continue;
    }
    if (input.subdomain === null) throw new AccessToggleError(PROTECT_MESSAGES.noSubdomain);
    add({ type: "public", uri: workersDevHost(w.name, input.subdomain) });
  }
  for (const host of [...input.externalHosts].map((h) => h.toLowerCase()).sort()) {
    add({ type: "public", uri: host });
  }
  return out;
}

function destinationKey(d: { type: string }): string {
  const fields = d as Record<string, unknown>;
  if (d.type === "worker") return `worker:${String(fields.worker_id)}`;
  if (d.type === "public") return `public:${String(fields.uri).toLowerCase()}`;
  return `${d.type}:${JSON.stringify(d)}`;
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

/** What the install's protection must not share with another application. */
interface InstallFootprint {
  /** Exact hostnames and patterns of the install's addresses. */
  hostnames: string[];
  /** Script tags of its Workers. */
  tags: string[];
}

/**
 * The addresses of the install that `coverage` (another application's)
 * already covers: a shared script tag, or a hostname either side's pattern
 * matches. A false conflict is cheaper than two applications on one address.
 */
export function overlap(coverage: AccessAppCoverage, ours: InstallFootprint): string[] {
  const found = new Set<string>();
  for (const tag of coverage.workerIds) {
    if (ours.tags.includes(tag)) found.add("one of its Workers");
  }
  for (const theirs of coverage.hostnames) {
    const theirMatch = hostMatcher(theirs);
    for (const mine of ours.hostnames) {
      if (theirMatch(mine) || hostMatcher(mine)(theirs.toLowerCase())) found.add(mine);
    }
  }
  return [...found];
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
    usersPolicyId: row.users_policy_id ?? null,
    appMissingAt: row.access_app_missing_at ?? null,
  };
}

/**
 * Records that bringing the install's Access applications in step failed
 * (`at`), or that it succeeded (null). The cron tries again while it is set
 * (`resyncInstallAccessIfFailed`).
 */
export async function recordAccessSyncFailure(
  d1: D1Database,
  installId: string,
  at: Date | null,
): Promise<void> {
  await createDb(d1)
    .update(install_access)
    .set({ access_sync_failed_at: at })
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

// ---------------------------------------------------------------- Cloudflare

function isForbidden(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 403 || error.status === 401);
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
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

/** Fills in the tags left out (`tag` undefined) from one script list; a Worker not listed is refused. */
async function withTags(
  client: CloudflareClient,
  workers: readonly ProtectWorker[],
  known: Readonly<Record<string, string>> = {},
): Promise<Array<{ name: string; tag: string | null }>> {
  const resolved = workers.map((w) => ({
    name: w.name,
    tag: w.tag === undefined ? (known[w.name] ?? undefined) : w.tag,
  }));
  if (resolved.every((w) => w.tag !== undefined)) {
    return resolved as Array<{ name: string; tag: string | null }>;
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
  return out;
}

function coverageOf(
  workers: ReadonlyArray<{ name: string; tag: string | null }>,
  destinations: AccessDestination[],
): AccessCoverageRecord {
  const workerTags: Record<string, string> = {};
  for (const w of workers) if (w.tag !== null) workerTags[w.name] = w.tag;
  return { destinations, workerTags };
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
}

export interface ProtectResult {
  outcome: ProtectOutcome;
  accessAppId: string;
  appName: string;
  aud: string;
  teamDomain: string;
  destinations: AccessDestination[];
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
 * no other application covers any of the install's addresses), then makes
 * sure "Appflare users" and the install's token exist, then creates or
 * rewrites the application, then records it. Throws `AccessToggleError`
 * with a message for people on a refusal.
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
  const wanted: ProtectWorker[] = [
    ...(request.workers ?? recorded.workers.map((w) => ({ name: w }))),
  ];
  if (wanted.length === 0) throw new AccessToggleError(PROTECT_MESSAGES.noWorkers);
  const record = await readInstallAccess(deps.db, installId);
  const known = (await readInstallProtection(deps.db, installId))?.coverage?.workerTags ?? {};
  const workers = await withTags(client, wanted, known);
  const subdomain = await accountSubdomain(deps);
  const teamDomain = await teamDomainOf(client);
  const apps = await policiesCall(() => client.access.listApps());
  const externalHosts = [
    ...new Set([...recorded.externalDomains, ...(request.pendingExternalHosts ?? [])]),
  ].map((h) => h.toLowerCase());
  const footprint: InstallFootprint = {
    hostnames: [
      ...(subdomain === null
        ? []
        : workers.flatMap((w) => [
            workersDevHost(w.name, subdomain),
            // Version previews: `<first 8 hex of the version>-<worker>`.
            `*-${workersDevHost(w.name, subdomain)}`,
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
  for (const other of apps) {
    // The install's own public paths cover its own addresses, by design.
    if (other === ours || isBypassAppOf(other, installId, bypassId)) continue;
    const covered = overlap(accessAppCoverage(other), footprint);
    if (covered.length > 0) {
      throw new AccessToggleError(PROTECT_MESSAGES.conflict(other.name ?? other.id, covered));
    }
  }
  const destinations = installDestinations({ workers, subdomain, externalHosts });

  // Then what the application references, then the application.
  const users = await ensureAppAccessUsersPolicy(deps);
  const token = await ensureInstallServiceToken(deps, installId);
  // Read again: a token made anew points the recorded application's policy at itself.
  const probesPolicyId = (await readInstallAccess(deps.db, installId))?.probesPolicyId ?? null;

  let outcome: ProtectOutcome;
  let written: AccessApp;
  if (ours === undefined) {
    written = await policiesCall(() =>
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
      sameDestinations(ours.destinations ?? [], destinations);
    if (upToDate) {
      written = ours;
      outcome = "unchanged";
    } else {
      const body = {
        ...accessAppSettings(ours),
        type: "self_hosted",
        name: appName,
        destinations,
        policies,
      } as CreateAccessAppArgs;
      try {
        written = await policiesCall(() => client.access.updateApp(ours.id, body));
      } catch (error) {
        if (isNotFound(error)) throw new AccessToggleError(PROTECT_MESSAGES.appMissing);
        throw error;
      }
      outcome = adopted ? "adopted" : "updated";
    }
  }
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
      coverage: coverageOf(workers, destinations),
      usersPolicyId: users.policyId,
    },
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
    bypass,
    bypassProblem,
  };
}

export type SyncOutcome =
  /** Appflare does not protect the install: nothing to keep in step (no Cloudflare call). */
  "not-protected" | "unchanged" | "updated";

/**
 * Brings the install's application in step with its addresses after they
 * changed: its Workers, by their recorded tags (a Worker without one is
 * looked up; one the account does not list is refused), and its external
 * domains, with `pendingExternalHosts` covered before they serve. Writes
 * only when the destinations differ from those last written: a read of the
 * application, then a `PUT` of it as it is with the new destinations (so
 * settings an admin changed in the Zero Trust dashboard stay). Custom
 * domains and wildcard domains need nothing there: the Worker's own
 * destination covers them.
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
  opts: { pendingExternalHosts?: readonly string[]; change?: BypassChange } = {},
): Promise<SyncOutcome> {
  if ((await readInstallProtection(deps.db, installId)) === null) return "not-protected";
  return withAccessLock(deps.db, async (): Promise<SyncOutcome> => {
    const protection = await readInstallProtection(deps.db, installId);
    if (protection === null) return "not-protected";
    const recorded = await recordedAddresses(deps.db, installId);
    // A Worker whose tag cannot be found is refused, never left uncovered.
    const workers = await withTags(
      deps.client,
      recorded.workers.map((name) => ({ name })),
      protection.coverage?.workerTags ?? {},
    );
    const destinations = installDestinations({
      workers,
      subdomain: null,
      externalHosts: [
        ...new Set([...recorded.externalDomains, ...(opts.pendingExternalHosts ?? [])]),
      ],
    });
    const coverage = coverageOf(workers, destinations);
    const bypassInStep = async () => {
      await syncInstallBypassLocked(deps, installId, {
        subdomain: await accountSubdomain(deps),
        ...(opts.change === undefined ? {} : { change: opts.change }),
      });
      // Only a sync from the records settles a failure; one ahead of a change does not.
      if (opts.change === undefined && protection.syncFailedAt !== null) {
        await recordAccessSyncFailure(deps.db, installId, null);
      }
    };
    if (
      protection.coverage !== null &&
      sameDestinations(protection.coverage.destinations, destinations)
    ) {
      await bypassInStep();
      return "unchanged";
    }
    let app: AccessApp;
    try {
      app = await policiesCall(() => deps.client.access.getApp(protection.accessAppId));
    } catch (error) {
      if (isNotFound(error)) throw new AccessToggleError(PROTECT_MESSAGES.appMissing);
      throw error;
    }
    if (!sameDestinations(app.destinations ?? [], destinations)) {
      const body = {
        ...accessAppSettings(app),
        type: "self_hosted",
        destinations,
        policies: policyReferences(app.policies),
      } as CreateAccessAppArgs;
      await policiesCall(() => deps.client.access.updateApp(app.id, body));
    }
    await recordCoverage(deps, installId, coverage);
    await bypassInStep();
    return "updated";
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
  const [install] = await createDb(deps.db)
    .select({ manifestJson: installs.manifest_json })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  return removeInstallBypassLocked(deps, installId, {
    lookUp: bypassPathsOfManifest(install?.manifestJson ?? null).length > 0,
  });
}

/** At most this many installs are brought in step again per cron run (a few calls each). */
export const ACCESS_RESYNCS_PER_RUN = 5;

export interface AccessResync {
  installId: string;
  outcome: SyncOutcome | "failed";
  detail?: string;
}

/**
 * The cron: brings in step again the Access applications of protected
 * installs whose last sync outside a job failed (a domain added or removed,
 * workers.dev turned on or off), oldest failure first, at most
 * {@link ACCESS_RESYNCS_PER_RUN}. A D1 read only when none failed. A
 * failure stays recorded for the next run.
 */
export async function resyncInstallAccessIfFailed(deps: {
  db: D1Database;
  client: () => Promise<CloudflareClient>;
  now?: () => Date;
}): Promise<AccessResync[]> {
  const due = await createDb(deps.db)
    .select({ installId: install_access.install_id })
    .from(install_access)
    .where(
      and(isNotNull(install_access.access_sync_failed_at), isNotNull(install_access.access_app_id)),
    )
    .orderBy(install_access.access_sync_failed_at)
    .limit(ACCESS_RESYNCS_PER_RUN);
  if (due.length === 0) return [];
  const client = await deps.client();
  const out: AccessResync[] = [];
  for (const { installId } of due) {
    try {
      const outcome = await syncInstallAccessDestinations(
        { db: deps.db, client, ...(deps.now === undefined ? {} : { now: deps.now }) },
        installId,
      );
      out.push({ installId, outcome });
    } catch (error) {
      out.push({
        installId,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
