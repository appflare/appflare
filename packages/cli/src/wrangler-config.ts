import type { ArtifactManifest, ModuleType, WorkerBinding } from "@appflare/schema";
import { UNPACKED_ASSETS_DIR, UNPACKED_WORKER_DIR } from "./artifact.ts";

/**
 * The `wrangler.json` the CLI deploys the manager with,
 * generated from the artifact manifest. It sits next to the unpacked `worker/`
 * and `assets/` directories in the temp dir. D1 and KV bindings carry no ids,
 * so `wrangler deploy` provisions them, and there is never
 * an `account_id`: the account comes from `CLOUDFLARE_ACCOUNT_ID`.
 */
export interface GeneratedWranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  no_bundle: true;
  find_additional_modules: true;
  base_dir: string;
  rules: { type: WranglerRuleType; globs: string[] }[];
  workers_dev: true;
  preview_urls: true;
  keep_vars: true;
  send_metrics: false;
  assets?: Record<string, unknown> & { directory: string; binding?: string };
  d1_databases?: { binding: string; database_name: string }[];
  kv_namespaces?: { binding: string }[];
  workflows?: { binding: string; name: string; class_name: string; script_name?: string }[];
  vars?: Record<string, unknown>;
  triggers: { crons: string[] };
  observability?: Record<string, unknown>;
  migrations?: Record<string, unknown>[];
  placement?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

type WranglerRuleType =
  | "ESModule"
  | "CommonJS"
  | "Text"
  | "Data"
  | "CompiledWasm"
  | "PythonModule"
  | "PythonRequirement";

/** Artifact module type -> wrangler module rule type. */
const RULE_TYPES: Record<ModuleType, WranglerRuleType> = {
  esm: "ESModule",
  commonjs: "CommonJS",
  text: "Text",
  data: "Data",
  "compiled-wasm": "CompiledWasm",
  python: "PythonModule",
  "python-requirement": "PythonRequirement",
};

/**
 * The Workflow name for an install named `name`. Workflow names are unique per
 * account and a deploy that reuses one takes it over from its current Worker,
 * so an install under a non-default name gets its own: the manifest's
 * `appflare-jobs` becomes `<name>-jobs`.
 */
export function workflowNameFor(
  workflowName: string,
  manifestWorkerName: string,
  name: string,
): string {
  if (name === manifestWorkerName) {
    return workflowName;
  }
  const prefix = `${manifestWorkerName}-`;
  return `${name}-${workflowName.startsWith(prefix) ? workflowName.slice(prefix.length) : workflowName}`;
}

function stringField(binding: WorkerBinding, field: string): string {
  const value = binding[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`binding ${binding.name} (${binding.type}) has no ${field}`);
  }
  return value;
}

/**
 * Builds the deploy config for the manager artifact installed as `name`.
 * Throws on a binding type the CLI cannot provision (an artifact newer than
 * this CLI), rather than deploying a manager with a binding missing.
 */
export function buildWranglerConfig(
  manifest: ArtifactManifest,
  options: { name: string },
): GeneratedWranglerConfig {
  const { worker } = manifest;
  const { name } = options;

  const rulesByType = new Map<WranglerRuleType, string[]>();
  for (const module of worker.modules) {
    const type = RULE_TYPES[module.type];
    rulesByType.set(type, [...(rulesByType.get(type) ?? []), module.name]);
  }

  const d1: { binding: string; database_name: string }[] = [];
  const kv: { binding: string }[] = [];
  const workflows: NonNullable<GeneratedWranglerConfig["workflows"]> = [];
  const vars: Record<string, unknown> = {};
  for (const binding of worker.bindings) {
    switch (binding.type) {
      case "d1":
        d1.push({ binding: binding.name, database_name: name });
        break;
      case "kv_namespace":
        kv.push({ binding: binding.name });
        break;
      case "workflow": {
        const scriptName = binding.script_name;
        workflows.push({
          binding: binding.name,
          name: workflowNameFor(stringField(binding, "workflow_name"), worker.name, name),
          class_name: stringField(binding, "class_name"),
          ...(typeof scriptName === "string" ? { script_name: scriptName } : {}),
        });
        break;
      }
      case "plain_text":
        vars[binding.name] = stringField(binding, "text");
        break;
      case "json":
        vars[binding.name] = binding.json;
        break;
      case "assets":
        // Declared through `assets.binding` below.
        break;
      default:
        throw new Error(
          `the manager artifact has a ${binding.type} binding (${binding.name}) this version of ` +
            "the installer cannot create; run the latest create-appflare",
        );
    }
  }
  if (d1.length > 1) {
    throw new Error(
      "the manager artifact has more than one D1 binding; this installer supports one",
    );
  }

  const hasAssets = manifest.assets.files.length > 0 || manifest.assets.binding !== null;
  const config: GeneratedWranglerConfig = {
    name,
    main: `${UNPACKED_WORKER_DIR}/${worker.mainModule}`,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    // The modules are wrangler's own build output: upload them as they are.
    // Exact file names as globs (wrangler's glob-to-regexp treats only `*`
    // specially without `extended`), so nothing else is picked up.
    no_bundle: true,
    find_additional_modules: true,
    base_dir: UNPACKED_WORKER_DIR,
    rules: [...rulesByType].map(([type, globs]) => ({ type, globs })),
    workers_dev: true,
    preview_urls: true,
    keep_vars: true,
    send_metrics: false,
    ...(hasAssets
      ? {
          assets: {
            ...manifest.assets.config,
            directory: UNPACKED_ASSETS_DIR,
            ...(manifest.assets.binding ? { binding: manifest.assets.binding } : {}),
          },
        }
      : {}),
    ...(d1.length > 0 ? { d1_databases: d1 } : {}),
    ...(kv.length > 0 ? { kv_namespaces: kv } : {}),
    ...(workflows.length > 0 ? { workflows } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    triggers: { crons: [...worker.crons] },
    ...(worker.observability ? { observability: { ...worker.observability } } : {}),
    ...(worker.migrations.length > 0
      ? { migrations: worker.migrations.map((m) => ({ ...m })) }
      : {}),
    ...(worker.placement ? { placement: { ...worker.placement } } : {}),
    ...(worker.limits ? { limits: { ...worker.limits } } : {}),
  };
  return config;
}
