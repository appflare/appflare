import {
  type AccessApp,
  type AccessAppPolicyArgs,
  type AccessPolicyArgs,
  type AccessPublicDestination,
  CloudflareApiError,
  type CloudflareClient,
  type CreateAccessAppArgs,
} from "@appflare/cf-api";
import { accessBypassPaths, catalogAccessSchema } from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs, resources } from "../db/schema";
import { installLabel } from "../installs/display-name";
import { recordedName } from "../installs/install-names.server";
import {
  ACCESS_APP_KIND,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  WILDCARD_DOMAIN_KIND,
} from "../installs/resource-kinds";
import {
  accessAppSettings,
  INSTALL_ACCESS_MESSAGES,
  policyReferences,
  readInstallAccess,
} from "./install-access.server";
import { AccessToggleError } from "./toggle.server";

/**
 * The public paths of a protected install: a catalog entry's `access.bypass`
 * (`/s/*`, `/api/webhook`) stays reachable without a sign-in while the rest
 * of the app is behind Cloudflare Access.
 *
 * One more self-hosted Access application per install, "Appflare: <app>
 * (<worker>) public paths", whose destinations are `public` ones, one per
 * path on every hostname the app answers on in Appflare's records, and whose
 * only policy is an inline `bypass` for everyone. Verified live 2026-09-30: a
 * separate application with a `public` `<host>/open/*` destination and a
 * bypass policy lets signed-out visitors through on exactly that path of
 * that host (`/opener` stays protected) while the install's own application
 * (its `worker` destination) protects the rest. It applies per hostname, and
 * never to version previews, which therefore stay fully protected.
 *
 * Hostnames: the primary Worker's workers.dev hostname while workers.dev is
 * on for it, each custom domain, and for a wildcard domain both its base and
 * `*.<base>` (Access accepted `*.<base>/<path>` destinations, checked live
 * 2026-09-30; that such a destination matches requests on a wildcard route
 * was not checked), and each external domain (a `public` destination covers
 * such a hostname, verified live 2026-10-01). The health check path is never made public:
 * Appflare's checks sign in with the install's own service token.
 *
 * Ordering: a hostname or path comes off before the change that removes it
 * (a domain detached, workers.dev turned off, a version that drops a path
 * about to serve: `BypassChange`), so a released hostname never keeps a
 * public path; a new one is added after its address serves, from the
 * records, so until then it asks for a sign-in like the rest of the app. A
 * sync outside a job that fails is recorded on the install and retried by
 * the cron (`resyncInstallAccessIfFailed`); one in a job is too.
 *
 * Recorded as an `access_app` resource of the install
 * (`<install>:access_app:bypass`, `cf_id` the application's id). An
 * application whose creation was not recorded is found again by its policy's
 * name, which carries the install id. Callers hold the Access lock.
 */

/** Cloudflare's limit of destinations per Access application. */
export const MAX_ACCESS_APP_DESTINATIONS = 50;

export const BYPASS_MESSAGES = {
  tooMany: (count: number) =>
    `This app's public paths on all of its addresses make ${count} Cloudflare Access destinations, more than the ${MAX_ACCESS_APP_DESTINATIONS} one application takes. Remove a domain of the app to keep its public paths public; until then they ask for a sign-in like the rest of the app.`,
} as const;

/** The name of the inline bypass policy; carries the install id, so the application is found again. */
export function bypassPolicyName(installId: string): string {
  return `Appflare public paths ${installId}`;
}

/** The bypass application's name. */
export function bypassAppName(label: string, workerName: string): string {
  return `Appflare: ${label} (${workerName}) public paths`;
}

/** The resource row of the install's bypass application. */
export function bypassAppResourceId(installId: string): string {
  return `${installId}:${ACCESS_APP_KIND}:bypass`;
}

/** The inline policy: everyone, without a sign-in. */
export function bypassPolicy(installId: string): AccessPolicyArgs {
  return {
    name: bypassPolicyName(installId),
    decision: "bypass",
    include: [{ everyone: {} }],
    precedence: 1,
  };
}

