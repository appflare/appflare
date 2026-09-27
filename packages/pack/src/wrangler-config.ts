import {
  type CatalogResources,
  type EntryServiceBinding,
  entryWorkerRef,
  isUnsupportedWranglerSection,
  type JsonValue,
  type ModuleType,
  PIPELINES_BINDING_TYPE,
  type QueueConsumer,
  type QueueRef,
  SELF_SERVICE,
  type SelfServiceBinding,
  UNSUPPORTED_WRANGLER_SECTION_LABELS,
  UNSUPPORTED_WRANGLER_SECTIONS,
  type UnsupportedWranglerSection,
  WORKER_LOADER_BINDING_TYPE,
  type WorkerBinding,
  type WorkerCacheOptions,
  type WorkerExports,
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
  /** The Worker is uploaded as written, without wrangler's bundling. */
  no_bundle?: boolean;
  name?: string | null;
  compatibility_date?: string | null;
  compatibility_flags?: string[];
  vars?: Record<string, unknown>;
  kv_namespaces?: Array<{ binding: string }>;
  d1_databases?: Array<{
    binding: string;
    migrations_dir?: string | null;
    migrations_pattern?: string | null;
  }>;
  r2_buckets?: Array<{ binding: string }>;
  queues?: {
    producers?: Array<{ binding: string; queue?: string; delivery_delay?: number }>;
    consumers?: WranglerQueueConsumer[];
  };
  vectorize?: Array<{ binding: string }>;
  hyperdrive?: Array<{ binding: string }>;
  /**
   * Pipelines streams: `stream` is the stream's id (`pipeline`, its name
   * before June 2026, still works), which belongs to one account.
   */
  pipelines?: Array<{ binding: string; stream?: string; pipeline?: string }>;
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
    props?: unknown;
    cross_account_grant?: unknown;
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
  /**
   * wrangler's escape hatch for bindings its config has no field for. Only
   * rate limits (from before wrangler had `ratelimits`) are taken; see
   * {@link collectBindings}.
   */
  unsafe?: {
    bindings?: Array<{ name?: unknown; type?: unknown; [k: string]: unknown }> | null;
    metadata?: unknown;
    capnp?: unknown;
  } | null;
  /** The secrets the Worker needs, by name (wrangler's `secrets.required`). */
  secrets?: { required?: string[] } | null;
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
  worker_loaders?: Array<{ binding: string }>;
  /** Declarative Durable Object and entrypoint exports, keyed by name. */
  exports?: Record<string, unknown> | null;
  cache?: { enabled: boolean; cross_version_cache?: boolean } | null;
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
 * The wrangler config binds Hyperdrive under a name the catalog manifest's
 * `resources.hyperdrive` does not declare, or the manifest declares one the
 * config does not bind. The message names the binding and the field to fix.
 */
export class HyperdriveDeclarationError extends Error {
  override name = "HyperdriveDeclarationError";
}

/**
 * The wrangler config binds a Pipelines stream the catalog manifest's
 * `resources.pipelines` does not describe, or the manifest describes one the
 * config does not bind. The message names the binding and the field to fix.
 */
export class PipelineDeclarationError extends Error {
  override name = "PipelineDeclarationError";
}

/**
 * The wrangler config declares a service binding the packer refuses: one to
 * any Worker other than the app's own, or a self binding carrying more than an
 * entrypoint. The message names the binding and says why.
 */
export class ServiceBindingError extends Error {
  override name = "ServiceBindingError";
}

/**
 * The wrangler config declares an `unsafe` binding the packer cannot record:
 * any type but a rate limit, or a rate limit without a name, namespace or
 * `simple` limit. The message names the binding and says why.
 */
export class UnsafeBindingError extends Error {
  override name = "UnsafeBindingError";
}

/**
 * The wrangler config declares a section the packer does not carry into the
 * artifact ({@link UNSUPPORTED_WRANGLER_SECTIONS}): the app would be
 * installed without it. The message names the section and how a catalog
 * entry drops it.
 */
export class UnsupportedSectionError extends Error {
  override name = "UnsupportedSectionError";
}

/**
 * Every top-level key of wrangler 4.136.2's config (`config-schema.json`,
 * `RawConfig`) the packer reads into the artifact, or that wrangler's own
 * bundle applies to the modules the packer collects.
 */
export const READ_WRANGLER_KEYS = [
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "no_bundle",
  "vars",
  "secrets",
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "queues",
  "vectorize",
  "hyperdrive",
  "analytics_engine_datasets",
  "mtls_certificates",
  "durable_objects",
  "workflows",
  "services",
  "ai",
  "browser",
  "images",
  "version_metadata",
  "send_email",
  "ratelimits",
  "worker_loaders",
  "assets",
  "triggers",
  "migrations",
  "exports",
  "observability",
  "placement",
  "limits",
  "cache",
  // Applied by wrangler's bundle, whose output the packer collects.
  "build",
  "rules",
  "find_additional_modules",
  "preserve_file_names",
  "base_dir",
  "minify",
  "keep_names",
  "tsconfig",
  "jsx_factory",
  "jsx_fragment",
  "define",
  "alias",
  "python_modules",
] as const;

/**
 * The keys of wrangler's config the packer leaves out on purpose, and why:
 * they belong to the account or the install, to local development, or to
 * wrangler itself, and the app runs the same without them.
 */
export const IGNORED_WRANGLER_KEYS: Readonly<Record<string, string>> = {
  $schema: "it points editors at wrangler's schema",
  env: "the packer builds the config's top level, not an environment",
  account_id: "the app is installed in the user's account",
  workers_dev: "the install decides where the Worker answers",
  preview_urls: "the install decides where the Worker answers",
  routes: "routes belong to the install",
  route: "routes belong to the install",
  compliance_region: "the region follows the account",
  logpush: "a Logpush job belongs to the account, and the install has none",
  upload_source_maps: "source maps only help debugging",
  first_party_worker: "it is for Cloudflare's own Workers",
  keep_vars: "the manager owns the installed Worker's vars",
  send_metrics: "it is wrangler's own telemetry",
  dependencies_instrumentation: "it is metadata wrangler sends about the build",
  previews: "it configures wrangler preview deployments",
  access: "it simulates Cloudflare Access in local development",
  dev: "it configures local development",
};

function isEmptySection(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.values(value).every(isEmptySection);
  return false;
}

/**
 * The `unsafe` section without its rate limits, which the packer records as
 * the `ratelimit` bindings they are: what is left is what it refuses.
 */
function unsafeWithoutRateLimits(unsafe: unknown): unknown {
  if (!isRecord(unsafe) || !Array.isArray(unsafe.bindings)) return unsafe;
  return {
    ...unsafe,
    bindings: unsafe.bindings.filter((b) => !(isRecord(b) && b.type === "ratelimit")),
  };
}

/**
 * The {@link UNSUPPORTED_WRANGLER_SECTIONS} `config` declares, as wrangler
 * resolved it (it fills in empty lists and objects, which do not count).
 * Rate limits in `unsafe.bindings` do not count either: they are recorded.
 */
export function unsupportedWranglerSections(config: object): UnsupportedWranglerSection[] {
  const sections = config as Record<string, unknown>;
  return UNSUPPORTED_WRANGLER_SECTIONS.filter(
    (key) =>
      !isEmptySection(key === "unsafe" ? unsafeWithoutRateLimits(sections[key]) : sections[key]),
  );
}

/**
 * The sections of {@link UNSUPPORTED_WRANGLER_SECTIONS} that
 * {@link collectBindings} reads itself, against the catalog manifest:
 * Pipelines streams it describes in `resources.pipelines`, and rate limits
 * among `unsafe.bindings` ({@link unsafeRateLimits} refuses the rest).
 */
export const SECTIONS_READ_WITH_CATALOG: readonly UnsupportedWranglerSection[] = [
  "pipelines",
  "unsafe",
];

/**
 * A section named in a pack's `allowSections` that cannot be allowed: not a
 * section the packer refuses, or one of {@link SECTIONS_READ_WITH_CATALOG},
 * which the packer reads and checks itself.
 */
export class AllowedSectionError extends Error {
  override name = "AllowedSectionError";
}

/**
 * Checks the sections a pack may leave out of the artifact without refusing
 * the config (`allowSections`) and returns them without repeats. Each must be
 * one of {@link UNSUPPORTED_WRANGLER_SECTIONS} other than
 * {@link SECTIONS_READ_WITH_CATALOG}; anything else throws
 * {@link AllowedSectionError}.
 */
export function allowedSections(sections: readonly string[]): UnsupportedWranglerSection[] {
  const allowed: UnsupportedWranglerSection[] = [];
  for (const key of sections) {
    if (!isUnsupportedWranglerSection(key)) {
      throw new AllowedSectionError(
        `"${key}" is not a wrangler config section the packer refuses, so there is nothing to ` +
          `allow; the sections it refuses are ${UNSUPPORTED_WRANGLER_SECTIONS.join(", ")}`,
      );
    }
    if (SECTIONS_READ_WITH_CATALOG.includes(key)) {
      throw new AllowedSectionError(
        `${key} cannot be allowed: the packer reads it against the catalog manifest and refuses only what it cannot carry`,
      );
    }
    if (!allowed.includes(key)) allowed.push(key);
  }
  return allowed;
}

/**
 * Throws {@link UnsupportedSectionError} when `config` declares a section the
 * packer does not carry into the artifact, except those in
 * {@link SECTIONS_READ_WITH_CATALOG}, which have refusals of their own, and
 * those in `allow`, which whoever deploys the artifact supplies.
 */
function refuseUnsupportedSections(
  config: ResolvedWranglerConfig,
  allow: readonly UnsupportedWranglerSection[],
): void {
  const found = unsupportedWranglerSections(config).filter(
    (key) => !SECTIONS_READ_WITH_CATALOG.includes(key) && !allow.includes(key),
  );
  if (found.length === 0) return;
  const named = found.map((key) => `${key} (${UNSUPPORTED_WRANGLER_SECTION_LABELS[key]})`);
  const drop = `{ ${found.map((key) => `"${key}": null`).join(", ")} }`;
  throw new UnsupportedSectionError(
    `the wrangler config declares ${named.join(", ")}, which Appflare cannot install, so the app ` +
      `would run without ${found.length === 1 ? "it" : "them"}; if the app works without ` +
      `${found.length === 1 ? "it" : "them"}, drop ${found.length === 1 ? "it" : "them"} with the ` +
      `catalog manifest's config patch ${drop}`,
  );
}

/** A rate limit of wrangler's `ratelimits`, and of `unsafe.bindings` once checked. */
type RateLimitConfig = NonNullable<ResolvedWranglerConfig["ratelimits"]>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The rate limits among the wrangler config's `unsafe.bindings`, in the
 * shape of wrangler's own `ratelimits`: `{ name, type: "ratelimit",
 * namespace_id, simple: { limit, period } }` is what wrangler uploads for
 * either (4.136.2 passes an unsafe binding through as `{ name, type,
 * ...rest }`). Every other `unsafe` binding throws
 * {@link UnsafeBindingError}: the manager could not tell what it needs, and
 * dropping it would leave the Worker without a binding its code reads.
 */
export function unsafeRateLimits(config: ResolvedWranglerConfig): RateLimitConfig[] {
  // wrangler merges `unsafe.metadata` into the upload and compiles
  // `unsafe.capnp` for it; the manager does neither.
  for (const field of ["metadata", "capnp"] as const) {
    const value = config.unsafe?.[field];
    if (
      value !== undefined &&
      value !== null &&
      !(isRecord(value) && Object.keys(value).length === 0)
    ) {
      throw new UnsafeBindingError(
        `the wrangler config sets unsafe.${field}; Appflare installs a Worker from its recorded bindings ` +
          `and settings only, and cannot pass unsafe.${field} through to Cloudflare`,
      );
    }
  }
  const limits: RateLimitConfig[] = [];
  for (const binding of config.unsafe?.bindings ?? []) {
    const name = typeof binding.name === "string" ? binding.name : "(unnamed)";
    if (binding.type !== "ratelimit") {
      throw new UnsafeBindingError(
        `the wrangler config's unsafe binding ${name} has the type ${JSON.stringify(binding.type)}; ` +
          "Appflare takes only rate limits from unsafe.bindings (as the ratelimit binding they are now), " +
          "since it cannot tell what any other unsafe binding needs to be created",
      );
    }
    const { namespace_id: namespaceId, simple } = binding;
    const period = isRecord(simple) ? simple.period : undefined;
    const limit = isRecord(simple) ? simple.limit : undefined;
    if (
      typeof binding.name !== "string" ||
      binding.name.length === 0 ||
      (typeof namespaceId !== "string" && typeof namespaceId !== "number") ||
      typeof limit !== "number" ||
      (period !== 10 && period !== 60)
    ) {
      throw new UnsafeBindingError(
        `the wrangler config's unsafe rate limit ${name} needs a name, a namespace_id and ` +
          '"simple": { "limit": <number>, "period": 10 | 60 }, as wrangler\'s ratelimits binding has',
      );
    }
    limits.push({
      name: binding.name,
      namespace_id: String(namespaceId),
      simple: { limit, period },
    });
  }
  return limits;
}

