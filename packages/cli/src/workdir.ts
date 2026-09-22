import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A private temp directory with a neutral wrangler config, removed when done. */
export interface Workdir {
  dir: string;
  /** An empty `wrangler.json` passed as `--config` to commands that need no project. */
  neutralConfig: string;
}

/**
 * Runs `fn` in a fresh temp directory under the OS temp dir and removes it
 * afterwards, on success, on error, and on Ctrl-C. Nothing is ever written
 * to the current directory.
 */
export async function withWorkdir<T>(
  fn: (workdir: Workdir) => Promise<T>,
  root: string = tmpdir(),
): Promise<T> {
  const dir = mkdtempSync(path.join(root, "appflare-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = (signal: NodeJS.Signals) => {
    remove();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const neutralConfig = path.join(dir, "wrangler.json");
    writeFileSync(neutralConfig, "{}\n");
    return await fn({ dir, neutralConfig });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    remove();
  }
}
