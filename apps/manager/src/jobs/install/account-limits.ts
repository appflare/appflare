import { CloudflareApiError, type CloudflareClient } from "@appflare/cf-api";
import { KIND_LIMITS, type KindLimit, type LimitedKind } from "../../catalog/account-limits";
import { errorMessage, JobError } from "../errors";
import type { JobSteps } from "../steps";
import { PAID_ALREADY } from "./cron-limit";

/**
 * The account limits an install checks before it creates anything (the
 * numbers in ../../catalog/account-limits.ts). Before anything is created,
 * the install counts the account's resources of each kind it is about to
 * create, one list call per kind, and stops when the new ones would take
 * the account past the limit. Cloudflare refuses the create otherwise, with
 * the app part installed: a D1 database past the limit is refused with 403,
 * code 7406, "System limit reached: databases per account (10)", seen on
 * Workers Free.
 */

export type { LimitedKind };

interface KindCheck extends KindLimit {
  /** What to remove to make room. */
  remove: string;
  /** The step that counts them. */
  step: string;
}

export const ACCOUNT_LIMITS: Record<LimitedKind, KindCheck> = {
  d1: {
    ...KIND_LIMITS.d1,
    remove:
      "Delete D1 databases the account no longer uses (for example by uninstalling an app that has one without keeping its data)",
    step: "check D1 database limit",
  },
  hyperdrive: {
    ...KIND_LIMITS.hyperdrive,
    remove:
      "Delete Hyperdrive configurations the account no longer uses (for example by uninstalling an app that connects to a database)",
    step: "check Hyperdrive configuration limit",
  },
  vectorize: {
    ...KIND_LIMITS.vectorize,
    remove:
      "Delete Vectorize indexes the account no longer uses (for example by uninstalling an app that has one without keeping its data)",
    step: "check Vectorize index limit",
  },
};

/**
 * Whether Workers Free's account limits apply to a job: unless the account
 * is known to be on Workers Paid (detected, or set in Settings). The admin's
 * "this account is on Workers Paid" for one job counts only while Appflare
 * does not know the plan; against a plan detected or set as free it does
 * not, so a tick in a form never skips the count that keeps an install from
 * stopping part way. `knownFree` is undefined in a step output recorded
 * before it existed, which keeps the earlier rule (the tick counts).
 */
export function freeLimitsApply(plan: {
  paid: boolean;
  knownFree: boolean | undefined;
  paidConfirmed: boolean;
}): boolean {
  if (plan.paid) return false;
  if (plan.knownFree === true) return true;
  return !plan.paidConfirmed;
}

function phrase(kind: LimitedKind, count: number): string {
  const limit = ACCOUNT_LIMITS[kind];
  return `${count.toLocaleString("en-US")} ${count === 1 ? limit.one : limit.many}`;
}

/**
 * The limit the account's count is held to: Workers Free's while it
 * applies, unless the account already has more than Workers Free allows,
 * which only an account on Workers Paid can have (as the cron trigger count
 * reads it); then Workers Paid's. An account past Workers Paid's limit has
 * had it raised, and is not held to a limit at all. Null: no limit an
 * install could meet.
 */
export function limitInForce(input: {
  kind: LimitedKind;
  existing: number;
  freeLimits: boolean;
}): { max: number; plan: "Workers Free" | "Workers Paid" } | null {
  const limit = ACCOUNT_LIMITS[input.kind];
  if (input.freeLimits && input.existing <= limit.free) {
    return { max: limit.free, plan: "Workers Free" };
  }
  if (limit.paid === null || input.existing > limit.paid) return null;
  return { max: limit.paid, plan: "Workers Paid" };
}

/** Why `wanted` more would not fit the account, or null when they fit. */
export function accountLimitRefusal(input: {
  kind: LimitedKind;
  /** How many the account has now. */
  existing: number;
  wanted: number;
  freeLimits: boolean;
}): string | null {
  const limit = ACCOUNT_LIMITS[input.kind];
  const inForce = limitInForce(input);
  if (inForce === null) return null;
  const { max, plan } = inForce;
  const total = input.existing + input.wanted;
  if (total <= max) return null;
  const free = plan === "Workers Free";
  const upgrade =
    free && limit.paidStated > limit.free
      ? `, or upgrade the account to Workers Paid (${limit.paidStated.toLocaleString("en-US")} per account)`
      : "";
  const paidAlready = free ? ` ${PAID_ALREADY}` : "";
  return `this app needs ${input.wanted === 1 ? `a new ${limit.one}` : `${input.wanted} new ${limit.many}`} and the account already has ${input.existing.toLocaleString("en-US")}; ${plan} allows ${max.toLocaleString("en-US")} per account, so this would make ${total.toLocaleString("en-US")}. ${limit.remove}${upgrade}.${paidAlready} Then try again.`;
}