/** The wrangler config's own vars among `bindings`: `plain_text` and `json`. */
function isVarBinding(binding: WorkerBinding): boolean {
  return binding.type === "plain_text" || binding.type === "json";
}

/**
 * `bindings` without the wrangler config's vars named in `secretNames`, and
 * the names left out. A Worker cannot have a var and a secret of one name:
 * Cloudflare refuses to set the secret (code 10053, "Binding name already in
 * use"), and a version upload that sends the var over a kept secret replaces
 * the secret. The catalog manifest declaring the name as a secret wins,
 * since a secret is what the app's author wants to keep out of the config.
 */
export function withoutSecretVars(
  bindings: readonly WorkerBinding[],
  secretNames: Iterable<string>,
): { bindings: WorkerBinding[]; dropped: string[] } {
  const secrets = new Set(secretNames);
  const dropped: string[] = [];
  const kept = bindings.filter((b) => {
    if (!isVarBinding(b) || !secrets.has(b.name)) return true;
    dropped.push(b.name);
    return false;
  });
  return { bindings: kept, dropped };
}

type WranglerService = NonNullable<ResolvedWranglerConfig["services"]>[number];

/**
 * The artifact's record of a wrangler service binding. A binding to the
 * app's own Worker (its `service` is the config's own `name`, as OpenNext's
 * `WORKER_SELF_REFERENCE` is) becomes `{ type: "service", name, service:
 * "self", entrypoint? }`: the install may run under another Worker name, and
 * the manager puts that name back when it uploads. Every other service
 * binding throws {@link ServiceBindingError}: an app must never be able to call
 * another Worker in the account, least of all the manager.
 */
