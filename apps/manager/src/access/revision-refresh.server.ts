import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { type AppManifestOptions, refreshInstalledRevision } from "../catalog/app-manifest.server";
import { type MergedEnv, readCachedListing } from "../catalog/merged.server";
import { readCatalogRevision } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import { install_access, installs } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";

/**
 * The cron's check for catalog revisions of protected apps' releases. A
 * revision can change the paths a protected app keeps public (`access.bypass`)
 * without a new version, and one that drops a path must not wait until
 * someone opens the app's page, which is where other revisions are read.
 *
 * Each run takes at most {@link PROTECTED_REVISION_CHECKS_PER_RUN} protected
 * installs, going on from where the last run stopped (a cursor in
 * `settings`), so every protected install is reached in turn. For each, the
 * install's own catalog listing (already cached by the run's index refresh)
 * says whether a newer revision of the installed release exists; only then
 * is it fetched and verified, through the same path and KV cache as the
 * app's page (`refreshInstalledRevision`). Recording a revision that changes
 * public paths marks the release's protected installs for the Access resync
 * (`recordCatalogRevision`), which the cron runs right after this, under the
 * Access lock. A failure is reported per install and never thrown.
 */

/**
 * At most this many protected installs are checked per run. Each costs at
 * most 6 fetches (its release's `manifest.json` and `manifest.sig`, each
 * through GitHub's redirect, and the revised catalog manifest, which may
 * redirect too), so a run stays at 42 of the Free plan's 50.
 */
export const PROTECTED_REVISION_CHECKS_PER_RUN = 7;

export interface ProtectedRevisionCheck {
  installId: string;
  outcome: /** The install's listing has no newer revision than the one recorded. */
    | "current"
    /** A newer revision was read and recorded. */
    | "recorded"
    /** Its catalog no longer lists the app, or is turned off. */
    | "unlisted"
    /** A newer revision is listed but could not be read or did not verify. */
    | "failed";
  detail?: string;
}

/** The next protected installs to check, from the cursor on, wrapping round. */
async function nextProtectedInstalls(d1: D1Database, limit: number) {
  const orm = createDb(d1);
  const cursor = (await readSettings(orm, [SETTING.appAccessRevisionCursor]))
    .app_access_revision_cursor;
  const select = (after: string | null) =>
    orm
      .select({
        id: installs.id,
        catalogId: installs.catalog_id,
        appSlug: installs.app_slug,
        catalogVersion: installs.catalog_version,
        artifactDigest: installs.artifact_digest,
      })
      .from(installs)
      .innerJoin(install_access, eq(install_access.install_id, installs.id))
      .where(
        and(
          isNotNull(install_access.access_app_id),
          isNotNull(installs.artifact_digest),
          eq(installs.origin, "catalog"),
          eq(installs.build_kind, "artifact"),
          inArray(installs.status, ["installed", "failed"]),
          ...(after === null ? [] : [gt(installs.id, after)]),
        ),
      )
      .orderBy(asc(installs.id))
      .limit(limit);
  const first = await select(cursor || null);
  if (first.length >= limit || !cursor) return first;
  // Round again from the start, without taking an install twice.
  const taken = new Set(first.map((r) => r.id));
  const again = (await select(null)).filter((r) => !taken.has(r.id));
  return [...first, ...again].slice(0, limit);
}

export async function refreshProtectedRevisions(
  env: MergedEnv,
  opts: {
    limit?: number;
    /** Over each listing's trust (tests inject keys and fetch). */
    manifestOptions?: AppManifestOptions;
  } = {},
): Promise<ProtectedRevisionCheck[]> {
  const due = await nextProtectedInstalls(env.DB, opts.limit ?? PROTECTED_REVISION_CHECKS_PER_RUN);
  if (due.length === 0) return [];
  const out: ProtectedRevisionCheck[] = [];
  for (const install of due) {
    try {
      const listed = await readCachedListing(env, install.catalogId, install.appSlug);
      if (listed === null) {
        out.push({ installId: install.id, outcome: "unlisted" });
        continue;
      }
      const release = {
        catalog_version: install.catalogVersion,
        artifact_digest: install.artifactDigest,
      };
      const tried = await refreshInstalledRevision(env, release, listed.app, {
        ...listed.trust,
        ...opts.manifestOptions,
      });
      if (!tried) {
        out.push({ installId: install.id, outcome: "current" });
        continue;
      }
      // A refused revision is logged where it is read and leaves the recorded one.
      const held =
        install.artifactDigest === null
          ? null
          : await readCatalogRevision(createDb(env.DB), install.artifactDigest);
      out.push(
        held !== null && held.revision >= listed.app.revision
          ? { installId: install.id, outcome: "recorded" }
          : {
              installId: install.id,
              outcome: "failed",
              detail: `revision ${listed.app.revision} of ${install.appSlug} ${install.catalogVersion} could not be read or did not verify`,
            },
      );
    } catch (error) {
      out.push({
        installId: install.id,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const last = due.at(-1)?.id;
  if (last !== undefined) {
    await writeSettings(createDb(env.DB), { [SETTING.appAccessRevisionCursor]: last });
  }
  return out;
}
