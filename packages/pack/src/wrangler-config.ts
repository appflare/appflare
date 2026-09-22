import type { ModuleType, WorkerBinding } from "@appflare/schema";

/**
 * A structural view of the subset of wrangler's resolved config
 * (`unstable_readConfig`) that the packer reads. Declared locally rather than
 * importing wrangler's `Unstable_Config` so the packer does not depend on
 * wrangler's own (unbundled) type packages; the real object has more fields,
 * which structural typing tolerates.
 */
export interface ResolvedWranglerConfig {
  configPath?: string | null;
  main?: string | null;
  name?: string | null;
  compatibility_date?: string | null;
  compatibility_flags?: string[];
  vars?: Record<string, unknown>;
  kv_namespaces?: Array<{ binding: string }>;
  d1_databases?: Array<{ binding: string; migrations_dir?: string | null }>;
  r2_buckets?: Array<{ binding: string }>;
  queues?: { producers?: Array<{ binding: string; delivery_delay?: number }> };
  vectorize?: Array<{ binding: string }>;
  hyperdrive?: Array<{ binding: string }>;
  analytics_engine_datasets?: Array<{ binding: string; dataset?: string }>;
  mtls_certificates?: Array<{ binding: string }>;
  durable_objects?: {
    bindings?: Array<{
      name: string;
      class_name?: string;
      script_name?: string;
      environment?: string;
    }>;
  };
  services?: Array<{
    binding: string;
    service?: string;
    environment?: string;
    entrypoint?: string;
  }>;
  ai?: { binding: string } | null;
  browser?: { binding: string } | null;
  version_metadata?: { binding: string } | null;
  send_email?: Array<{ name: string; destination_address?: string }>;
  assets?: {
    directory?: string;
    binding?: string | null;
    html_handling?: string;
    not_found_handling?: string;
    run_worker_first?: boolean | string[];
  } | null;
  triggers?: { crons?: string[] };
  migrations?: unknown[];
  observability?: { enabled?: boolean; [k: string]: unknown } | null;
  placement?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
}

/**
 * Converts wrangler's per-kind binding arrays into the artifact manifest's flat
 * `bindings` array, keeping only the binding NAME, its TYPE, and fields that are
 * not account-specific.
 *
 * The stripping rule is an allowlist, not a denylist: for each binding kind we
 * copy only the handful of fields known to be safe, so no account id
 * (`id`/`database_id`/`namespace_id`/`bucket_name`/`index_name`/`certificate_id`,
 * preview ids, queue names, etc.) can ever leak into a published artifact. The
 * user's account fills those in at install time. `type` values use Cloudflare's
 * upload-metadata binding type names so the manager can pass them through.
 * Unrecognized kinds are intentionally not emitted (extend this as the catalog
 * grows); DO class references and `vars` are handled here too.
 */
export function collectBindings(config: ResolvedWranglerConfig): WorkerBinding[] {
  const bindings: WorkerBinding[] = [];
  // Spread the optional extras so excess-property checks never fight the
  // schema's loose binding shape, and undefined extras drop out cleanly.
  const push = (type: string, name: string, extra?: Record<string, unknown>): void => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (v !== undefined) {
        clean[k] = v;
      }
    }
    bindings.push({ type, name, ...clean });
  };

  for (const kv of config.kv_namespaces ?? []) {
    push("kv_namespace", kv.binding);
  }
  for (const d1 of config.d1_databases ?? []) {
    push("d1", d1.binding);
  }
  for (const r2 of config.r2_buckets ?? []) {
    push("r2_bucket", r2.binding);
  }
  for (const producer of config.queues?.producers ?? []) {
    push("queue", producer.binding, { delivery_delay: producer.delivery_delay });
  }
  for (const v of config.vectorize ?? []) {
    push("vectorize", v.binding);
  }
  for (const h of config.hyperdrive ?? []) {
    push("hyperdrive", h.binding);
  }
  for (const ae of config.analytics_engine_datasets ?? []) {
    push("analytics_engine", ae.binding, { dataset: ae.dataset });
  }
  for (const cert of config.mtls_certificates ?? []) {
    push("mtls_certificate", cert.binding);
  }
  for (const dobj of config.durable_objects?.bindings ?? []) {
    // class_name/script_name/environment are code references, not account ids.
    push("durable_object_namespace", dobj.name, {
      class_name: dobj.class_name,
      script_name: dobj.script_name,
      environment: dobj.environment,
    });
  }
  for (const svc of config.services ?? []) {
    push("service", svc.binding, {
      service: svc.service,
      environment: svc.environment,
      entrypoint: svc.entrypoint,
    });
  }
  for (const mail of config.send_email ?? []) {
    push("send_email", mail.name);
  }
  if (config.ai) {
    push("ai", config.ai.binding);
  }
  if (config.browser) {
    push("browser", config.browser.binding);
  }
  if (config.version_metadata) {
    push("version_metadata", config.version_metadata.binding);
  }
  // Plain (non-secret) vars become plain_text bindings. Values are
  // public config, safe to record; the manager merges user input over them.
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    push("plain_text", name, { text });
  }

  return bindings;
}

/**
 * Classifies an emitted worker module the way wrangler does, mapping to the
 * artifact schema's module types. Extensions follow wrangler's default module
 * rules (`Text` = txt/html/sql, `Data` = bin, `CompiledWasm` = wasm); the main
 * module is `esm` (or `python` for a `.py` entry). Service-worker format is not
 * detected in v0 (all artifact-tier apps are ES modules).
 */
export function classifyModuleType(relPath: string, isMain: boolean): ModuleType {
  const p = relPath.toLowerCase();
  if (isMain) {
    return p.endsWith(".py") ? "python" : "esm";
  }
  if (p.endsWith(".wasm") || p.endsWith(".wasm?module")) {
    return "compiled-wasm";
  }
  if (p.endsWith(".txt") || p.endsWith(".html") || p.endsWith(".sql")) {
    return "text";
  }
  if (p.endsWith(".bin")) {
    return "data";
  }
  if (p.endsWith(".py")) {
    return "python";
  }
  if (p.endsWith(".cjs")) {
    return "commonjs";
  }
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".jsx")) {
    return "esm";
  }
  // Unknown additional module: keep the bytes, treat as opaque data.
  return "data";
}

/** The expected main-module output filename for a source `main` path. */
export function mainModuleName(mainPath: string): string {
  const base = mainPath.split(/[/\\]/).pop() ?? mainPath;
  if (base.toLowerCase().endsWith(".py")) {
    return base;
  }
  return base.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/i, ".js");
}
