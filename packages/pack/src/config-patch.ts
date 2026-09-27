import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CatalogInstall,
  type ConfigPatch,
  inlineWranglerConfig,
  PATCHED_WRANGLER_CONFIG,
  patchWranglerConfig,
  WRANGLER_CONFIG_TEMPLATE_SUFFIXES,
  type WranglerConfigInline,
} from "@appflare/schema";
import { experimental_readRawConfig } from "wrangler";
import {
  checkoutRelative,
  copyTemplateConfig,
  isInside,
  resolveWranglerConfig,
  type WranglerConfigTarget,
} from "./config-redirect.ts";

/**
 * The catalog manifest's config patches, applied to the app's wrangler
 * configs after the build and before wrangler reads them. Each patched config
 * is written beside its original as `.appflare.wrangler.jsonc`, so every
 * relative path in it (`main`, `assets.directory`, migrations) resolves from
 * the same directory, and wrangler reads and bundles that file instead. A TOML
 * config is parsed with wrangler's own parser and written as JSONC.
 *
 * An entry whose repository ships no config carries one inline instead
 * (`install.wranglerConfigInline`, or a Worker's), which the packer writes
 * under the same name where the entry's `wranglerConfig` says, before the
 * install and the build, and reads like any other config.
 */

/** A config patch the packer refuses, or cannot apply where the build left the config. */
export class ConfigPatchError extends Error {
  override name = "ConfigPatchError";
}

/** One Worker of a catalog entry, as the packer builds it. */
export interface WorkerSpec {
  /** Its name within the entry; null for an app of one Worker. */
  name: string | null;
  /** Its wrangler config, relative to the checkout, as the catalog manifest names it. */
  wranglerConfig: string;
  primary: boolean;
  configPatch?: ConfigPatch | undefined;
  /** The config the packer writes at `wranglerConfig`, for a repository that ships none. */
  wranglerConfigInline?: WranglerConfigInline | undefined;
}

/** The Workers an entry builds: `install.workers`, or the one Worker of `install.wranglerConfig`. */
export function workerSpecs(
  install: Pick<
    CatalogInstall,
    "wranglerConfig" | "workers" | "configPatch" | "wranglerConfigInline"
  >,
): WorkerSpec[] {
  if (install.workers === undefined) {
    return [
      {
        name: null,
        wranglerConfig: install.wranglerConfig,
        primary: true,
        configPatch: install.configPatch,
        wranglerConfigInline: install.wranglerConfigInline,
      },
    ];
  }
  return install.workers.map((w) => ({
    name: w.name,
    wranglerConfig: w.wranglerConfig,
    primary: w.primary === true,
    configPatch: w.configPatch,
    wranglerConfigInline: w.wranglerConfigInline,
  }));
}

// wrangler re-exports this from `@cloudflare/workers-utils`, which it bundles
// without shipping its types, so the import has no type of its own. The
// shape used here is the one wrangler 4.136.2 returns (`rawConfig` is the
// parsed file: TOML, JSON or JSONC by extension).
const readRawConfig = experimental_readRawConfig as (args: { config: string }) => {
  rawConfig: unknown;
};

/**
 * The top level of the wrangler config at `absPath` as the file holds it,
 * before wrangler fills in defaults or validates it, parsed by wrangler's own
 * TOML or JSONC parser. Passed through JSON so a TOML date becomes the string
 * JSON carries it as.
 */
export function readRawWranglerConfig(absPath: string): Record<string, unknown> {
  const { rawConfig } = readRawConfig({ config: absPath });
  const json: unknown = JSON.parse(JSON.stringify(rawConfig ?? {}));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ConfigPatchError(`${absPath} does not hold a wrangler config object`);
  }
  return json as Record<string, unknown>;
}

/** Where a patch is refused: `install.configPatch`, or the named Worker's. */
function patchLabel(spec: WorkerSpec): string {
  return spec.name === null
    ? "install.configPatch"
    : `the configPatch of the Worker "${spec.name}"`;
}

/**
 * Writes `config` as JSONC to `file` under a one-line `header` comment,
 * replacing a file the packer wrote before; returns whether the bytes
 * changed.
 */
