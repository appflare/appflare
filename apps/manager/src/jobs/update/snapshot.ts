import { eq } from "drizzle-orm";
import { installs, snapshots } from "../../db/schema";
import type { EntryWorker } from "../entry-workers";
import { readOtherWorkerVersionsPhase } from "../install/entry-worker-phases";
import { JobError, type JobSteps } from "../steps";
import { activeVersionId, boundHyperdriveIds, type RecordedResource, snapshotRow } from "./plan";

/**
 * The snapshot an update or a settings change takes before it changes
 * anything: the version serving all traffic, a D1 Time Travel bookmark per
 * database, and the install's catalog state and settings, one step each.
 * The snapshot's id is the job's, so a retried step never inserts twice.
 */
export async function takeSnapshotPhase(
  steps: JobSteps,
  input: {
    installId: string;
    jobId: string;
    workerName: string;
    /** The version Appflare recorded as serving (warned about when Cloudflare says otherwise). */
    recordedVersionId: string | null;
    /** The install's live resources; its D1 databases get a bookmark. */
    resources: readonly RecordedResource[];
    /** The Durable Object migration tag the Worker has now. */
    appliedDoTag: string | null;
    /** The catalog version the job moves to (the installed one for a settings change). */
    targetVersion: string;
    /** An app of several Workers: its other Workers, whose serving versions the snapshot keeps too. */
    otherWorkers?: readonly EntryWorker[];
    /**
     * The audience tag of the Access protection the serving version was
     * deployed with (`""` unprotected); null or absent when not known.
     */
    accessAud?: string | null;
  },
): Promise<{ versionId: string; databases: number; otherVersions: Record<string, string> }> {
  const { run, now } = steps;
  const deployed = await run("read current deployment", async ({ log, cf }) => {
    const versionId = activeVersionId(await cf().versions.listDeployments(input.workerName));
    if (versionId === null) {
      throw new JobError(
        "no single version serves all of the Worker's traffic (a gradual deployment is in progress); finish or undo it in the Cloudflare dashboard first",
      );
    }
    if (input.recordedVersionId !== null && versionId !== input.recordedVersionId) {
      log.warn(
        `Cloudflare serves version ${versionId}, not ${input.recordedVersionId} as Appflare recorded; the snapshot keeps the one serving.`,
      );
    }
    log.info(`Version ${versionId} serves all traffic.`);
    return { versionId };
  });
  const otherVersions = await readOtherWorkerVersionsPhase(steps, input.otherWorkers ?? []);
  const bookmarks: Array<{ databaseId: string; bookmark: string }> = [];
  for (const db of input.resources) {
    if (db.kind !== "d1" || db.cfId === null) continue;
    const databaseId = db.cfId;
    const got = await run(`bookmark D1 ${db.name}`, async ({ log, cf }) => {
      const { bookmark } = await cf().d1.bookmark(databaseId);
      log.info(`Time Travel bookmark of ${db.name}: ${bookmark}.`);
      return { bookmark };
    });
    bookmarks.push({ databaseId, bookmark: got.bookmark });
  }
  await run("record snapshot", async ({ log, orm }) => {
    const [install] = await orm
      .select()
      .from(installs)
      .where(eq(installs.id, input.installId))
      .limit(1);
    if (install === undefined) throw new JobError("the install no longer exists");
    await orm
      .insert(snapshots)
      .values(
        snapshotRow({
          id: input.jobId,
          installId: input.installId,
          jobId: input.jobId,
          workerVersionId: deployed.versionId,
          bookmarks,
          takenAt: new Date(now()),
          before: install,
          doMigrationTag: input.appliedDoTag,
          targetVersion: input.targetVersion,
          otherVersions,
          // What the serving version binds, so a rollback can tell it is still there.
          hyperdrive: boundHyperdriveIds(input.resources),
          accessAud: input.accessAud ?? null,
        }),
      )
      .onConflictDoNothing();
    log.info(
      `Snapshot taken: version ${deployed.versionId} and ${bookmarks.length} D1 bookmark(s).`,
    );
    return {};
  });
  return { versionId: deployed.versionId, databases: bookmarks.length, otherVersions };
}
