import type { AssetFile } from "@appflare/schema";
import { byOffset, SpanBuilder } from "./artifact";
import { ARTIFACT_FETCH_COST } from "./budget";

/**
 * How the asset upload splits the files Cloudflare asks for into Workflow
 * steps. Each step reads its files with as few Range requests as the zip
 * layout allows (see `artifactReader`) and uploads them, and must stay within
 * the subrequest budget however Cloudflare grouped the files into buckets.
 *
 * Cloudflare's buckets are a grouping, not a unit the upload service
 * requires: the completion token comes back once every file of the session's
 * manifest is stored, and wrangler itself uploads each file of a bucket on
 * its own when the session asks for single-file uploads. So a bucket that
 * does not fit one step is uploaded in several requests, one per step.
 */

/**
 * Subrequests one asset step may make itself. The step runner adds its D1
 * writes (up to 3) to the estimate, so a step stays within 40, leaving room
 * under the free plan's 50 for what an invocation does outside steps.
 */
export const ASSET_STEP_SUBREQUESTS = 36;

/**
 * Bytes one asset step downloads at most, gaps included. A step holds the
 * bytes, their base64 copy, and the upload body at once; 16 MiB keeps that
 * well inside a Worker's 128 MB. One larger file still gets a step of its own.
 */
export const ASSET_STEP_BYTES = 16 * 1024 * 1024;

export interface AssetPartLimits {
  subrequests: number;
  bytes: number;
}

export interface AssetPart {
  /** The part's files, in zip order. */
  files: AssetFile[];
  /** Range requests the part's files need. */
  ranges: number;
  /** Bytes those ranges download. */
  bytes: number;
  /** Worst-case subrequests of the step, besides its D1 writes. */
  subrequests: number;
}

/**
 * Worst-case subrequests of a step that reads `ranges` ranges and uploads
 * `files` files: the first range may be redirected (a release asset is), the
 * rest go to the resolved URL; then one bulk upload, or one upload per file
 * when the session asks for single-file uploads.
 */
export function assetStepCost(ranges: number, files: number, single: boolean): number {
  const fetches = ranges === 0 ? 0 : ARTIFACT_FETCH_COST + ranges - 1;
  return fetches + (single ? files : 1);
}

/**
 * Splits one bucket's files into steps: files in zip order, a new step
 * whenever the next file would take the current one past the subrequest or
 * byte limit.
 */
export function planAssetParts(
  files: readonly AssetFile[],
  single: boolean,
  limits: AssetPartLimits = { subrequests: ASSET_STEP_SUBREQUESTS, bytes: ASSET_STEP_BYTES },
): AssetPart[] {
  const parts: AssetPart[] = [];
  let spans = new SpanBuilder<AssetFile>();
  let current: AssetFile[] = [];
  const close = () => {
    if (current.length === 0) return;
    parts.push({
      files: current,
      ranges: spans.spans.length,
      bytes: spans.bytes,
      subrequests: assetStepCost(spans.spans.length, current.length, single),
    });
    spans = new SpanBuilder<AssetFile>();
    current = [];
  };
  for (const file of byOffset(files)) {
    const { newSpan, addedBytes } = spans.preview(file);
    const cost = assetStepCost(spans.spans.length + (newSpan ? 1 : 0), current.length + 1, single);
    if (
      current.length > 0 &&
      (cost > limits.subrequests || spans.bytes + addedBytes > limits.bytes)
    ) {
      close();
    }
    spans.add(file);
    current.push(file);
  }
  close();
  return parts;
}