function writeConfigFile(
  checkoutDir: string,
  file: string,
  config: Record<string, unknown>,
  header: string,
): boolean {
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(file);
  } catch {
    existing = null;
  }
  if (existing !== null && !existing.isFile()) {
    // A link would make the write land wherever it points.
    throw new ConfigPatchError(
      `${checkoutRelative(checkoutDir, file)} exists and is not a regular file; the packer writes the wrangler config there`,
    );
  }
  const text = `// ${header}\n${JSON.stringify(config, null, 2)}\n`;
  if (existing !== null && readFileSync(file, "utf8") === text) return false;
  writeFileSync(file, text);
  return true;
}

/** Options for {@link applyConfigPatches}. */
export interface ApplyConfigPatchesOptions {
  checkoutDir: string;
  /** Every Worker of the entry; only those with a `configPatch` are patched. */
  specs: readonly WorkerSpec[];
  /** Patch only the Worker built from this config (as the catalog manifest names it). */
  only?: string | undefined;
  logger?: ((message: string) => void) | undefined;
}

/**
 * Applies each Worker's config patch and returns, by the catalog manifest's
 * `wranglerConfig`, the config wrangler must read and bundle instead. A patch
 * is refused when it changes what it may not (see `configPatchProblems` in
 * `@appflare/schema`), when the build redirected wrangler to a config it
 * generated (a patch changes the repository's config, which that build has
 * already read), and when the config lies outside the checkout. The pack log
 * gets each patched path and its effect.
 */
export function applyConfigPatches(
  options: ApplyConfigPatchesOptions,
): Map<string, WranglerConfigTarget> {
  const root = path.resolve(options.checkoutDir);
  const logger = options.logger ?? (() => {});
  const patched = new Map<string, WranglerConfigTarget>();
  const targets = options.specs
    .filter((s) => s.configPatch !== undefined)
    .filter((s) => options.only === undefined || s.wranglerConfig === options.only);
  if (targets.length === 0) return patched;

  // A patch may add service bindings only to the entry's own Workers, by the
  // names their configs give them. Read only when a patch lists services.
  let entryWorkers: Set<string> | null = null;
  const entryWorkerNames = (): Set<string> => {
    if (entryWorkers !== null) return entryWorkers;
    entryWorkers = new Set<string>();
    for (const spec of options.specs) {
      const target = resolveWranglerConfig(root, copyTemplateConfig(root, spec.wranglerConfig));
      const name = readRawWranglerConfig(target.effectivePath).name;
      if (typeof name === "string" && name.length > 0) entryWorkers.add(name);
    }
    return entryWorkers;
  };

  for (const spec of targets) {
    const patch = spec.configPatch;
    if (patch === undefined) continue;
    const label = patchLabel(spec);
    const target = resolveWranglerConfig(root, copyTemplateConfig(root, spec.wranglerConfig));
    const shown = checkoutRelative(root, target.effectivePath);
    if (target.deployConfigPath !== null) {
      throw new ConfigPatchError(
        `${label} cannot be applied: the build redirects wrangler from ${spec.wranglerConfig} to ` +
          `${shown}, a config it generated from the one the patch would change; change the ` +
          "build's own configuration instead",
      );
    }
    if (!isInside(root, target.effectivePath)) {
      throw new ConfigPatchError(`${label} cannot be applied: ${shown} is outside the checkout`);
    }
    const raw = readRawWranglerConfig(target.effectivePath);
    let result: ReturnType<typeof patchWranglerConfig>;
    try {
      result = patchWranglerConfig(
        raw,
        patch,
        patch.services ? entryWorkerNames() : new Set<string>(),
      );
    } catch (error) {
      throw new ConfigPatchError(
        `${label} for ${shown}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const file = path.join(path.dirname(target.effectivePath), PATCHED_WRANGLER_CONFIG);
    writeConfigFile(
      root,
      file,
      result.config,
      `Written by appflare-pack: ${shown} with the catalog manifest's config patch applied.`,
    );
    const written = checkoutRelative(root, file);
    if (result.diff.length === 0) {
      logger(
        `${label} changes nothing in ${shown} (upstream may have taken it); building from ${written} anyway`,
      );
    } else {
      logger(`${label} applied to ${shown}, building from ${written}:`);
      for (const line of result.diff) logger(`  ${line}`);
    }
    patched.set(spec.wranglerConfig, {
      declaredPath: file,
      effectivePath: file,
      deployConfigPath: null,
    });
  }
  return patched;
}

/** The wrangler config names wrangler looks for in a directory, templates included. */
function repositoryConfigNames(): string[] {
  const names = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];
  return [
    ...names,
    ...names.flatMap((name) => WRANGLER_CONFIG_TEMPLATE_SUFFIXES.map((suffix) => name + suffix)),
  ];
}

