import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { installAppKey, OFFICIAL_CATALOG_ID } from "../catalog/sources";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { installLabel } from "./display-name";
import type { InstallAgainRecord } from "./install-again";
import { installDomainInput } from "./install-input";
import { namedInstall } from "./install-names.server";
import { isDataResourceKind } from "./resource-kinds";

/**
 * What "Install again" reads of a failed install (see ./install-again.ts):
 * the choices its install job recorded, for the form, and what it left in
 * the account, which starting the new install removes first. Server only.
 */

/** A failed install a new one replaces, as starting the new install needs it. */
export interface ReplacedInstall {
  id: string;
  workerName: string;
  buildKind: string;
  version: string;
  /**
   * Anything of it still in the account that needs removing: `leftovers` is
   * not empty. Secrets alone do not count: they exist only on its Worker,
   * so with the Worker gone they are gone too.
   */
  hasLeftovers: boolean;
  /** Its data resources still in the account: the removal deletes every one, keeping nothing. */
  dataResourceIds: string[];
  /** Worker names it recorded that are still in the account. */
  workerNames: string[];
  leftovers: Array<{ kind: string; name: string }>;
}

/** Why a failed install cannot be installed again, in words for the admin. */
export const INSTALL_AGAIN_REFUSALS = {
  missing: "There is no such install to install again.",
  notFailed:
    "Only an install that did not finish can be installed again. This one finished, or it was removed or installed again already.",
  notCatalog:
    "Install again works for apps from a catalog. This one was built from a repository or from source: uninstall it, then build it again.",
  busy: "A job of this install is running. Wait for it to finish, then install it again.",
  otherApp: "Install again installs the same app again; this form is for another one.",
} as const;

type Refusal = { ok: false; refusal: string };

/**
 * The failed install `installId`, when it can be installed again; `app`
 * (the app the new install is of) must be its own.
 */
export async function readReplacedInstall(
  d1: D1Database,
  installId: string,
  app?: { slug: string; catalogId: string },
): Promise<{ ok: true; install: ReplacedInstall } | Refusal> {
  const db = createDb(d1);
  const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (row === undefined) return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.missing };
  if (row.status !== "failed") return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.notFailed };
  if (row.origin !== "catalog") return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.notCatalog };
  if (
    app !== undefined &&
    (row.app_slug !== app.slug || (row.catalog_id ?? OFFICIAL_CATALOG_ID) !== app.catalogId)
  ) {
    return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.otherApp };
  }
  const [active, live] = await Promise.all([
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.install_id, installId), inArray(jobs.status, ["queued", "running"])))
      .limit(1),
    db
      .select({ id: resources.id, kind: resources.kind, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, installId),
          isNull(resources.deleted_at),
          isNull(resources.retained_at),
        ),
      ),
  ]);
  if (active.length > 0) return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.busy };
  // Secrets go with the Worker: what the admin sees, and what needs a removal.
  const leftovers = live
    .filter((r) => r.kind !== "secret")
    .map((r) => ({ kind: r.kind, name: r.name }));
  return {
    ok: true,
    install: {
      id: row.id,
      workerName: row.worker_name,
      buildKind: row.build_kind,
      version: row.catalog_version,
      hasLeftovers: leftovers.length > 0,
      dataResourceIds: live.filter((r) => isDataResourceKind(r.kind)).map((r) => r.id),
      workerNames: live.filter((r) => r.kind === "worker").map((r) => r.name),
      leftovers,
    },
  };
}

/** What an install job recorded in `jobs.input_json` that the form takes again. */
const recordedChoices = z
  .object({
    vars: z.record(z.string(), z.string()).catch({}),
    access: z.boolean().catch(false),
    domain: installDomainInput.nullable().catch(null),
    emailRouting: z
      .object({ zoneId: z.string() })
      .nullable()
      .catch(null)
      .transform((e) => e?.zoneId ?? null),
  })
  .partial();

function choicesOf(inputJson: string | null): z.infer<typeof recordedChoices> {
  if (inputJson === null) return {};
  try {
    const parsed = recordedChoices.safeParse(JSON.parse(inputJson));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function varsOf(configJson: string | null): Record<string, string> | null {
  if (configJson === null) return null;
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(configJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The "Install again" record of `installId`; null when there is no such
 * install. A record with a `refusal` says why it cannot be installed again
 * now; the page shows it in place of the form.
 */
export async function readInstallAgain(
  d1: D1Database,
  installId: string,
): Promise<InstallAgainRecord | null> {
  const db = createDb(d1);
  const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (row === undefined) return null;
  const [replaced, [job]] = await Promise.all([
    readReplacedInstall(d1, installId),
    db
      .select({ id: jobs.id, input: jobs.input_json })
      .from(jobs)
      .where(and(eq(jobs.install_id, installId), eq(jobs.kind, "install")))
      .orderBy(desc(jobs.id))
      .limit(1),
  ]);
  const choices = choicesOf(job?.input ?? null);
  const install = replaced.ok ? replaced.install : null;
  return {
    installId: row.id,
    appKey: installAppKey(row),
    label: installLabel(namedInstall(row)),
    version: row.catalog_version,
    workerName: row.worker_name,
    displayName: row.display_name,
    // As stored on the install; the job's copy for an install that never got that far.
    vars: varsOf(row.config_json) ?? choices.vars ?? {},
    access: choices.access ?? false,
    domain: choices.domain ?? null,
    emailZoneId: choices.emailRouting ?? null,
    autoUpdate: row.auto_update,
    leftovers: install?.leftovers ?? [],
    failedJobId: job?.id ?? null,
    refusal: replaced.ok ? null : replaced.refusal,
  };
}
