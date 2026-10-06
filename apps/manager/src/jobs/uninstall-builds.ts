import { buildCleanupRequestSchema, installBuildsPrefix, sandboxObjectUrl } from "@appflare/schema";
import { sandboxBinding } from "../sandbox/binding";
import type { JobEnv } from "./run-job";
import type { JobSteps } from "./steps";

/**
 * What an uninstall deletes from the sandbox Worker's bucket. An install's
 * builds live under `builds/<install id>/<version>/`: its own, and, for an
 * install made by "Install again" from a repository or from source, the
 * build of the failed install it replaced, which stays under that install's
 * prefix (installs/install-again.ts). Both go, except versions an install
 * that is not uninstalled still reads, as its artifact or a snapshot's: the
 * new install that reuses the build of the failed one being removed for it.
 * Another install's prefix is cleaned only once that install is uninstalled
 * (or never existed, for a build nobody installed): until then its builds
 * are its own. A failed install that left nothing else is retired to
 * `uninstalled` without an uninstall job, when a new install takes its
 * Worker name or installs it again: its builds go the same way
 * ({@link cleanupRetiredBuilds}).
 */

/** One `SandboxBuilds.cleanup()` call: an install's builds, but `keepVersions`. */
export interface BuildCleanupTarget {
  installId: string;
  keepVersions: string[];
}

/** Every build object URL starts with this. */
const BUILDS_URL = sandboxObjectUrl("builds/");

/** The version a build object URL under `prefixUrl` belongs to, or null. */
function versionUnder(url: string, prefixUrl: string): string | null {
  if (!url.startsWith(prefixUrl)) return null;
  const version = url.slice(prefixUrl.length).split("/")[0] ?? "";
  return version.length > 0 ? version : null;
}

/**
 * The `cleanup()` calls the uninstall of `installId` makes: its own prefix
 * first. Two D1 reads: the other installs' prefixes its jobs installed or
 * updated from, and the build artifacts other installs still use.
 */
export async function buildCleanupTargets(
  db: D1Database,
  installId: string,
): Promise<BuildCleanupTarget[]> {
  const [others, inUse] = await db.batch<{ id?: string; url?: string }>([
    // The builds its install and update jobs used, by the `buildId` they recorded.
    db
      .prepare(
        `SELECT DISTINCT b.install_id AS id FROM source_builds b
         LEFT JOIN installs o ON o.id = b.install_id
         WHERE b.install_id != ?1
           AND (o.id IS NULL OR o.status = 'uninstalled')
           AND b.id IN (
             SELECT json_extract(j.input_json, '$.buildId') FROM jobs j
             WHERE j.install_id = ?1 AND json_valid(j.input_json)
           )
         ORDER BY b.install_id`,
      )
      .bind(installId),
    db
      .prepare(
        `SELECT i.artifact_url AS url FROM installs i
         WHERE i.id != ?1 AND i.status != 'uninstalled'
           AND substr(i.artifact_url, 1, length(?2)) = ?2
         UNION
         SELECT s.artifact_url AS url FROM snapshots s JOIN installs i ON i.id = s.install_id
         WHERE i.id != ?1 AND i.status != 'uninstalled' AND s.artifact_url IS NOT NULL
           AND substr(s.artifact_url, 1, length(?2)) = ?2`,
      )
      .bind(installId, BUILDS_URL),
  ]);
  const urls = (inUse?.results ?? []).flatMap((r) => (r.url === undefined ? [] : [r.url]));
  const ids = [
    installId,
    ...(others?.results ?? []).flatMap((r) => (r.id === undefined ? [] : [r.id])),
  ];
  return ids.map((id) => {
    const prefixUrl = sandboxObjectUrl(installBuildsPrefix(id));
    const keep = urls.flatMap((url) => versionUnder(url, prefixUrl) ?? []);
    return { installId: id, keepVersions: [...new Set(keep)].sort() };
  });
}

/** The ids of the installs a statement retired, as its `RETURNING id` gave them back. */
export function retiredInstallIds(result: D1Result | undefined): string[] {
  return (result?.results ?? []).flatMap((row) => {
    const id = (row as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * Deletes the builds of failed installs retired without an uninstall job
 * (there is none to delete them), as their uninstall would: but the
 * versions another install still reads, such as the build a new install
 * installs again. Housekeeping: a failure is logged and the files stay in
 * the bucket.
 */
export async function cleanupRetiredBuilds(
  d1: D1Database,
  installIds: Iterable<string>,
  cleanup: (target: BuildCleanupTarget) => Promise<void>,
): Promise<void> {
  for (const installId of new Set(installIds)) {
    try {
      for (const target of await buildCleanupTargets(d1, installId)) await cleanup(target);
    } catch (error) {
      console.warn("could not delete the sandbox builds of a retired install", {
        installId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Deletes the builds of an install being uninstalled ({@link buildCleanupTargets}).
 * Housekeeping: a failure is logged and never fails the job.
 */
export async function removeInstallBuildsPhase(
  steps: JobSteps,
  env: JobEnv,
  installId: string,
): Promise<void> {
  // The step name of the earlier clean-up, which deleted the install's own prefix only.
  await steps.run("clean up sandbox builds", async ({ log }) => {
    const binding = sandboxBinding(env);
    if (binding === undefined) {
      log.warn(
        "Appflare is not connected to the sandbox Worker, so this install's builds stay in its bucket (appflare-builds).",
      );
      return {};
    }
    let targets: BuildCleanupTarget[];
    try {
      targets = await buildCleanupTargets(env.DB, installId);
    } catch (error) {
      log.warn(
        `Could not work out which sandbox builds to delete: ${error instanceof Error ? error.message : String(error)}. They stay in the bucket appflare-builds.`,
      );
      return {};
    }
    for (const target of targets) {
      const whose =
        target.installId === installId
          ? "this install's sandbox builds"
          : "the sandbox builds of the install it replaced";
      // More versions in use than one call takes: left for the installs that use them.
      if (!buildCleanupRequestSchema.safeParse(target).success) {
        log.warn(`Kept ${whose}: too many of their versions are still in use.`);
        continue;
      }
      try {
        const result = await binding.cleanup(target);
        const deleted =
          typeof result === "object" && result !== null && "deleted" in result
            ? Number(result.deleted)
            : 0;
        log.info(
          target.keepVersions.length === 0
            ? `Deleted ${whose} (${deleted} object(s)).`
            : `Deleted ${whose} but ${target.keepVersions.join(" and ")}, which another install uses (${deleted} object(s)).`,
        );
      } catch (error) {
        log.warn(
          `Could not delete ${whose}: ${error instanceof Error ? error.message : String(error)}. They stay in the bucket appflare-builds.`,
        );
      }
    }
    return {};
  });
}