/** Where an inline config is refused: `install.wranglerConfigInline`, or the named Worker's. */
function inlineLabel(spec: WorkerSpec): string {
  return spec.name === null
    ? "install.wranglerConfigInline"
    : `the wranglerConfigInline of the Worker "${spec.name}"`;
}

/**
 * The name the packer gives the Worker of an inline config: the install's
 * Worker name for the primary, `<Worker name>-<name>` for another Worker of
 * the entry, as the manager installs them. A service binding between the
 * entry's Workers names the other Worker so.
 */
export function inlineConfigWorkerName(spec: WorkerSpec, workerName: string): string {
  return spec.primary || spec.name === null ? workerName : `${workerName}-${spec.name}`;
}

/** Options for {@link writeInlineConfigs}. */
export interface WriteInlineConfigsOptions {
  checkoutDir: string;
  /** Every Worker of the entry; only those with a `wranglerConfigInline` are written. */
  specs: readonly WorkerSpec[];
  /** The catalog manifest's `install.workerName`. */
  workerName: string;
  /** Write only the config of this Worker (as the catalog manifest names it). */
  only?: string | undefined;
  logger?: ((message: string) => void) | undefined;
}

/**
 * Writes each Worker's inline wrangler config where the catalog manifest's
 * `wranglerConfig` names (`.appflare.wrangler.jsonc` in a directory of the
 * checkout; the schema checks the name), with the Worker's `name` added, and
 * returns the configs written, by that path. Run before the install and the
 * build, and again after the build, so a build that leaves a wrangler config
 * or a redirect is refused either way.
 *
 * Refused when the directory does not exist or lies outside the checkout,
 * when the repository has a config of its own there (`wrangler.json`,
 * `wrangler.jsonc`, `wrangler.toml`, or a template of one: change that with
 * a config patch instead), and when a build redirect
 * (`.wrangler/deploy/config.json`) sits there, which would make wrangler
 * deploy a config the build generated instead.
 */
export function writeInlineConfigs(options: WriteInlineConfigsOptions): string[] {
  const root = path.resolve(options.checkoutDir);
  const logger = options.logger ?? (() => {});
  const written: string[] = [];
  const targets = options.specs
    .filter((s) => s.wranglerConfigInline !== undefined)
    .filter((s) => options.only === undefined || s.wranglerConfig === options.only);
  for (const spec of targets) {
    const inline = spec.wranglerConfigInline;
    if (inline === undefined) continue;
    const label = inlineLabel(spec);
    const file = path.resolve(root, spec.wranglerConfig);
    const dir = path.dirname(file);
    const shownDir = checkoutRelative(root, dir) || ".";
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new ConfigPatchError(
        `${label} cannot be written: the directory ${shownDir} does not exist in the checkout`,
      );
    }
    if (dir !== root && !isInside(root, dir)) {
      throw new ConfigPatchError(`${label} cannot be written: ${shownDir} is outside the checkout`);
    }
    const own = repositoryConfigNames().filter((name) => existsSync(path.join(dir, name)));
    if (own.length > 0) {
      throw new ConfigPatchError(
        `${label} cannot be written: the repository has a wrangler config of its own in ` +
          `${shownDir} (${own.join(", ")}); set install.wranglerConfig to it and change it with a ` +
          "config patch instead",
      );
    }
    const redirect = resolveWranglerConfig(root, spec.wranglerConfig);
    if (redirect.deployConfigPath !== null) {
      throw new ConfigPatchError(
        `${label} cannot be written: ${checkoutRelative(root, redirect.deployConfigPath)} ` +
          "redirects wrangler to a config the build generated, which it would deploy instead",
      );
    }
    const config = inlineWranglerConfig(inline, inlineConfigWorkerName(spec, options.workerName));
    const shown = checkoutRelative(root, file);
    const changed = writeConfigFile(
      root,
      file,
      config,
      "Written by appflare-pack from the catalog manifest's inline wrangler config.",
    );
    if (changed) logger(`${label} written to ${shown}`);
    written.push(spec.wranglerConfig);
  }
  return written;
}
