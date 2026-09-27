import { closeSync, openSync, readSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  MAX_WORKER_UPLOAD_BYTES,
  MAX_WORKER_UPLOAD_SUBREQUESTS,
  planSpans,
  rangeReadCost,
  type SpanFile,
} from "@appflare/schema";

/**
 * The size of an artifact's Worker, measured the way wrangler reports it
 * after `wrangler deploy --dry-run` ("Total Upload: <size> / gzip: <size>"):
 * every module's bytes together, and those bytes gzipped as one stream
 * (`getSize` in workers-sdk `packages/deploy-helpers/src/deploy/helpers/
 * bundle-reporter.ts`), plus the Range requests Appflare reads the modules
 * with.
 *
 * What installs the Worker is Appflare's upload budget (`workerUploadProblem`
 * in @appflare/schema): the module bytes one upload holds in memory, and the
 * subrequests it spends reading them. Its byte cap is below the 64 MiB
 * Cloudflare accepts on every plan; there is no compressed limit any more
 * (developers.cloudflare.com/workers/platform/limits, "Worker size", and
 * workers-sdk #14001, which dropped the 3 MiB free and 10 MiB paid
 * compressed limits in September 2026). The gzip size is shown for
 * reference, as wrangler shows it.
 */

export interface WorkerSize {
  /** Every module's bytes together. */
  size: number;
  /** Those bytes gzipped as one stream. */
  gzipSize: number;
  /** Range requests an upload reads the modules with, where they lie in the artifact zip. */
  ranges: number;
}

/** The size of a Worker made of `modules`, which lie in the artifact zip at `layout`. */
export function workerSize(
  modules: readonly Uint8Array[],
  layout: readonly SpanFile[],
): WorkerSize {
  const all = Buffer.concat(modules.map((m) => Buffer.from(m.buffer, m.byteOffset, m.byteLength)));
  return { size: all.length, gzipSize: gzipSync(all).length, ranges: planSpans(layout).length };
}

/** The size of the Worker in an artifact zip, read from each module's byte range. */
export function artifactWorkerSize(zipPath: string, modules: readonly SpanFile[]): WorkerSize {
  const fd = openSync(zipPath, "r");
  try {
    const bytes = modules.map((m) => {
      const buffer = Buffer.alloc(m.size);
      let read = 0;
      while (read < m.size) {
        const n = readSync(fd, buffer, read, m.size - read, m.offset + read);
        if (n === 0) throw new Error(`${zipPath} ends inside a Worker module`);
        read += n;
      }
      return buffer;
    });
    return workerSize(bytes, modules);
  } finally {
    closeSync(fd);
  }
}

/** A byte count in KiB (below 1 MiB) or MiB, two decimals, as wrangler prints sizes. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(2)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * One line on the Worker against Appflare's upload budget: its modules, the
 * Range requests they take, and their size against the byte cap, marked when
 * the upload could not carry it.
 */
export function workerSizeLine(size: WorkerSize, moduleCount: number): string {
  const layout = `${plural(moduleCount, "module")} in ${plural(size.ranges, "range")}`;
  const bytes =
    `${formatBytes(size.size)} of at most ${formatBytes(MAX_WORKER_UPLOAD_BYTES)} ` +
    `(gzip ${formatBytes(size.gzipSize)}, not limited)`;
  const over = [
    ...(size.size > MAX_WORKER_UPLOAD_BYTES ? ["too large to upload"] : []),
    ...(rangeReadCost(size.ranges) > MAX_WORKER_UPLOAD_SUBREQUESTS ? ["too many ranges"] : []),
  ];
  return `${layout}, ${bytes}${over.length > 0 ? `: ${over.join(", ")}` : ""}`;
}