/** Whether `app` is the install's bypass application (by its recorded id or its policy). */
export function isBypassAppOf(
  app: AccessApp,
  installId: string,
  recordedId: string | null,
): boolean {
  return (
    (recordedId !== null && app.id === recordedId) ||
    (app.policies ?? []).some((p) => p.name === bypassPolicyName(installId))
  );
}

/**
 * The hostnames the app answers on, as its public paths cover them: the
 * primary Worker's workers.dev hostname while it is on, the custom domains,
 * then each wildcard domain's base and `*.<base>`. Lower case, each once.
 */
export function bypassHosts(input: {
  workerName: string;
  subdomain: string | null;
  workersDev: boolean;
  customDomains: readonly string[];
  wildcardBases: readonly string[];
  /** External domains (Cloudflare for SaaS custom hostnames through the gateway). */
  externalDomains?: readonly string[];
}): string[] {
  const hosts: string[] = [];
  if (input.workersDev && input.subdomain !== null) {
    hosts.push(`${input.workerName}.${input.subdomain}.workers.dev`);
  }
  hosts.push(...[...input.customDomains].sort());
  hosts.push(...[...(input.externalDomains ?? [])].sort());
  for (const base of [...input.wildcardBases].sort()) hosts.push(base, `*.${base}`);
  return [...new Set(hosts.map((h) => h.toLowerCase()))];
}

/** One `public` destination per path on every hostname: `<host><path>`. */
export function bypassDestinations(
  hosts: readonly string[],
  paths: readonly string[],
): AccessPublicDestination[] {
  return hosts.flatMap((host) =>
    paths.map((path) => ({ type: "public" as const, uri: `${host}${path}` })),
  );
}

/** The public paths a stored artifact manifest declares; none when it declares none or is unreadable. */
export function bypassPathsOfManifest(manifestJson: string | null): readonly string[] {
  if (manifestJson === null) return [];
  try {
    const catalog = (JSON.parse(manifestJson) as { catalog?: { access?: unknown } }).catalog;
    const parsed = catalogAccessSchema.safeParse(catalog?.access);
    return parsed.success ? accessBypassPaths({ access: parsed.data }) : [];
  } catch {
    return [];
  }
}

function sameUris(a: ReadonlyArray<{ type: string }>, b: readonly AccessPublicDestination[]) {
  const key = (d: { type: string }) => {
    const uri = (d as { uri?: unknown }).uri;
    return `${d.type}:${typeof uri === "string" ? uri.toLowerCase() : JSON.stringify(d)}`;
  };
  const ka = [...new Set(a.map(key))].sort();
  const kb = [...new Set(b.map(key))].sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

async function policiesCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 403 || error.status === 401)) {
      throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.policiesPermission);
    }
    throw error;
  }
}

interface BypassDeps {
  db: D1Database;
  client: CloudflareClient;
  now?: () => Date;
}

/** The recorded bypass application's id, or null. */
export async function recordedBypassAppId(
  d1: D1Database,
  installId: string,
): Promise<string | null> {
  const [row] = await createDb(d1)
    .select({ cfId: resources.cf_id })
    .from(resources)
    .where(and(eq(resources.id, bypassAppResourceId(installId)), isNull(resources.deleted_at)))
    .limit(1);
  return row?.cfId ?? null;
}

async function recordBypass(
  deps: Pick<BypassDeps, "db" | "now">,
  installId: string,
  app: { id: string; name: string } | null,
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const orm = createDb(deps.db);
  if (app === null) {
    await orm
      .update(resources)
      .set({ deleted_at: at })
      .where(and(eq(resources.id, bypassAppResourceId(installId)), isNull(resources.deleted_at)));
    return;
  }
  await orm
    .insert(resources)
    .values({
      id: bypassAppResourceId(installId),
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
    });
}

