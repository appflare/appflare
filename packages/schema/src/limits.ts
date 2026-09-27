import { planSpans, type SpanFile } from "./spans";

/**
 * What one Worker upload may cost, so that an artifact Appflare cannot
 * install is refused when it is packed and before a job changes anything.
 *
 * Cloudflare has no limit on how many modules a Worker has. What binds the
 * manager is the upload itself: it sends a Worker (install, update,
 * self-update) as ONE multipart request carrying every module, and reads the
 * modules from the artifact zip in that same invocation. Workers Free allows
 * 50 subrequests per invocation, and every hop of a redirect counts
 * (developers.cloudflare.com/workers/platform/limits, "Subrequests"). The
 * reader follows the release asset's redirect once and then reads modules
 * that lie next to each other in the zip with one Range request per span
 * ({@link planSpans}), so the cost is one redirect plus the spans, whatever
 * the module count. The other bound is memory: the invocation holds every
 * module and the request body at once, inside the 128 MB a Worker may use.
 */

/** Subrequests one Workers Free invocation may make. */
export const FREE_PLAN_SUBREQUESTS = 50;

/** Worst-case subrequests of the first artifact Range fetch: the redirect plus the real request. */
export const ARTIFACT_FETCH_SUBREQUESTS = 2;

/**
 * Subrequests the invocation that uploads a Worker makes besides fetching
 * modules: the upload itself and one follow-up read (2), the step's D1 writes
 * (log flush and job row updates, 3), and the work every invocation repeats
 * outside steps (the database migration check and reading the manifest back
 * from KV, 3).
 */
export const WORKER_UPLOAD_OVERHEAD_SUBREQUESTS = 8;

/** Subrequests one upload may spend reading its modules: 42. */
export const MAX_WORKER_UPLOAD_SUBREQUESTS =
  FREE_PLAN_SUBREQUESTS - WORKER_UPLOAD_OVERHEAD_SUBREQUESTS;

/**
 * The most module bytes one Worker upload carries: 32 MiB. The invocation
 * holds the modules and the multipart body built from them at the same time,
 * so this stays well inside the 128 MB isolate, and below the 64 MiB
 * Cloudflare accepts for a Worker on every plan.
 */
export const MAX_WORKER_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * No longer a limit. Tools built against the previous release read this
 * export by name, so it stays for one release; check
 * {@link workerUploadProblem} instead.
 *
 * @deprecated Cloudflare has no module count limit; use {@link workerUploadProblem}.
 */
export const MAX_WORKER_MODULES = 21;

/**
 * Subrequests one upload spends reading `modules` from a release asset: the
 * redirect, followed once, plus one Range request per span. Zero when there
 * is nothing to read.
 */
export function workerUploadCost(modules: readonly SpanFile[]): number {
  return rangeReadCost(planSpans(modules).length);
}

/** Subrequests reading `ranges` Range requests from a release asset costs: the redirect once, then one each. */
export function rangeReadCost(ranges: number): number {
  return ranges === 0 ? 0 : ARTIFACT_FETCH_SUBREQUESTS - 1 + ranges;
}

/** Rounded up, so a size just over the cap never reads as the cap itself. */
function mib(bytes: number): string {
  return `${(Math.ceil((bytes * 100) / (1024 * 1024)) / 100).toFixed(2)} MiB`;
}

/**
 * Why a Worker of `modules` cannot be uploaded in one request, or null when it
 * can. `subject` names the Worker in the message ("The release", "This
 * version").
 */
export function workerUploadProblem(
  modules: readonly SpanFile[],
  subject = "The artifact",
): string | null {
  const problems: string[] = [];
  const bytes = modules.reduce((n, m) => n + m.size, 0);
  if (bytes > MAX_WORKER_UPLOAD_BYTES) {
    problems.push(
      `${subject} has ${mib(bytes)} of Worker modules, but Appflare uploads at most ` +
        `${mib(MAX_WORKER_UPLOAD_BYTES)}: the upload holds every module and the request body ` +
        "in memory at once, within the 128 MB a Worker may use. Make the Worker smaller, " +
        "for example by minifying it or serving large files as static assets.",
    );
  }
  const cost = workerUploadCost(modules);
  if (cost > MAX_WORKER_UPLOAD_SUBREQUESTS) {
    problems.push(
      `${subject} needs ${cost} subrequests to read its ${modules.length} Worker modules ` +
        `(${cost - 1} Range requests to the release zip and the redirect), but one upload may ` +
        `make at most ${MAX_WORKER_UPLOAD_SUBREQUESTS} of the free plan's ` +
        `${FREE_PLAN_SUBREQUESTS} per invocation. Pack it again with the current packer, ` +
        "which writes a Worker's modules next to each other in the zip.",
    );
  }
  return problems.length === 0 ? null : problems.join(" ");
}