function selfServiceBinding(
  svc: WranglerService,
  workerName: string | null | undefined,
  entryWorkers?: ReadonlyMap<string, string>,
): SelfServiceBinding | EntryServiceBinding {
  const entryWorker =
    svc.service !== undefined && svc.service !== workerName
      ? entryWorkers?.get(svc.service)
      : undefined;
  if (svc.service === undefined || (svc.service !== workerName && entryWorker === undefined)) {
    const target = svc.service === undefined ? "no Worker" : `the Worker "${svc.service}"`;
    const allowed =
      entryWorkers === undefined
        ? "the only service binding an app may have is one to itself"
        : "an app may bind only to itself and to the other Workers of its catalog entry";
    throw new ServiceBindingError(
      `the wrangler config's service binding ${svc.binding} points at ${target}, not at the app's own Worker` +
        `${workerName ? ` ("${workerName}")` : ""}; Appflare installs self-contained apps and never lets one call another Worker ` +
        `in the account, so ${allowed}`,
    );
  }
  const extras = (["environment", "props", "cross_account_grant"] as const).filter(
    (field) => svc[field] !== undefined,
  );
  if (extras.length > 0) {
    throw new ServiceBindingError(
      `the wrangler config's service binding ${svc.binding} to the app's own Worker sets ${extras.join(", ")}; ` +
        "Appflare records a binding to the app's own Worker with nothing but an optional entrypoint",
    );
  }
  const binding: SelfServiceBinding | EntryServiceBinding =
    entryWorker === undefined
      ? { type: "service", name: svc.binding, service: SELF_SERVICE }
      : { type: "service", name: svc.binding, service: entryWorkerRef(entryWorker) };
  if (svc.entrypoint !== undefined) binding.entrypoint = svc.entrypoint;
  return binding;
}

