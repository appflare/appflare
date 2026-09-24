import type { EnvBinding, WorkerVersion } from "@appflare/cf-api";
import { eq } from "drizzle-orm";
import { jobs } from "../../db/schema";
import { JobError, type JobSteps } from "../steps";
import {
  type SecretChanges,
  type SecretSlot,
  secretEnvPatch,
  secretsUndoneMessage,
  secretVersionMessage,
} from "./plan";

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The Worker's newest version: the highest `number`, however the API orders
 * its list (as connecting sandbox builds reads it).
 */
export function newestVersion(versions: readonly WorkerVersion[]): WorkerVersion | undefined {
  return [...versions].sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
}

/**
 * Step "set and remove secrets": makes the version the settings change
 * uploaded carry the new secret values and drop the removed ones, before
 * anything serves it.
 *
 * Setting a secret on the script (`PUT /workers/scripts/{name}/secrets`)
 * deploys a version at once, and Cloudflare refuses it (code 10215) while the
 * newest version is not deployed, which is exactly the state after the
 * upload. So the changes go through the versions secrets API that
 * `wrangler versions secret put` and `delete` use: `PATCH
 * /workers/workers/{name}/versions/latest` with a merge patch of the `env`
 * (one `secret_text` binding per new value, `null` per removed name) creates
 * a new version from the uploaded one, which serves nothing until the job
 * promotes it. Verified live: the new version keeps the uploaded vars and the
 * other secrets, and its preview URL serves the new values.
 *
 * Replay-safe: the new version is annotated with this job's id, and the step
 * first reads the newest version. When that is already this job's, a step
 * that ran again after it finished (or whose answer was lost) reuses it
 * instead of patching twice; when it is neither the upload nor this job's
 * version, another upload happened meanwhile and the step stops before
 * changing anything. One list and at most one patch, two subrequests however
 * many secrets change. Secret values go only into the patch; the log names
 * the secrets.
 */
export async function applySecretChangesPhase(
  steps: JobSteps,
  input: {
    jobId: string;
    workerName: string;
    /** The version the job uploaded, which must be the Worker's newest. */
    uploadedVersionId: string;
    /** The catalog version, as the version's tag. */
    version: string;
    changes: SecretChanges;
  },
): Promise<{ versionId: string }> {
  const { jobId, workerName, uploadedVersionId, changes } = input;
  return steps.run("set and remove secrets", async ({ log, cf, orm }) => {
    const api = cf();
    const marker = secretVersionMessage(jobId);
    const newest = newestVersion(await api.versions.listVersions(workerName));
    let versionId: string;
    if (newest !== undefined && newest.annotations?.["workers/message"] === marker) {
      versionId = newest.id;
      log.info(
        `Version ${versionId} already carries this job's secret changes (an earlier attempt of this step made it).`,
      );
    } else {
      if (newest?.id !== uploadedVersionId) {
        throw new JobError(
          `another version of the Worker (${newest?.id ?? "none"}) was uploaded after this job's version ${uploadedVersionId}; nothing serves the new settings, so start the change again`,
        );
      }
      const patched = await api.versions.patchLatestVersion(workerName, {
        env: secretEnvPatch(changes),
        annotations: { "workers/message": marker, "workers/tag": input.version },
      });
      versionId = patched.id;
      const set = Object.keys(changes.set).sort();
      const removed = [...new Set(changes.unset)].sort();
      const what = [
        ...(set.length > 0 ? [`set new values of ${list(set)}`] : []),
        ...(removed.length > 0 ? [`removed ${list(removed)}`] : []),
      ].join(" and ");
      log.info(
        `Version ${versionId}: ${what} on top of version ${uploadedVersionId}; it serves no traffic yet.`,
        { versionId, set, removed },
      );
    }
    await orm.update(jobs).set({ worker_version_id: versionId }).where(eq(jobs.id, jobId));
    return { versionId };
  });
}

/**
 * The merge patch that gives the newest version back the secrets of the
 * version serving traffic: each changed name inherits its binding from that
 * version (`{ type: "inherit", version_id }`), or is dropped when that
 * version never had it. Values are never read; Cloudflare copies them.
 */
