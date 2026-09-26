import path from "node:path";
import { UNSUPPORTED_WRANGLER_SECTIONS, type WranglerFacts } from "@appflare/schema";
import { unstable_readConfig } from "wrangler";
import { copyTemplateConfig, readConfigArgs, resolveWranglerConfig } from "./config-redirect.ts";

/**
 * `appflare-pack inspect`: what a project's wrangler config declares, read
 * with wrangler's own reader (JSON, JSONC and TOML alike, as `wrangler
 * deploy` resolves them), before anything is installed or built. The
 * sandbox Worker runs it on a repository's checkout to offer the config's
 * plain vars as settings and to name the sections the packer would leave
 * out (`containers`, `dispatch_namespaces`, ...), which the manager refuses.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a resolved config section is absent (wrangler fills in empty defaults). */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.values(value).every(isEmpty);
  return false;
}

/** The name, plain vars and unsupported sections of `config` as wrangler resolved it. */
export function wranglerFacts(config: Record<string, unknown>): WranglerFacts {
  const name = typeof config.name === "string" && config.name.length > 0 ? config.name : null;
  const vars = isRecord(config.vars) ? Object.keys(config.vars) : [];
  const unsupported = UNSUPPORTED_WRANGLER_SECTIONS.filter((key) => !isEmpty(config[key]));
  return { name, vars, unsupported };
}

/**
 * Reads the wrangler config `configPath` (relative to `checkoutDir`) the way
 * the packer does, following a redirect a build left, and returns its facts.
 */
export function inspectWranglerConfig(checkoutDir: string, configPath: string): WranglerFacts {
  const root = path.resolve(checkoutDir);
  // A template (`wrangler.toml.example`) is read under its real name, as the pack reads it.
  const target = resolveWranglerConfig(root, copyTemplateConfig(root, configPath));
  const read = readConfigArgs(target);
  const config = unstable_readConfig(read.args, read.options) as unknown;
  if (!isRecord(config)) throw new Error("wrangler did not return a config");
  return wranglerFacts(config);
}
