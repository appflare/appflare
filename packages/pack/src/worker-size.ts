import { closeSync, openSync, readSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { MAX_WORKER_MODULES, type WorkerModule } from "@appflare/schema";

/**
 * The size of an artifact's Worker, measured the way wrangler reports it
 * after `wrangler deploy --dry-run` ("Total Upload: <size> / gzip: <size>"):
 * every module's bytes together, and those bytes gzipped as one stream
 * (`getSize` in workers-sdk `packages/deploy-helpers/src/deploy/helpers/
 * bundle-reporter.ts`).
 *
 * Cloudflare limits a Worker to {@link MAX_WORKER_SIZE_BYTES} uncompressed on
 * every plan; there is no compressed limit any more (developers.cloudflare.com
 * /workers/platform/limits, "Worker size", and workers-sdk #14001, which
 * dropped the 3 MiB free and 10 MiB paid compressed limits in September
 * 2026). The gzip size is shown for reference, as wrangler shows it.
 */

/** The largest Worker Cloudflare accepts, uncompressed, on every plan: 64 MiB. */
export const MAX_WORKER_SIZE_BYTES = 64 * 1024 * 1024;

export interface WorkerSize {
  /** Every module's bytes together. */
  size: number;
  /** Those bytes gzipped as one stream. */
  gzipSize: number;
}

/** The size of a Worker made of `modules`. */
export function workerSize(modules: readonly Uint8Array[]): WorkerSize {
  const all = Buffer.concat(modules.map((m) => Buffer.from(m.buffer, m.byteOffset, m.byteLength)));
  return { size: all.length, gzipSize: gzipSync(all).length };
}

/** The size of the Worker in an artifact zip, read from each module's byte range. */
export function artifactWorkerSize(
  zipPath: string,
  modules: readonly Pick<WorkerModule, "offset" | "size">[],
): WorkerSize {
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
    return workerSize(bytes);
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

/**
 * One line on the Worker's size and module count against what installs it:
 * Cloudflare's size limit and the most modules the manager uploads
 * (`MAX_WORKER_MODULES`), each marked when it is over.
 */
export function workerSizeLine(
  size: WorkerSize,
  moduleCount: number,
  maxModules: number = MAX_WORKER_MODULES,
): string {
  const modules = `${moduleCount} ${moduleCount === 1 ? "module" : "modules"} of at most ${maxModules}`;
  const bytes =
    `${formatBytes(size.size)} of at most ${formatBytes(MAX_WORKER_SIZE_BYTES)} ` +
    `(gzip ${formatBytes(size.gzipSize)}, not limited)`;
  const over = [
    ...(moduleCount > maxModules ? ["too many modules"] : []),
    ...(size.size > MAX_WORKER_SIZE_BYTES ? ["too large"] : []),
  ];
  return `${modules}, ${bytes}${over.length > 0 ? `: ${over.join(", ")}` : ""}`;
}

/** Why Cloudflare would refuse a Worker of this size, or null when it would not. */
export function workerTooLargeMessage(size: WorkerSize, subject = "The Worker"): string | null {
  if (size.size <= MAX_WORKER_SIZE_BYTES) return null;
  return (
    `${subject} is ${formatBytes(size.size)} uncompressed; Cloudflare accepts at most ` +
    `${formatBytes(MAX_WORKER_SIZE_BYTES)} on every plan.`
  );
}