export function undoSecretsPatch(
  changes: SecretChanges,
  slots: readonly SecretSlot[],
  servingVersionId: string,
): Record<string, EnvBinding | null> {
  const present = new Set(slots.filter((s) => s.present).map((s) => s.name));
  const env: Record<string, EnvBinding | null> = {};
  for (const name of [...Object.keys(changes.set), ...changes.unset]) {
    env[name] = present.has(name) ? { type: "inherit", version_id: servingVersionId } : null;
  }
  return env;
}

/**
 * Step "put back the previous secrets", when a settings change fails after
 * it made its secrets version and before promoting it.
 *
 * Every later version upload with `keep_bindings: ["secret_text"]` (an
 * update's, the next settings change's) copies the secrets of the Worker's
 * NEWEST version, not of the one serving (verified live: a version uploaded
 * after an unpromoted secrets patch had the patched values). Left alone, the
 * abandoned new values would ride along with the next update. So the step
 * patches the newest version once more, each changed secret inheriting its
 * binding from the serving version (verified live: `{ type: "inherit",
 * version_id }` in the merge patch restores the serving value, and the next
 * upload keeps it). It does so only while the newest version is this job's
 * own; a version someone uploaded since is left alone, and said so.
 *
 * An update uses the same step: the secrets a new version introduces ride on
 * its upload, so there the uploaded version itself carries the new values
 * (`carrier: "upload"`), and a failure before promotion leaves them on the
 * newest version just the same.
 */
export async function undoSecretChangesPhase(
  steps: JobSteps,
  input: {
    jobId: string;
    workerName: string;
    /**
     * The version this job uploaded (before its secrets patch); null when the
     * upload's answer did not say (an update then finds it by `uploadMessage`).
     */
    uploadedVersionId: string | null;
    /** The version serving all traffic, which the snapshot recorded. */
    servingVersionId: string;
    changes: SecretChanges;
    slots: readonly SecretSlot[];
    /**
     * Which version carries the job's new values: `patch` (default), the one
     * its secrets patch made from the upload; `upload`, the upload itself.
     */
    carrier?: "patch" | "upload";
    /** With `carrier: "upload"`: the upload's `workers/message` annotation. */
    uploadMessage?: string;
    /** The annotation of the version that puts the serving secrets back. */
    undoneMessage?: string;
  },
): Promise<"undone" | "not-needed" | "left"> {
  const { jobId, workerName } = input;
  const undoneMessage = input.undoneMessage ?? secretsUndoneMessage(jobId);
  const result = await steps.run("put back the previous secrets", async ({ log, cf }) => {
    const api = cf();
    const newest = newestVersion(await api.versions.listVersions(workerName));
    const message = newest?.annotations?.["workers/message"];
    if (message === undoneMessage) {
      log.info(`Version ${newest?.id} already has the secrets of the serving version back.`);
      return { outcome: "undone" as const };
    }
    const carries =
      input.carrier === "upload"
        ? newest !== undefined &&
          (newest.id === input.uploadedVersionId ||
            (input.uploadMessage !== undefined && message === input.uploadMessage))
        : message === secretVersionMessage(jobId);
    if (!carries) {
      if (
        newest === undefined ||
        // The upload never reported a version and none is annotated as its own.
        (input.carrier === "upload" && input.uploadedVersionId === null) ||
        (input.carrier !== "upload" && newest.id === input.uploadedVersionId)
      ) {
        // The patch never happened: the upload kept the serving secrets.
        log.info("The Worker's newest version does not carry this job's secret changes.");
        return { outcome: "not-needed" as const };
      }
      log.warn(
        `Another version (${newest.id}) was uploaded after this job's; its secrets are left as they are.`,
      );
      return { outcome: "left" as const };
    }
    const restored = await api.versions.patchLatestVersion(workerName, {
      env: undoSecretsPatch(input.changes, input.slots, input.servingVersionId),
      annotations: { "workers/message": undoneMessage },
    });
    log.info(
      `Version ${restored.id} has the secrets of the serving version ${input.servingVersionId} again, so the next upload keeps those and not this job's.`,
    );
    return { outcome: "undone" as const };
  });
  return result.outcome;
}