/** How {@link collectBindings} treats an app of several Workers, and sections it may leave out. */
export interface CollectBindingsOptions {
  /**
   * For one Worker of an app of several: every Worker of the entry, by the
   * name its wrangler config gives it, to its name within the entry. A service
   * binding's `service` or a Durable Object binding's `script_name` that names
   * one of them is recorded as `{{workerName:<name>}}`.
   */
  entryWorkers?: ReadonlyMap<string, string>;
  /**
   * Whether a Vectorize index or a Hyperdrive database the catalog manifest
   * declares but this config does not bind is an error. Default true; an app
   * of several Workers checks that across all of them
   * ({@link checkVectorizeDeclarations}, {@link checkHyperdriveDeclarations}).
   */
  checkUnboundVectorize?: boolean;
  /**
   * Sections of {@link UNSUPPORTED_WRANGLER_SECTIONS} the config may declare
   * without being refused, checked with {@link allowedSections}. The
   * artifact goes without them, so this is only for an artifact whose
   * deployer supplies them itself, as the manager does the sandbox Worker's
   * containers. A catalog entry drops a section with its config patch
   * instead. Default none.
   */
  allowSections?: readonly string[];
}

/**
 * Throws {@link VectorizeDeclarationError} when the catalog manifest declares
 * `resources.vectorize` for a binding none of `bindings` has.
 */
