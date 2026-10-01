import { CloudflareApiError, type CloudflareClient } from "@appflare/cf-api";
import { accessOfferOf } from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { varsNeedRefresh } from "../installs/install-vars";
import { entryWorkers, parseStoredManifest } from "../jobs/entry-workers";
import { parseStoredVars } from "../jobs/reconfigure/plan";
import { type AppAccessCheck, accessRepairOf, type InstallAccessView } from "./app-access";
import { bypassPathsOfManifest } from "./bypass.server";
import { accessAppResourceId, listUserEmails } from "./install-access.server";
import { accessCapabilityCheck } from "./preflight.server";
import { readInstallProtection } from "./protect.server";
import { loginMethodName } from "./toggle.server";

/**
 * What the install form and the app page show about protecting an app with
 * Cloudflare Access, read on the server: the live check with who gets in
 * and how they sign in (`checkAppAccessCore`, Cloudflare reads), and an
 * installed app's protection as recorded (`readInstallAccessView`, D1 only).
 */

/**
 * Whether the account can protect apps now, how many Appflare users get in,
 * and the organization's login methods. Reads only. Login methods are
 * informative: a token that cannot list them (the organization's
 * permission) is refused by the check itself.
 */
export async function checkAppAccessCore(deps: {
  db: D1Database;
  client: Pick<CloudflareClient, "access">;
}): Promise<AppAccessCheck> {
  const [problem, providers, emails] = await Promise.all([
    accessCapabilityCheck(deps.client),
    deps.client.access.listIdentityProviders().catch((error: unknown) => {
      if (error instanceof CloudflareApiError) return null;
      throw error;
    }),
    listUserEmails(deps.db),
  ]);
  return {
    problem,
    users: emails.length,
    loginMethods: providers?.map(loginMethodName) ?? null,
    oneTimePin: providers?.some((p) => p.type === "onetimepin") ?? false,
  };
}

/**
 * An installed app's protection, for its page; null for an app Appflare
 * cannot protect (deployed by its own installer) and one that is gone.
 */
export async function readInstallAccessView(
  d1: D1Database,
  installId: string,
): Promise<InstallAccessView | null> {
  const orm = createDb(d1);
  const [[install], protection, [app], emails, settings] = await Promise.all([
    orm
      .select({
        status: installs.status,
        buildKind: installs.build_kind,
        manifestJson: installs.manifest_json,
        configJson: installs.config_json,
        workerName: installs.worker_name,
      })
      .from(installs)
      .where(eq(installs.id, installId))
      .limit(1),
    readInstallProtection(d1, installId),
    orm
      .select({ name: resources.name })
      .from(resources)
      .where(and(eq(resources.id, accessAppResourceId(installId)), isNull(resources.deleted_at)))
      .limit(1),
    listUserEmails(d1),
    readSettings(orm, [SETTING.appAccessUsersPolicyId]),
  ]);
  if (install === undefined || install.status === "uninstalled") return null;
  if (install.buildKind === "self-deploying") return null;
  const signed = parseStoredManifest(install.manifestJson);
  const stored = parseStoredVars(install.configJson);
  return {
    offer: signed === null ? "offered" : accessOfferOf(signed.catalog),
    protected: protection !== null,
    appName: protection === null ? null : (app?.name ?? null),
    teamDomain: protection?.teamDomain ?? null,
    publicPaths: [...bypassPathsOfManifest(install.manifestJson)],
    syncFailedAt: protection?.syncFailedAt?.toISOString() ?? null,
    usesAccessValues:
      signed !== null &&
      entryWorkers(signed, install.workerName).some((w) =>
        varsNeedRefresh(w.manifest, stored, ["access"]),
      ),
    users: emails.length,
    repair: accessRepairOf({
      protected: protection !== null,
      appMissing: protection?.appMissingAt != null,
      syncFailed: protection?.syncFailedAt != null,
      probesPolicyId: protection?.probesPolicyId ?? null,
      aud: protection?.aud ?? null,
      teamDomain: protection?.teamDomain ?? null,
      usersPolicyId: protection?.usersPolicyId ?? null,
      currentUsersPolicyId: settings.app_access_users_policy_id || null,
    }),
  };
}