/** What the install's public paths should be, from its records. */
async function wantedBypass(
  d1: D1Database,
  installId: string,
  subdomain: string | null,
  change: BypassChange,
): Promise<{ name: string; destinations: AccessPublicDestination[] } | null> {
  const orm = createDb(d1);
  const [install] = await orm
    .select({
      status: installs.status,
      buildKind: installs.build_kind,
      workerName: installs.worker_name,
      displayName: installs.display_name,
      appSlug: installs.app_slug,
      manifestJson: installs.manifest_json,
      workersDev: installs.workers_dev_enabled,
    })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (
    install === undefined ||
    install.buildKind === "self-deploying" ||
    install.status === "uninstalling" ||
    install.status === "uninstalled"
  ) {
    return null;
  }
  // Only an install Appflare protects has public paths: without protection everything is public.
  if ((await readInstallAccess(d1, installId))?.accessAppId == null) return null;
  const paths = change.paths ?? bypassPathsOfManifest(install.manifestJson);
  if (paths.length === 0) return null;
  const rows = await orm
    .select({ kind: resources.kind, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, [CUSTOM_DOMAIN_KIND, CUSTOM_HOSTNAME_KIND, WILDCARD_DOMAIN_KIND]),
        isNull(resources.deleted_at),
        isNull(resources.retained_at),
      ),
    );
  const leaving = new Set((change.leavingHosts ?? []).map((h) => h.toLowerCase()));
  const hosts = bypassHosts({
    workerName: install.workerName,
    subdomain,
    workersDev: change.workersDev ?? install.workersDev,
    customDomains: rows.filter((r) => r.kind === CUSTOM_DOMAIN_KIND).map((r) => r.name),
    wildcardBases: rows.filter((r) => r.kind === WILDCARD_DOMAIN_KIND).map((r) => r.name),
    externalDomains: rows.filter((r) => r.kind === CUSTOM_HOSTNAME_KIND).map((r) => r.name),
  }).filter((host) => !leaving.has(host));
  const destinations = bypassDestinations(hosts, paths);
  if (destinations.length === 0) return null;
  const name = bypassAppName(
    installLabel({
      displayName: install.displayName,
      name: recordedName({ app_slug: install.appSlug, manifest_json: install.manifestJson }),
    }),
    install.workerName,
  );
  return { name, destinations };
}

/**
 * A change about to happen, so the public paths can follow it before it
 * does: hostnames about to stop serving the app (a domain being removed,
 * `*.<base>` included for a wildcard domain), workers.dev about to be turned
 * off (`workersDev: false`), or the paths of a version about to serve
 * (`paths`, those the serving and the coming version share). Removals come
 * first so a released hostname never keeps a public path; additions follow
 * the change, from the records.
 */
export interface BypassChange {
  leavingHosts?: readonly string[];
  workersDev?: boolean;
  paths?: readonly string[];
}

export type BypassOutcome = "none" | "created" | "adopted" | "updated" | "unchanged" | "removed";

export interface BypassResult {
  outcome: BypassOutcome;
  /** What the bypass application covers now; empty without one. */
  destinations: AccessPublicDestination[];
}

/**
 * Brings the install's bypass application in step with its public paths
 * and addresses: made when a protected install has public paths and an
 * address, rewritten when they changed, deleted when there are none (the
 * install is no longer protected, the new version declares none, or the app
 * has no address left). `subdomain` is the account's workers.dev subdomain.
 * `apps`, when the caller listed the account's applications already, saves
 * a list to find one whose creation was not recorded. Caller holds the
 * Access lock. Throws `AccessToggleError` on a refusal (too many
 * destinations, the token's permissions).
 */