export function checkVectorizeDeclarations(
  bindings: readonly WorkerBinding[],
  resources?: CatalogResources,
): void {
  const bound = new Set(bindings.filter((b) => b.type === "vectorize").map((b) => b.name));
  const unbound = Object.keys(resources?.vectorize ?? {}).filter((binding) => !bound.has(binding));
  if (unbound.length > 0) {
    throw new VectorizeDeclarationError(
      `the catalog manifest declares resources.vectorize.${unbound.join(", resources.vectorize.")}, ` +
        "but the wrangler config has no Vectorize binding by that name; remove it from appflare.jsonc or fix the binding name",
    );
  }
}

/** The catalog manifest's `resources.r2` names a binding the wrangler config does not have. */
export class R2DeclarationError extends Error {
  override name = "R2DeclarationError";
}

/**
 * Throws {@link R2DeclarationError} when the catalog manifest declares
 * `resources.r2` for a binding none of `bindings` has: its lifecycle rules
 * would be set on no bucket.
 */
export function checkR2Declarations(
  bindings: readonly WorkerBinding[],
  resources?: CatalogResources,
): void {
  const bound = new Set(bindings.filter((b) => b.type === "r2_bucket").map((b) => b.name));
  const unbound = Object.keys(resources?.r2 ?? {}).filter((binding) => !bound.has(binding));
  if (unbound.length > 0) {
    throw new R2DeclarationError(
      `the catalog manifest declares resources.r2.${unbound.join(", resources.r2.")}, ` +
        "but the wrangler config has no R2 binding by that name; remove it from appflare.jsonc or fix the binding name",
    );
  }
}

