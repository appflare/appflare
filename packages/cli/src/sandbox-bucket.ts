import { z } from "zod";
import { CLOUDFLARE_API, wranglerApiToken } from "./api-token.ts";
import type { FetchLike } from "./release.ts";
import type { Wrangler } from "./wrangler.ts";

/**
 * Empties an R2 bucket so it can be deleted (Cloudflare refuses to delete a
 * bucket that holds objects, and wrangler has no command that lists or
 * empties one). Uses the Cloudflare API's "empty bucket" job: `DELETE
 * /accounts/{account}/r2/buckets/{bucket}/objects?prefix=` starts it, `GET
 * …/jobs/{id}` reports its progress. Authenticated with wrangler's own
 * credential, which is never shown.
 */

const jobSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["ENQUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  prefixDelete: z.looseObject({ deletedObjects: z.number() }).optional(),
});
const envelopeSchema = z.looseObject({
  success: z.boolean(),
  errors: z.array(z.looseObject({ code: z.number(), message: z.string() })).default([]),
  result: z.unknown(),
});

/** Cloudflare's code for "the bucket does not exist". */
const NO_SUCH_BUCKET = 10006;

export type EmptyBucketOutcome =
  | { kind: "emptied"; deletedObjects: number }
  | { kind: "missing" }
  | { kind: "failed"; reason: string };

export interface EmptyBucketOptions {
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the job; 5 minutes by default. */
  timeoutMs?: number;
  now?: () => number;
}

export async function emptyBucket(
  wrangler: Wrangler,
  fetchFn: FetchLike,
  bucket: string,
  options: EmptyBucketOptions = {},
): Promise<EmptyBucketOutcome> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 5 * 60_000);
  const accountId = wrangler.accountId;
  if (!accountId) {
    return { kind: "failed", reason: "no account is selected" };
  }
  const token = await wranglerApiToken(wrangler);
  if (!token) {
    return {
      kind: "failed",
      reason: "wrangler has no API credential to give (`wrangler auth token`)",
    };
  }
  const base = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}`;
  const call = async (method: string, path: string) => {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = envelopeSchema.safeParse(await response.json().catch(() => null));
    return { status: response.status, body: body.success ? body.data : null };
  };
  const describe = (status: number, body: z.infer<typeof envelopeSchema> | null) =>
    body?.errors[0] ? `${body.errors[0].message} (code ${body.errors[0].code})` : `HTTP ${status}`;

  try {
    const started = await call("DELETE", "/objects?prefix=");
    if (started.body?.errors.some((e) => e.code === NO_SUCH_BUCKET)) {
      return { kind: "missing" };
    }
    if (!started.body?.success) {
      return {
        kind: "failed",
        reason: `emptying the bucket failed: ${describe(started.status, started.body)}`,
      };
    }
    let job = jobSchema.parse(started.body.result);
    while (job.status === "ENQUEUED" || job.status === "RUNNING") {
      if (now() >= deadline) {
        return {
          kind: "failed",
          reason:
            "emptying the bucket is still running; it finishes on its own, then run this again",
        };
      }
      await sleep(2_000);
      const polled = await call("GET", `/jobs/${encodeURIComponent(job.id)}`);
      if (!polled.body?.success) {
        return {
          kind: "failed",
          reason: `reading the empty-bucket job failed: ${describe(polled.status, polled.body)}`,
        };
      }
      job = jobSchema.parse(polled.body.result);
    }
    if (job.status !== "COMPLETED") {
      return { kind: "failed", reason: `the empty-bucket job ended ${job.status}` };
    }
    return { kind: "emptied", deletedObjects: job.prefixDelete?.deletedObjects ?? 0 };
  } catch (error) {
    // Never the credential: only the error's own message.
    return {
      kind: "failed",
      reason: `the Cloudflare API call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
