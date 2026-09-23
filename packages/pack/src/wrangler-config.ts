import type {
  CatalogResources,
  JsonValue,
  ModuleType,
  QueueConsumer,
  QueueRef,
  WorkerBinding,
} from "@appflare/schema";

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
  queues?: {
    producers?: Array<{ binding: string; queue?: string; delivery_delay?: number }>;
    consumers?: WranglerQueueConsumer[];
  };
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
  workflows?: Array<{
    binding: string;
    name: string;
    class_name?: string;
    script_name?: string;
  }>;
  services?: Array<{
    binding: string;
    service?: string;
    environment?: string;
    entrypoint?: string;
  }>;
  ai?: { binding: string } | null;
  browser?: { binding: string } | null;
  version_metadata?: { binding: string } | null;
  send_email?: Array<{
    name: string;
    destination_address?: string;
    allowed_destination_addresses?: string[];
    allowed_sender_addresses?: string[];
  }>;
  ratelimits?: Array<{
    name: string;
    namespace_id: string;
    simple?: { limit: number; period: number };
  }>;
  images?: { binding: string } | null;
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

/** One entry of wrangler's `queues.consumers`. */
export interface WranglerQueueConsumer {
  queue: string;
  type?: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  dead_letter_queue?: string;
  max_concurrency?: number | null;
  retry_delay?: number;
}

/**
 * The catalog manifest does not declare the shape of a Vectorize index the
 * wrangler config binds, or declares one the config does not bind. The
 * message names the binding and the `appflare.jsonc` field to fix.
 */
export class VectorizeDeclarationError extends Error {
  override name = "VectorizeDeclarationError";
}

/**
 * Converts wrangler's per-kind binding arrays into the artifact manifest's flat
 * `bindings` array, keeping only the binding NAME, its TYPE, and fields that are
 * not account-specific.
 *
 * A Vectorize binding also records the index's `dimensions` and `metric` from
 * the catalog manifest's `resources.vectorize[<binding>]`: wrangler's config has
 * no place for them, and the manager must create the index before binding it.
 * A Vectorize binding without that declaration, or a declaration for a binding
 * the config does not have, throws {@link VectorizeDeclarationError}.
 *
 * The stripping rule is an allowlist, not a denylist: for each binding kind we
 * copy only the handful of fields known to be safe, so no account id
 * (`id`/`database_id`/`namespace_id`/`bucket_name`/`index_name`/`certificate_id`,
 * preview ids, queue names, etc.) can ever leak into a published artifact. The
 * user's account fills those in at install time. (A rate limit's
 * `namespace_id` is recorded as the app's author wrote it, since the upload
 * shape needs one, but the manager replaces it with an id of each install's
 * own: Cloudflare shares a namespace's counters across every Worker in the
 * account that binds it.) `type` values use Cloudflare's
 * upload-metadata binding type names so the manager can pass them through.
 * Unrecognized kinds are intentionally not emitted (extend this as the catalog
 * grows); DO class references and `vars` are handled here too.
 */