/**
 * Throws {@link HyperdriveDeclarationError} when the catalog manifest declares
 * `resources.hyperdrive` for a binding none of `bindings` has.
 */
export function checkHyperdriveDeclarations(
  bindings: readonly WorkerBinding[],
  resources?: CatalogResources,
): void {
  const connected = new Set(bindings.filter((b) => b.type === "hyperdrive").map((b) => b.name));
  const unconnected = (resources?.hyperdrive ?? [])
    .map((h) => h.binding)
    .filter((binding) => !connected.has(binding));
  if (unconnected.length > 0) {
    throw new HyperdriveDeclarationError(
      `the catalog manifest declares the Hyperdrive binding ${unconnected.join(", ")} in resources.hyperdrive, ` +
        "but the wrangler config has no Hyperdrive binding by that name; remove it from appflare.jsonc or fix the binding name",
    );
  }
}

/**
 * Throws {@link PipelineDeclarationError} when the catalog manifest describes
 * a stream in `resources.pipelines` for a binding none of `bindings` has.
 */
export function checkPipelineDeclarations(
  bindings: readonly WorkerBinding[],
  resources?: CatalogResources,
): void {
  const bound = new Set(
    bindings.filter((b) => b.type === PIPELINES_BINDING_TYPE).map((b) => b.name),
  );
  const unbound = Object.keys(resources?.pipelines ?? {}).filter((binding) => !bound.has(binding));
  if (unbound.length > 0) {
    throw new PipelineDeclarationError(
      `the catalog manifest declares resources.pipelines.${unbound.join(", resources.pipelines.")}, ` +
        "but the wrangler config has no Pipelines binding by that name; remove it from appflare.jsonc or fix the binding name",
    );
  }
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
 * A Hyperdrive binding is recorded by name only, and only when the catalog
 * manifest's `resources.hyperdrive` declares it: the database lives outside
 * Cloudflare, so the manager asks for its connection string at install and
 * creates a Hyperdrive configuration of the install's own. An undeclared
 * binding, or a declaration the config does not bind, throws
 * {@link HyperdriveDeclarationError}.
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
 * grows); DO class references and `vars` are handled here too. A service
 * binding is recorded only when it points at the app's own Worker, and any
 * other throws {@link ServiceBindingError}. A rate limit declared in
 * `unsafe.bindings` is recorded as the `ratelimit` binding it is, and any
 * other `unsafe` binding throws {@link UnsafeBindingError}. A section the
 * packer does not read at all ({@link UNSUPPORTED_WRANGLER_SECTIONS}) throws
 * {@link UnsupportedSectionError} rather than vanish from the artifact,
 * unless `options.allowSections` names it.
 */
