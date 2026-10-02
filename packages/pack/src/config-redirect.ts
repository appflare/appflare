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
  /**
   * Absolute path of the catalog manifest's `install.wranglerConfig` (or the
   * Worker's): the app's own config, which relative paths such as a D1
   * binding's `migrations_dir` are read against.
   */
  declaredPath: string;
  /** Absolute path of the config wrangler deploys; `declaredPath` without a redirect. */
  effectivePath: string;
  /**
   * Absolute path of the redirect file wrangler follows to `effectivePath`
   * (run from the declared config's directory without `--config`), or null
   * when wrangler reads `effectivePath` with `--config`.
   */
  deployConfigPath: string | null;
  /**
   * Set when `effectivePath` is a config the build generated for an
   * auxiliary Worker: the redirect lists it in `auxiliaryWorkers`, which
   * wrangler never follows, so it can only be read with `--config`, and
   * only once the fields wrangler takes from a redirected config alone are
   * gone (`readableWranglerConfig` in config-patch.ts). The redirect file it
   * was found through.
   */
  auxiliaryOf?: string;
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
export function isInside(root: string, abs: string): boolean {
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
  const effectivePath = generatedConfigPath(root, deployConfigPath, target);
  // A build of several Workers (the Cloudflare Vite plugin's
  // `auxiliaryWorkers`) generates a config for each, and its redirect points
  // at the entry Worker's alone. Each generated config records the config it
  // was generated from (`userConfigPath`), so a declared config the redirect
  // does not point at is found among the others.
  const source = generatedFrom(effectivePath);
  if (source === null || samePath(source, declaredPath)) {
    return { declaredPath, effectivePath, deployConfigPath };
  }
  const listed =
    typeof parsed === "object" && parsed !== null && "auxiliaryWorkers" in parsed
      ? parsed.auxiliaryWorkers
      : undefined;
  for (const entry of Array.isArray(listed) ? listed : []) {
    const configPath =
      typeof entry === "object" && entry !== null && "configPath" in entry
        ? entry.configPath
        : undefined;
    if (typeof configPath !== "string" || configPath.length === 0) continue;
    const auxiliary = generatedConfigPath(root, deployConfigPath, configPath);
    const from = generatedFrom(auxiliary);
    if (from !== null && samePath(from, declaredPath)) {
      return {
        declaredPath,
        effectivePath: auxiliary,
        deployConfigPath: null,
        auxiliaryOf: deployConfigPath,
      };
    }
  }
  throw new ConfigRedirectError(
    `the build left ${shown}, which deploys ${checkoutRelative(root, effectivePath)}, generated from ` +
      `${checkoutRelative(root, path.resolve(root, source))}; none of the configs it generated was generated ` +
      `from ${checkoutRelative(root, declaredPath)} (its "auxiliaryWorkers" list no such Worker), so the ` +
      "build did not build this Worker",
  );
}

/**
 * The absolute path of a config a redirect at `deployConfigPath` names as
 * `configPath`, checked to exist inside the checkout; throws
 * {@link ConfigRedirectError} otherwise, as wrangler would refuse it too.
 */
function generatedConfigPath(root: string, deployConfigPath: string, configPath: string): string {
  const shown = checkoutRelative(root, deployConfigPath);
  const resolved = path.resolve(path.dirname(deployConfigPath), configPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new ConfigRedirectError(
      `${shown} points at ${checkoutRelative(root, resolved)}, which does not exist`,
    );
  }
  // Checked on the real path of an existing file, so symlinks cannot escape.
  if (!isInside(root, resolved)) {
    throw new ConfigRedirectError(
      `${shown} points at ${configPath}, which is outside the checkout`,
    );
  }
  return resolved;
}

/**
 * The config a build generated `absPath` from, as the generated config
 * records it (`userConfigPath`, which the Cloudflare Vite plugin writes with
 * `configPath`), or null when `absPath` does not say or names itself: a
 * config written by hand, or by a tool that records nothing. Wrangler
 * 4.136.2 calls a config redirected when the two differ
 * (`isRedirectedConfig`).
 */
export function generatedFrom(absPath: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    // Not JSON (a TOML or JSONC config): written by hand, not generated.
    return null;
  }
  const source =
    typeof raw === "object" && raw !== null && "userConfigPath" in raw
      ? raw.userConfigPath
      : undefined;
  if (typeof source !== "string" || source.length === 0) return null;
  const resolved = path.resolve(path.dirname(absPath), source);
  return samePath(resolved, absPath) ? null : resolved;
}

/** Whether two paths name one file, through symlinks when both exist. */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  try {
    return realpathSync(ra) === realpathSync(rb);
  } catch {
    return false;
  }
}

/**
 * How to run wrangler against `target`: with `--config` for the config it
 * names (the declared config, or the config the packer wrote in its place),
 * or, when the build left a redirect, from the declared config's directory
 * without `--config`, which is the only way wrangler reads a redirected
 * config as one. Passing a generated config to `--config` makes wrangler
 * treat it as a hand-written config and refuse the fields build tools write
 * into it (`legacy_env`, for one); `readableWranglerConfig` in
 * config-patch.ts writes a copy without them for a generated config that
 * no redirect leads to.
 */
export function dryRunInvocation(
  target: WranglerConfigTarget,
  checkoutDir: string,
): { cwd: string; configArgs: string[] } {
  if (target.deployConfigPath === null) {
    return { cwd: checkoutDir, configArgs: ["--config", target.effectivePath] };
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
    return { args: { config: target.effectivePath }, options: {} };
  }
  return { args: { script: target.declaredPath }, options: { useRedirectIfAvailable: true } };
}
