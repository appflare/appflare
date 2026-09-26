import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { wranglerConfigFromTemplate } from "@appflare/schema";

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

/** The declared config is a template the packer cannot copy to its real name. */
export class ConfigTemplateError extends Error {
  override name = "ConfigTemplateError";
}

/**
 * The config to read for the catalog manifest's `install.wranglerConfig`,
 * relative to the checkout. A template (`wrangler.toml.example`,
 * `wrangler.jsonc.template`) is copied beside itself under its real name
 * first, since wrangler reads a config by its extension; relative paths in
 * it (`main`, `assets.directory`, migrations) resolve from the same
 * directory either way. Any other path is returned as it is. A real file
 * already there is kept when it holds the same bytes and refused otherwise,
 * as is one that is a symlink, and a template outside the checkout.
 */
export function copyTemplateConfig(checkoutDir: string, declared: string): string {
  const real = wranglerConfigFromTemplate(declared);
  if (real === null) return declared;
  const root = path.resolve(checkoutDir);
  const from = path.resolve(root, declared);
  const to = path.resolve(root, real);
  if (!existsSync(from) || !statSync(from).isFile()) {
    throw new ConfigTemplateError(`the wrangler config template ${declared} does not exist`);
  }
  if (!isInside(root, from)) {
    throw new ConfigTemplateError(
      `the wrangler config template ${declared} is outside the checkout`,
    );
  }
  const bytes = readFileSync(from);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(to);
  } catch {
    existing = null;
  }
  if (existing !== null) {
    if (!existing.isFile() || !readFileSync(to).equals(bytes)) {
      throw new ConfigTemplateError(
        `${real} already exists beside the template ${declared} and differs from it; ` +
          `set install.wranglerConfig to ${real} to build from it, or remove it`,
      );
    }
    return real;
  }
  writeFileSync(to, bytes, { flag: "wx" });
  return real;
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
