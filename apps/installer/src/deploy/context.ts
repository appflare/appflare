import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import type { ArtifactManifest } from "@appflare/schema";
import type { Budget } from "../budget";
import type { InstallerConfig } from "../config";
import type { InstallationRow } from "../db/schema";
import type { RecordPatch } from "../records";

/** What one step of one request works with. */
export interface StepContext {
  /** The record as it stands; `save` keeps it current. */
  record: InstallationRow;
  manifest: ArtifactManifest;
  api: CloudflareClient;
  /** The request's budgeted fetch, for GitHub and the new manager. */
  fetch: FetchLike;
  budget: Budget;
  now: number;
  config: InstallerConfig;
  /** Writes `patch` to the record at once (before the next Cloudflare call). */
  save(patch: RecordPatch): Promise<void>;
}

export type StepResult =
  /** The step is complete; the next request runs the next one. */
  | { kind: "done"; message?: string }
  /** The step made progress and continues in the next request. */
  | { kind: "again"; message: string }
  /** Nothing to do but wait (an address going live). */
  | { kind: "wait"; retryAfterMs: number; message: string };

/** A step that cannot continue as things are; the message says what to do. */
export class StepFailure extends Error {
  override name = "StepFailure";
}
