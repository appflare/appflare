import { execFileSync } from "node:child_process";

export interface Host {
  platform: NodeJS.Platform;
  arch: string;
  /** The kernel's memory page size in bytes, or undefined when unknown. */
  pageSize(): number | undefined;
}

const currentHost: Host = {
  platform: process.platform,
  arch: process.arch,
  pageSize() {
    try {
      const size = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim());
      return Number.isInteger(size) && size > 0 ? size : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Whether Pagefind, which builds the site's search index, can run here.
 * Its Linux arm64 binary uses jemalloc built for 4 KiB memory pages and aborts
 * ("Unsupported system page size") on kernels with larger pages, such as
 * Asahi Linux's 16 KiB. Everywhere else it runs.
 */
export function canIndexSearch(host: Host = currentHost): boolean {
  if (host.platform !== "linux" || host.arch !== "arm64") return true;
  const size = host.pageSize();
  return size === undefined || size <= 4096;
}
