import path from "node:path";
import { type CatalogManifest, catalogWorkerName, type WranglerFacts } from "@appflare/schema";
import { unstable_readConfig } from "wrangler";
import { applyConfigPatches, workerSpecs, writeInlineConfigs } from "./config-patch.ts";
import { copyTemplateConfig, readConfigArgs, resolveWranglerConfig } from "./config-redirect.ts";
import { unsupportedWranglerSections } from "./wrangler-config.ts";

/**
 * `appflare-pack inspect`: what a project's wrangler config declares, read
 * with wrangler's own reader (JSON, JSONC and TOML alike, as `wrangler
 * deploy` resolves them), before anything is installed or built. The
 * sandbox Worker runs it on a repository's checkout to offer the config's
 * plain vars as settings, to ask for the secrets it requires
 * (`secrets.required`), and to name the sections the packer would leave out
 * (`containers`, `dispatch_namespaces`, ...), which the manager refuses.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The name, plain vars, required secrets and unsupported sections of
 * `config` as wrangler resolved it. (wrangler's reader refuses a var of a
 * required secret's name, so the two never share one.)
 */
export function wranglerFacts(config: Record<string, unknown>): WranglerFacts {
  const name = typeof config.name === "string" && config.name.length > 0 ? config.name : null;
  const required =
    isRecord(config.secrets) && Array.isArray(config.secrets.required)
      ? config.secrets.required.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
  const secrets = [...new Set(required)];
  const vars = isRecord(config.vars) ? Object.keys(config.vars) : [];
  const unsupported = unsupportedWranglerSections(config);
  return { name, vars, unsupported, secrets };
}

/** Options for {@link inspectWranglerConfig}. */
export interface InspectOptions {
  /**
   * The catalog manifest of the entry that builds `configPath`: its config
   * patch for that config is applied first, as the pack applies it, and the
   * facts are the patched config's.
   */
  catalog?: CatalogManifest | undefined;
  /** Gets the patched config's path and the patch's effect. */
  logger?: ((message: string) => void) | undefined;
}

/**
 * Reads the wrangler config `configPath` (relative to `checkoutDir`) the way
 * the packer does, following a redirect a build left, and returns its facts.
 * With `catalog`, the entry's inline config for `configPath` is written, or
 * its config patch applied, first, and the config it leaves
 * (`.appflare.wrangler.jsonc`) is read.
 */
export function inspectWranglerConfig(
  checkoutDir: string,
  configPath: string,
  options: InspectOptions = {},
): WranglerFacts {
  const root = path.resolve(checkoutDir);
  let patched: ReturnType<typeof applyConfigPatches> = new Map();
  if (options.catalog !== undefined) {
    const specs = workerSpecs(options.catalog.install);
    if (!specs.some((s) => s.wranglerConfig === configPath)) {
      throw new Error(
        `the catalog manifest builds no Worker from ${configPath}; name the config as its install.wranglerConfig (or install.workers[].wranglerConfig) does`,
      );
    }
    // An inline config is written first, as the pack writes it before the build.
    writeInlineConfigs({
      checkoutDir: root,
      specs,
      workerName: catalogWorkerName(options.catalog),
      only: configPath,
      logger: options.logger,
    });
    patched = applyConfigPatches({
      checkoutDir: root,
      specs,
      only: configPath,
      logger: options.logger,
    });
  }
  // A template (`wrangler.toml.example`) is read under its real name, as the pack reads it.
  const target =
    patched.get(configPath) ?? resolveWranglerConfig(root, copyTemplateConfig(root, configPath));
  const read = readConfigArgs(target);
  const config = unstable_readConfig(read.args, read.options) as unknown;
  if (!isRecord(config)) throw new Error("wrangler did not return a config");
  return wranglerFacts(config);
}
