/**
 * How many Worker modules an artifact may have and still be installable.
 *
 * The manager uploads a Worker (install, update, self-update) as ONE
 * multipart request carrying every module, and Range-fetches each module from
 * the artifact zip in that same Workflow invocation. Workers Free allows 50
 * subrequests per invocation, and every hop of a redirect counts
 * (developers.cloudflare.com/workers/platform/limits, "Subrequests"). A
 * GitHub release asset answers a Range request with a redirect to its storage
 * host, so each module costs two subrequests. An artifact with more modules
 * than {@link MAX_WORKER_MODULES} can be packed and verified but never
 * installed or updated by the manager; bundle the Worker into fewer modules
 * (ideally one) instead.
 */

/** Subrequests one Workers Free invocation may make. */
export const FREE_PLAN_SUBREQUESTS = 50;

/** Worst-case subrequests of one artifact Range fetch: the redirect plus the real request. */
export const ARTIFACT_FETCH_SUBREQUESTS = 2;

/**
 * Subrequests the invocation that uploads a Worker makes besides fetching
 * modules: the upload itself and one follow-up read (2), the step's D1 writes
 * (log flush and job row updates, 3), and the work every invocation repeats
 * outside steps (the database migration check and reading the manifest back
 * from KV, 3).
 */
export const WORKER_UPLOAD_OVERHEAD_SUBREQUESTS = 8;

/** The most Worker modules one upload can Range-fetch within {@link FREE_PLAN_SUBREQUESTS}. */
export const MAX_WORKER_MODULES = Math.floor(
  (FREE_PLAN_SUBREQUESTS - WORKER_UPLOAD_OVERHEAD_SUBREQUESTS) / ARTIFACT_FETCH_SUBREQUESTS,
);

/**
 * Why an artifact with `count` Worker modules cannot be uploaded, or null
 * when it can. `subject` names the artifact in the message ("The release",
 * "This version").
 */
export function tooManyModulesMessage(
  count: number,
  subject = "The artifact",
  limit: number = MAX_WORKER_MODULES,
): string | null {
  if (count <= limit) return null;
  return (
    `${subject} has ${count} Worker modules, but one upload can fetch at most ${limit} ` +
    `within the free plan's ${FREE_PLAN_SUBREQUESTS} subrequests per invocation ` +
    `(${ARTIFACT_FETCH_SUBREQUESTS} per module from a release asset). ` +
    `It must be built as ${limit} or fewer modules, for example as one bundled module.`
  );
}