export function collectBindings(
  config: ResolvedWranglerConfig,
  resources?: CatalogResources,
): WorkerBinding[] {
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
  const declared = resources?.vectorize ?? {};
  const bound = new Set<string>();
  for (const v of config.vectorize ?? []) {
    bound.add(v.binding);
    const index = Object.hasOwn(declared, v.binding) ? declared[v.binding] : undefined;
    if (index === undefined) {
      throw new VectorizeDeclarationError(
        `the wrangler config binds a Vectorize index as ${v.binding}, but the catalog manifest does not say how to create it; ` +
          `add resources.vectorize.${v.binding} with { "dimensions": <1-1536>, "metric": "cosine" | "euclidean" | "dot-product" } to appflare.jsonc`,
      );
    }
    push("vectorize", v.binding, { dimensions: index.dimensions, metric: index.metric });
  }
  const unbound = Object.keys(declared).filter((binding) => !bound.has(binding));
  if (unbound.length > 0) {
    throw new VectorizeDeclarationError(
      `the catalog manifest declares resources.vectorize.${unbound.join(", resources.vectorize.")}, ` +
        "but the wrangler config has no Vectorize binding by that name; remove it from appflare.jsonc or fix the binding name",
    );
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
  for (const wf of config.workflows ?? []) {
    // Upload-metadata shape for a workflow binding (verified against wrangler
    // 4.136.2: `type: "workflow", name: <binding>, workflow_name, class_name,
    // script_name`). All four are code/config references, not account ids, so the
    // whole binding survives to the artifact; the manager passes it through.
    push("workflow", wf.binding, {
      workflow_name: wf.name,
      class_name: wf.class_name,
      script_name: wf.script_name,
    });
  }
  for (const mail of config.send_email ?? []) {
    // The restrictions are addresses the app's author chose, not account ids.
    // Same precedence as wrangler's upload: a fixed destination wins over a
    // list of allowed destinations; allowed senders apply either way.
    const destination =
      mail.destination_address !== undefined
        ? { destination_address: mail.destination_address }
        : { allowed_destination_addresses: mail.allowed_destination_addresses };
    push("send_email", mail.name, {
      ...destination,
      allowed_sender_addresses: mail.allowed_sender_addresses,
    });
  }
  for (const limit of config.ratelimits ?? []) {
    // `namespace_id` names the limit's counters, which Cloudflare shares
    // across every Worker in the account that binds the same id. It is kept
    // only so the binding stays complete; the manager gives each install an
    // id of its own before uploading.
    push("ratelimit", limit.name, { namespace_id: limit.namespace_id, simple: limit.simple });
  }
  if (config.images) {
    push("images", config.images.binding);
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
  // Plain (non-secret) vars, typed the way wrangler uploads them (4.136.2's
  // `toVarBinding`): a string is a `plain_text` binding, anything else a
  // `json` binding holding the value itself, so `[]` reaches the Worker as an
  // array, not the text "[]". Values are public config, safe to record; the
  // manager merges user input over them.
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    if (typeof value === "string") {
      push("plain_text", name, { text: value });
    } else {
      bindings.push({ type: "json", name, json: toJsonValue(name, value) });
    }
  }

  return bindings;
}

/**
 * `value` as the JSON wrangler's upload would send: a round trip through
 * `JSON.stringify`, as the upload metadata takes (a TOML date becomes its ISO
 * string, an `undefined` inside an object disappears).
 */
function toJsonValue(name: string, value: unknown): JsonValue {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error(`the wrangler config var ${name} has no JSON value`);
  }
  return JSON.parse(text) as JsonValue;
}

/** The wrangler config declares a queue consumer the packer cannot record. */
export class QueueConsumerError extends Error {
  override name = "QueueConsumerError";
}

/**
 * Records wrangler's `queues.consumers` for the artifact. Queue names belong
 * to the account, so each queue is named the way the install will know it: by
 * the producer binding that sends to it (the install creates that binding's
 * queue), else by its upstream name, which the install turns into a queue of
 * its own (`<workerName>-<name>`). Dead-letter queues follow the same rule.
 * Settings keep wrangler's names and units. Only Worker consumers are
 * recorded; an HTTP pull consumer (`type: "http_pull"`) throws
 * {@link QueueConsumerError}, since nothing in the app's Worker would read it.
 */
export function collectQueueConsumers(config: ResolvedWranglerConfig): QueueConsumer[] {
  const producerOf = new Map<string, string>();
  for (const producer of config.queues?.producers ?? []) {
    if (producer.queue !== undefined && !producerOf.has(producer.queue)) {
      producerOf.set(producer.queue, producer.binding);
    }
  }
  const ref = (queue: string): QueueRef => {
    const binding = producerOf.get(queue);
    return binding !== undefined ? { binding } : { name: queue };
  };
  const consumers: QueueConsumer[] = [];
  const seen = new Set<string>();
  for (const consumer of config.queues?.consumers ?? []) {
    if (consumer.type !== undefined && consumer.type !== "worker") {
      throw new QueueConsumerError(
        `the wrangler config declares a ${consumer.type} consumer for the queue ${consumer.queue}; ` +
          "Appflare attaches only Worker consumers (the app's own queue() handler)",
      );
    }
    if (seen.has(consumer.queue)) {
      throw new QueueConsumerError(
        `the wrangler config declares two consumers for the queue ${consumer.queue}; a Worker consumes a queue once`,
      );
    }
    seen.add(consumer.queue);
    const out: QueueConsumer = { queue: ref(consumer.queue) };
    if (consumer.max_batch_size !== undefined) out.max_batch_size = consumer.max_batch_size;
    if (consumer.max_batch_timeout !== undefined)
      out.max_batch_timeout = consumer.max_batch_timeout;
    if (consumer.max_retries !== undefined) out.max_retries = consumer.max_retries;
    if (consumer.dead_letter_queue !== undefined) {
      out.dead_letter_queue = ref(consumer.dead_letter_queue);
    }
    if (consumer.max_concurrency !== undefined) out.max_concurrency = consumer.max_concurrency;
    if (consumer.retry_delay !== undefined) out.retry_delay = consumer.retry_delay;
    consumers.push(out);
  }
  return consumers;
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