async function countOf(api: CloudflareClient, kind: LimitedKind): Promise<number> {
  switch (kind) {
    case "d1":
      return (await api.d1.listDatabases()).length;
    case "hyperdrive":
      return (await api.hyperdrive.listConfigs()).length;
    case "vectorize":
      return (await api.vectorize.listIndexes()).length;
  }
}

/**
 * One step per kind the install creates: counts the account's resources of
 * that kind and stops the job when the new ones would not fit. Counting
 * that fails only warns: Cloudflare checks the limit itself when the
 * resource is created ({@link explainLimitRefusal}).
 */
export async function checkAccountLimitsPhase(
  steps: JobSteps,
  input: { wanted: Partial<Record<LimitedKind, number>>; freeLimits: boolean },
): Promise<void> {
  for (const kind of Object.keys(ACCOUNT_LIMITS) as LimitedKind[]) {
    const wanted = input.wanted[kind] ?? 0;
    const limit = ACCOUNT_LIMITS[kind];
    const max = input.freeLimits ? limit.free : limit.paid;
    if (wanted === 0 || max === null) continue;
    await steps.run(limit.step, async ({ log, cf }) => {
      let existing: number;
      try {
        existing = await countOf(cf(), kind);
      } catch (error) {
        log.warn(
          `Could not count the account's ${limit.many} (${errorMessage(error)}); going on, and Cloudflare checks its limit when they are created.`,
        );
        return {};
      }
      const refusal = accountLimitRefusal({
        kind,
        existing,
        wanted,
        freeLimits: input.freeLimits,
      });
      if (refusal !== null) throw new JobError(refusal);
      const inForce = limitInForce({ kind, existing, freeLimits: input.freeLimits });
      const past = limit.paid !== null && existing > limit.paid ? "Workers Paid" : "Workers Free";
      log.info(
        inForce === null
          ? `The account has ${phrase(kind, existing)}, more than ${past} allows, so ${past === "Workers Free" ? "the account is not on Workers Free" : "its limit was raised"}.`
          : `The account has ${phrase(kind, existing)}; with ${wanted} more that is ${existing + wanted} of the ${inForce.max.toLocaleString("en-US")} ${inForce.plan} allows.`,
      );
      return {};
    });
  }
}

/** Cloudflare's code for a create refused at an account's limit ("System limit reached: …"). */
export const SYSTEM_LIMIT_ERROR_CODE = 7406;

/**
 * Runs a create and turns Cloudflare's refusal at the account's limit into
 * a sentence that names the limit and what to do; anything else is passed
 * on as is. A `JobError`, so the step fails at once: a retry meets the same
 * limit.
 */
export async function explainLimitRefusal<T>(
  kind: LimitedKind,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
    const refusal = error.errors.find(
      (e) => e.code === SYSTEM_LIMIT_ERROR_CODE || /system limit reached/i.test(e.message),
    );
    if (refusal === undefined) throw error;
    const limit = ACCOUNT_LIMITS[kind];
    const stated = /\((\d[\d,]*)\)/.exec(refusal.message)?.[1];
    const count = stated === undefined ? null : Number(stated.replaceAll(",", ""));
    const reached =
      count === null
        ? `this account has reached its limit of ${limit.many} per account`
        : `this account has reached its limit of ${count.toLocaleString("en-US")} ${limit.many} per account`;
    const upgrade =
      count !== null && count <= limit.free && limit.paidStated > limit.free
        ? `, or upgrade the account to Workers Paid (${limit.paidStated.toLocaleString("en-US")} per account)`
        : "";
    // Cloudflare's answer whole, in brackets, so the usage report still
    // reads its status and code from the job's error.
    throw new JobError(
      `Cloudflare refused another ${limit.one}: ${reached} (${errorMessage(error)}). ${limit.remove}${upgrade}, then try again.`,
    );
  }
}