export function collectBindings(
  config: ResolvedWranglerConfig,
  resources?: CatalogResources,
  options: CollectBindingsOptions = {},
): WorkerBinding[] {
  const { entryWorkers, checkUnboundVectorize = true, allowSections = [] } = options;
  refuseUnsupportedSections(config, allowedSections(allowSections));
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
  // A bucket's lifecycle rules come from the catalog manifest's
  // `resources.r2[<binding>]`, since wrangler's config has no place for them;
  // the manager sets them when it creates the bucket.
  const buckets = resources?.r2 ?? {};
  for (const r2 of config.r2_buckets ?? []) {
    const settings = Object.hasOwn(buckets, r2.binding) ? buckets[r2.binding] : undefined;
    push("r2_bucket", r2.binding, { lifecycle: settings?.lifecycle });
  }
  if (checkUnboundVectorize) {
    checkR2Declarations(bindings, resources);
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
    push("vectorize", v.binding, {
      dimensions: index.dimensions,
      metric: index.metric,
      metadataIndexes: index.metadataIndexes,
    });
  }
  if (checkUnboundVectorize) {
    checkVectorizeDeclarations(bindings, resources);
  }
  const databases = new Set((resources?.hyperdrive ?? []).map((h) => h.binding));
  for (const h of config.hyperdrive ?? []) {
    if (!databases.has(h.binding)) {
      throw new HyperdriveDeclarationError(
        `the wrangler config binds Hyperdrive as ${h.binding}, but the catalog manifest does not say which database it connects to; ` +
          `add { "binding": "${h.binding}", "protocol": "postgres" | "mysql" } to resources.hyperdrive in appflare.jsonc`,
      );
    }
    push("hyperdrive", h.binding);
  }
  if (checkUnboundVectorize) {
    checkHyperdriveDeclarations(bindings, resources);
  }
  // A stream's id belongs to the account it was created in, so only the
  // binding's name is recorded; the manager creates a stream per install
  // from the catalog manifest's description and binds its id.
  const streams = resources?.pipelines ?? {};
  for (const p of config.pipelines ?? []) {
    if (!Object.hasOwn(streams, p.binding)) {
      throw new PipelineDeclarationError(
        `the wrangler config binds a Pipelines stream as ${p.binding}, but the catalog manifest does not describe it; ` +
          `add resources.pipelines.${p.binding} with the stream's schema and its sink to appflare.jsonc`,
      );
    }
    push(PIPELINES_BINDING_TYPE, p.binding);
  }
  if (checkUnboundVectorize) {
    checkPipelineDeclarations(bindings, resources);
  }
  for (const ae of config.analytics_engine_datasets ?? []) {
    push("analytics_engine", ae.binding, { dataset: ae.dataset });
  }
  for (const cert of config.mtls_certificates ?? []) {
    push("mtls_certificate", cert.binding);
  }
  for (const dobj of config.durable_objects?.bindings ?? []) {
    // class_name/script_name/environment are code references, not account ids.
    // In an app of several Workers, a class in another of them is named by
    // that Worker's name within the entry, and one in this Worker by none.
    const inEntry =
      dobj.script_name === undefined ? undefined : entryWorkers?.get(dobj.script_name);
    const scriptName =
      entryWorkers !== undefined && dobj.script_name === config.name
        ? undefined
        : inEntry !== undefined
          ? entryWorkerRef(inEntry)
          : dobj.script_name;
    push("durable_object_namespace", dobj.name, {
      class_name: dobj.class_name,
      script_name: scriptName,
      environment: dobj.environment,
    });
  }
  for (const svc of config.services ?? []) {
    bindings.push(selfServiceBinding(svc, config.name, entryWorkers));
  }
  for (const wf of config.workflows ?? []) {
    if (
      wf.script_name !== undefined &&
      wf.script_name !== config.name &&
      entryWorkers?.has(wf.script_name) === true
    ) {
      throw new ServiceBindingError(
        `the wrangler config's Workflow binding ${wf.binding} runs the Workflow of the Worker "${wf.script_name}"; ` +
          "Appflare installs each Workflow with the Worker that defines it, so bind it there",
      );
    }
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
  // A rate limit from `unsafe.bindings` is the same binding under wrangler's
  // older name; any other unsafe binding throws.
  for (const limit of [...(config.ratelimits ?? []), ...unsafeRateLimits(config)]) {
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
  for (const loader of config.worker_loaders ?? []) {
    // Wrangler 4.136.2 uploads `{ name, type: "worker_loader" }`; nothing else
    // is configurable. Cloudflare offers it only on Workers Paid.
    push(WORKER_LOADER_BINDING_TYPE, loader.binding);
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
 * The config's `placement` as wrangler 4.136.2 uploads it
 * (`parseConfigPlacement`): `mode: "off"` without a hint is no placement at
 * all (null), a hint or `mode: "smart"` is `{ mode: "smart", hint? }`, and a
 * `region`, `host` or `hostname` is `{ mode: "targeted", <that one> }`.
 * Anything else is no placement either. Cloudflare's API knows only `smart`
 * and `targeted`, so recording `{ mode: "off" }` as written would fail the
 * upload.
 */
export function uploadPlacement(
  placement: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> | null {
  if (placement === null || placement === undefined) return null;
  const hint =
    typeof placement.hint === "string" && placement.hint.length > 0 ? placement.hint : undefined;
  if (hint === undefined && placement.mode === "off") return null;
  if (hint !== undefined || placement.mode === "smart") {
    return hint === undefined ? { mode: "smart" } : { mode: "smart", hint };
  }
  for (const key of ["region", "host", "hostname"] as const) {
    const value = placement[key];
    if (typeof value === "string" && value.length > 0) return { mode: "targeted", [key]: value };
  }
  return null;
}

/**
 * The Worker settings beyond its bindings that the artifact records only when
 * the config sets them, as wrangler 4.136.2 uploads them:
 *
 * - `exports`: the config's `exports` entries of type `durable-object` or
 *   `worker` (wrangler's `partitionExports` drops any other), uploaded as
 *   `exports`; omitted when there are none, as wrangler omits an empty block;
 * - `cacheOptions`: the config's `cache` block, uploaded as `cache_options`.
 *
 * Both are the app's own code and settings, not account ids.
 */
export function collectWorkerSettings(config: ResolvedWranglerConfig): {
  exports?: WorkerExports;
  cacheOptions?: WorkerCacheOptions;
} {
  const out: { exports?: WorkerExports; cacheOptions?: WorkerCacheOptions } = {};
  const kept: WorkerExports = {};
  for (const [name, entry] of Object.entries(config.exports ?? {})) {
    if (typeof entry !== "object" || entry === null) continue;
    const type = (entry as { type?: unknown }).type;
    if (type !== "durable-object" && type !== "worker") continue;
    kept[name] = { ...(entry as Record<string, unknown>), type };
  }
  if (Object.keys(kept).length > 0) out.exports = kept;
  if (config.cache) out.cacheOptions = { ...config.cache };
  return out;
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

/**
 * Each queue the configs send to, by its upstream name, to the first producer
 * binding that sends to it. For an app of several Workers, pass every
 * Worker's config: a queue one Worker sends to and another consumes is then
 * known by that binding in both, so the install creates one queue for it.
 */
export function queueProducerBindings(
  configs: readonly ResolvedWranglerConfig[],
): Map<string, string> {
  const producerOf = new Map<string, string>();
  for (const config of configs) {
    for (const producer of config.queues?.producers ?? []) {
      if (producer.queue !== undefined && !producerOf.has(producer.queue)) {
        producerOf.set(producer.queue, producer.binding);
      }
    }
  }
  return producerOf;
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
export function collectQueueConsumers(
  config: ResolvedWranglerConfig,
  producers?: ReadonlyMap<string, string>,
): QueueConsumer[] {
  const producerOf = new Map<string, string>(producers ?? queueProducerBindings([config]));
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

/**
 * The expected main-module output filename for a source `main` path. A
 * bundled Worker's is esbuild's output, `<name>.js` whatever the source's
 * extension (`.ts`, `.mjs` and `.cjs` alike, checked against wrangler
 * 4.136.2's dry run). With `no_bundle`, wrangler copies the entry as it is,
 * so its name keeps its extension (`entry.mjs`, as the Astro Cloudflare
 * adapter emits it).
 */
export function mainModuleName(mainPath: string, noBundle = false): string {
  const base = mainPath.split(/[/\\]/).pop() ?? mainPath;
  if (noBundle || base.toLowerCase().endsWith(".py")) {
    return base;
  }
  return base.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/i, ".js");
}