export async function syncInstallBypassLocked(
  deps: BypassDeps,
  installId: string,
  opts: { subdomain: string | null; apps?: readonly AccessApp[]; change?: BypassChange },
): Promise<BypassResult> {
  const { access } = deps.client;
  const wanted = await wantedBypass(deps.db, installId, opts.subdomain, opts.change ?? {});
  const recordedId = await recordedBypassAppId(deps.db, installId);
  if (wanted === null) {
    if (recordedId === null) return { outcome: "none", destinations: [] };
    await removeRecordedBypass(deps, installId, recordedId);
    return { outcome: "removed", destinations: [] };
  }
  if (wanted.destinations.length > MAX_ACCESS_APP_DESTINATIONS) {
    throw new AccessToggleError(BYPASS_MESSAGES.tooMany(wanted.destinations.length));
  }

  let current: AccessApp | null = null;
  if (recordedId !== null) {
    try {
      current = await policiesCall(() => access.getApp(recordedId));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  let adopted = false;
  if (current === null) {
    const apps = opts.apps ?? (await policiesCall(() => access.listApps()));
    current = apps.find((a) => isBypassAppOf(a, installId, null)) ?? null;
    adopted = current !== null;
  }

  if (current === null) {
    const created = await policiesCall(() =>
      access.createApp({
        type: "self_hosted",
        name: wanted.name,
        destinations: wanted.destinations,
        app_launcher_visible: false,
        policies: [bypassPolicy(installId)],
      }),
    );
    await recordBypass(deps, installId, { id: created.id, name: wanted.name });
    return { outcome: "created", destinations: wanted.destinations };
  }

  const hasPolicy = (current.policies ?? []).some((p) => p.name === bypassPolicyName(installId));
  if (
    !adopted &&
    hasPolicy &&
    current.name === wanted.name &&
    sameUris(current.destinations ?? [], wanted.destinations)
  ) {
    return { outcome: "unchanged", destinations: wanted.destinations };
  }
  const policies: AccessAppPolicyArgs[] = policyReferences(current.policies);
  if (!hasPolicy) policies.push(bypassPolicy(installId));
  const body = {
    ...accessAppSettings(current),
    type: "self_hosted",
    name: wanted.name,
    destinations: wanted.destinations,
    policies,
  } as CreateAccessAppArgs;
  const id = current.id;
  try {
    await policiesCall(() => access.updateApp(id, body));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // Deleted between the read and the write: made anew.
    const created = await policiesCall(() =>
      access.createApp({
        type: "self_hosted",
        name: wanted.name,
        destinations: wanted.destinations,
        app_launcher_visible: false,
        policies: [bypassPolicy(installId)],
      }),
    );
    await recordBypass(deps, installId, { id: created.id, name: wanted.name });
    return { outcome: "created", destinations: wanted.destinations };
  }
  await recordBypass(deps, installId, { id, name: wanted.name });
  return { outcome: adopted ? "adopted" : "updated", destinations: wanted.destinations };
}

async function removeRecordedBypass(
  deps: BypassDeps,
  installId: string,
  appId: string,
): Promise<void> {
  try {
    await policiesCall(() => deps.client.access.deleteApp(appId));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await recordBypass(deps, installId, null);
}

/**
 * Deletes the install's bypass application, recorded or found by its
 * policy's name (already gone counts as deleted), and forgets it. For
 * turning protection off and for uninstalling: it goes before the install's
 * own application, so no path is left public on its own. `apps` saves a list
 * when the caller has one. Caller holds the Access lock.
 */
export async function removeInstallBypassLocked(
  deps: BypassDeps,
  installId: string,
  opts: { apps?: readonly AccessApp[]; lookUp?: boolean } = {},
): Promise<{ removed: boolean }> {
  const recordedId = await recordedBypassAppId(deps.db, installId);
  let id = recordedId;
  if (id === null && opts.lookUp !== false) {
    const apps = opts.apps ?? (await policiesCall(() => deps.client.access.listApps()));
    id = apps.find((a) => isBypassAppOf(a, installId, null))?.id ?? null;
  }
  if (id === null) return { removed: false };
  await removeRecordedBypass(deps, installId, id);
  return { removed: true };
}
