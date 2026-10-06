import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { type Budget, BudgetExceededError } from "../budget";
import { CONNECT_AGAIN, classifyCloudflareError, errorCodes } from "../cloudflare";
import type { InstallerConfig } from "../config";
import type { InstallationRow } from "../db/schema";
import { InstallerError } from "../http";
import { logError, logEvent } from "../log";
import { type Database, type InstallationStatus, type RecordPatch, updateRecord } from "../records";
import { ReleaseError, ReleaseFetchError } from "../release/fetch";
import { storedManifest } from "../release/manifest";
import { type StepContext, StepFailure, type StepResult } from "./context";
import { isStepId, STEP_LABELS, STEPS, type StepId, stepsFor } from "./steps";

/** What `/step` answers. */
export interface StepResponse {
  status: "running" | "waiting" | "deployed" | "failed";
  step: { id: StepId; label: string };
  done: number;
  total: number;
  retryAfterMs?: number;
  /** About `step`: why it waits or failed, or how far it got. Never about another step. */
  message?: string;
  /**
   * The step this request finished, when it said something about it (a
   * warning, or what it created). Only on the answer that moves on from it.
   */
  completed?: { step: { id: StepId; label: string }; message: string };
}

export const REMOVING = new InstallerError(409, "removing", "This installation is being removed.");

/** The wait the deploy page is asked for after a hiccup (Cloudflare or GitHub busy). */
const TRANSIENT_RETRY_MS = 5_000;

export function stepResponse(
  record: InstallationRow,
  extra: Partial<StepResponse> = {},
): StepResponse {
  const steps = stepsFor(record);
  const id: StepId = isStepId(record.step) ? record.step : "release";
  const status: StepResponse["status"] =
    record.status === "deployed" || record.status === "failed" || record.status === "waiting"
      ? record.status
      : "running";
  const index = steps.indexOf(id);
  return {
    status,
    step: { id, label: STEP_LABELS[id] },
    done: status === "deployed" ? steps.length : Math.max(0, index),
    total: steps.length,
    ...(record.message === null ? {} : { message: record.message }),
    ...extra,
  };
}

export interface RunDeps {
  db: Database;
  api: CloudflareClient;
  fetch: FetchLike;
  budget: Budget;
  config: InstallerConfig;
  now: number;
}

/**
 * Runs the record's current step once and records the outcome. A step that
 * fails for a reason a person can fix leaves the record `failed` on that
 * step; asking again runs the step again. A step that meets a busy or
 * unreachable host leaves it `waiting`. A token Cloudflare no longer
 * accepts changes nothing and answers 401, so the deploy page reconnects.
 */
export async function runStep(record: InstallationRow, deps: RunDeps): Promise<StepResponse> {
  // Read under the lease: a removal that started after the caller first
  // looked at the record wins, and this step does nothing.
  if (record.status === "removing") throw REMOVING;
  if (record.status === "deployed") return stepResponse(record);
  const stepId: StepId = isStepId(record.step) ? record.step : "release";
  const current = { ...record };
  const save = async (patch: RecordPatch) => {
    Object.assign(current, patch);
    await updateRecord(deps.db, record.id, patch, deps.now);
  };

  let result: StepResult;
  try {
    const ctx: StepContext = {
      record: current,
      manifest: await storedManifest(record.release_manifest, record.release_digest),
      api: deps.api,
      fetch: deps.fetch,
      budget: deps.budget,
      now: deps.now,
      config: deps.config,
      save,
    };
    result = await STEPS[stepId](ctx);
  } catch (error) {
    return failed(error, stepId, current, save, deps);
  } finally {
    logEvent("step", { step: stepId, subrequests: deps.budget.used });
  }

  if (result.kind === "wait") {
    await save({ status: "waiting", message: result.message });
    return stepResponse(current, { retryAfterMs: result.retryAfterMs });
  }
  if (result.kind === "again") {
    await save({ status: "running", message: result.message });
    return stepResponse(current);
  }
  const steps = stepsFor(current);
  const next = steps[steps.indexOf(stepId) + 1];
  const message = result.message ?? null;
  if (next === undefined) {
    // The last step stays the record's step, so its message still pairs with it.
    await save({ status: "deployed", message });
    return stepResponse(current);
  }
  // The finished step's message goes back once, as `completed`; the record
  // keeps none, so nothing reads it later as news about the next step.
  await save({ status: "running", step: next, message: null });
  return stepResponse(
    current,
    message === null
      ? {}
      : { completed: { step: { id: stepId, label: STEP_LABELS[stepId] }, message } },
  );
}

async function failed(
  error: unknown,
  stepId: StepId,
  current: InstallationRow,
  save: (patch: RecordPatch) => Promise<void>,
  deps: RunDeps,
): Promise<StepResponse> {
  const set = async (status: InstallationStatus, message: string, retryAfterMs?: number) => {
    await save({ status, message });
    return stepResponse(current, retryAfterMs === undefined ? {} : { retryAfterMs });
  };
  if (error instanceof StepFailure) {
    logEvent("step_refused", { step: stepId });
    return set("failed", error.message);
  }
  if (error instanceof ReleaseFetchError) {
    logError("release_fetch", { step: stepId, retryable: error.retryable });
    return error.retryable
      ? set(
          "waiting",
          "GitHub, where Appflare's release is stored, did not answer. Trying again shortly.",
          TRANSIENT_RETRY_MS,
        )
      : set("failed", "Appflare's release could not be read from GitHub. Try again later.");
  }
  if (error instanceof ReleaseError) {
    logError("release_refused", { step: stepId, kind: error.kind });
    return set(
      "failed",
      error.kind === "files"
        ? "Appflare's release files do not match their signature, so nothing more is installed from them. Try again later."
        : "The release information this installation keeps is damaged. Remove this installation and start again.",
    );
  }
  if (error instanceof BudgetExceededError) {
    logError("budget", { step: stepId, subrequests: deps.budget.used });
    return set("failed", "This step needs more work than one request allows. Try again.");
  }
  const kind = classifyCloudflareError(error);
  logError("step_error", { step: stepId, kind, codes: errorCodes(error) });
  switch (kind) {
    case "auth":
      throw new InstallerError(401, "cloudflare_auth", CONNECT_AGAIN);
    case "transient":
      return set("waiting", "Cloudflare is busy. Trying again shortly.", TRANSIENT_RETRY_MS);
    case "forbidden":
      return set(
        "failed",
        `Cloudflare did not let this sign-in ${STEP_ACTIONS[stepId]}. Connect your Cloudflare account again with every permission Appflare asks for, then continue.`,
      );
    default:
      return set("failed", `Cloudflare could not ${STEP_ACTIONS[stepId]}. Try again.`);
  }
}

/** Each step as the end of "Cloudflare could not …". */
const STEP_ACTIONS: Record<StepId, string> = {
  release: "read Appflare's release",
  database: "create the database",
  storage: "create the key-value storage",
  assets: "store Appflare's files",
  worker: "upload Appflare",
  workflow: "set up Appflare's background jobs",
  schedules: "schedule Appflare's regular checks",
  secret: "store the setup key",
  "workers-dev": "turn on the workers.dev address",
  domain: "connect your domain",
  proof: "reach Appflare's address",
};
