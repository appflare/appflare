import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where a build leaves a redirect to the wrangler config it generated,
 * relative to the directory of the user's wrangler config. The Cloudflare
 * Vite plugin writes `{ "configPath": "<path relative to this file's
 * directory>" }` there after `vite build`, and `wrangler deploy` without
 * `--config` deploys the config it points at (wrangler 4.136.2,
 * `findRedirectedWranglerConfig` in `@cloudflare/workers-utils`, where it is
 * `PATH_TO_DEPLOY_CONFIG`).
 */
export const DEPLOY_CONFIG_PATH = ".wrangler/deploy/config.json";

/** Which wrangler config the packer builds from. */
export interface WranglerConfigTarget {
  /** Absolute path of the catalog manifest's `install.wranglerConfig`. */
  declaredPath: string;
  /** Absolute path of the config wrangler deploys; `declaredPath` without a redirect. */
  effectivePath: string;
  /** Absolute path of the redirect file, or null when there is none. */
  deployConfigPath: string | null;
}

/** The build left a redirect the packer cannot follow. */
export class ConfigRedirectError extends Error {
  override name = "ConfigRedirectError";
}

/** `abs` relative to `root` with `/` separators. */
export function checkoutRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * Whether the existing file `abs` lies inside `root` once every symlink on
 * either path is resolved, so a link in the checkout cannot lead out of it.
 */
function isInside(root: string, abs: string): boolean {
  const rel = path.relative(realpathSync(root), realpathSync(abs));
  return (
    rel.length > 0 && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
}

/**
 * Resolves the wrangler config to build from, after the install and build
 * steps. When `.wrangler/deploy/config.json` sits beside the declared config,
 * its `configPath` (relative to the redirect file's directory, as wrangler
 * reads it) names the effective config. Only that location counts: wrangler
 * refuses a redirect that does not share the user config's directory, and the
 * packer never looks outside the checkout. A redirect that is not JSON, has no
 * `configPath`, or points at a missing file or outside the checkout throws
 * {@link ConfigRedirectError}, as wrangler would refuse it too.
 */
export function resolveWranglerConfig(checkoutDir: string, declared: string): WranglerConfigTarget {
  const root = path.resolve(checkoutDir);
  const declaredPath = path.resolve(root, declared);
  const deployConfigPath = path.join(path.dirname(declaredPath), DEPLOY_CONFIG_PATH);
  if (!existsSync(deployConfigPath) || !statSync(deployConfigPath).isFile()) {
    return { declaredPath, effectivePath: declaredPath, deployConfigPath: null };
  }
  const shown = checkoutRelative(root, deployConfigPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(deployConfigPath, "utf8"));
  } catch (error) {
    throw new ConfigRedirectError(
      `the build left ${shown}, but it is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const target =
    typeof parsed === "object" && parsed !== null && "configPath" in parsed
      ? parsed.configPath
      : undefined;
  if (typeof target !== "string" || target.length === 0) {
    throw new ConfigRedirectError(
      `the build left ${shown}, but it has no "configPath" naming the wrangler config to deploy`,
    );
  }
  const effectivePath = path.resolve(path.dirname(deployConfigPath), target);
  if (!existsSync(effectivePath) || !statSync(effectivePath).isFile()) {
    throw new ConfigRedirectError(
      `${shown} points at ${checkoutRelative(root, effectivePath)}, which does not exist`,
    );
  }
  // Checked on the real path of an existing file, so symlinks cannot escape.
  if (!isInside(root, effectivePath)) {
    throw new ConfigRedirectError(`${shown} points at ${target}, which is outside the checkout`);
  }
  return { declaredPath, effectivePath, deployConfigPath };
}

/**
 * How to run wrangler against `target`: with `--config` for the declared
 * config, or, when the build left a redirect, from the declared config's
 * directory without `--config`, which is the only way wrangler reads a
 * redirected config as one. Passing the generated config to `--config`
 * makes wrangler treat it as a hand-written config and refuse the fields
 * build tools write into it (`legacy_env`, for one).
 */
export function dryRunInvocation(
  target: WranglerConfigTarget,
  checkoutDir: string,
): { cwd: string; configArgs: string[] } {
  if (target.deployConfigPath === null) {
    return { cwd: checkoutDir, configArgs: ["--config", target.declaredPath] };
  }
  return { cwd: path.dirname(target.declaredPath), configArgs: [] };
}

/**
 * Arguments for wrangler's `unstable_readConfig` that resolve `target` the way
 * `wrangler deploy` does. For a redirect, wrangler's reader has no working
 * directory argument: it searches from the directory of `script` instead, and
 * uses `script` for nothing else than detecting a Python entry, so the
 * declared config's own path stands in for it.
 */
export function readConfigArgs(target: WranglerConfigTarget): {
  args: { config?: string; script?: string };
  options: { useRedirectIfAvailable?: boolean };
} {
  if (target.deployConfigPath === null) {
    return { args: { config: target.declaredPath }, options: {} };
  }
  return { args: { script: target.declaredPath }, options: { useRedirectIfAvailable: true } };
}
