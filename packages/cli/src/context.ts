import type { SigningKey } from "@appflare/schema";
import type { FetchLike } from "./release.ts";
import type { CliTelemetry } from "./telemetry.ts";
import type { Ui } from "./ui.ts";
import { createWrangler, type Spawner, type Wrangler } from "./wrangler.ts";

/** Everything the installer touches outside its own logic; tests replace each piece. */
export interface CommandContext {
  ui: Ui;
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  /** Spawns wrangler; node:child_process by default. */
  spawner?: Spawner;
  /** wrangler's bin script; resolved from the CLI's node_modules by default. */
  wranglerBin?: string;
  /** Parent of the private temp directory; the OS temp dir by default. */
  tmpRoot?: string;
  /** Trusted signing keys; @appflare/schema's `signingKeys` by default. */
  keys?: readonly SigningKey[];
  /** The running Node.js version; `process.versions.node` by default. */
  nodeVersion?: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long `create-appflare` waits for the new manager to answer; 90 s by default. */
  healthTimeoutMs?: number;
  /**
   * This run's anonymous usage data (`main` sets it). Without it nothing is
   * recorded, and the manager is deployed without a usage-data variable.
   */
  telemetry?: CliTelemetry;
}

/** The context's wrangler, bound to a private working directory. */
export function wranglerFor(ctx: CommandContext, cwd: string, configPath: string): Wrangler {
  return createWrangler({
    cwd,
    configPath,
    env: ctx.env,
    spawner: ctx.spawner,
    bin: ctx.wranglerBin,
  });
}
