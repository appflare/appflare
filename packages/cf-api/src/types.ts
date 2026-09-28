/**
 * Request/response shapes for the Cloudflare endpoints Appflare uses.
 * Only the fields the manager and CLI actually read are typed; every list is
 * intentionally non-exhaustive. Request-body shapes the caller fully controls
 * carry an index signature so binding- or endpoint-specific extras pass through.
 */

/** A Worker binding, wrangler's shape minus ids the account fills in. */
export interface WorkerBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

/** Static-assets serving config attached to a script/version. */
export interface AssetsConfig {
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: boolean | string[];
  /** The text of the assets directory's `_redirects` file, as wrangler sends it. */
  _redirects?: string;
  /** The text of the assets directory's `_headers` file, as wrangler sends it. */
  _headers?: string;
  [key: string]: unknown;
}

/** Metadata JSON part of a `PUT /workers/scripts/{name}` multipart upload. */
export interface ScriptMetadata {
  main_module?: string;
  bindings?: WorkerBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  /** Durable Object migrations, wrangler shape. */
  migrations?: unknown;
  assets?: { jwt?: string; config?: AssetsConfig };
  observability?: { enabled: boolean; head_sampling_rate?: number };
  placement?: { mode?: string } | null;
  limits?: { cpu_ms?: number } | null;
  /** Binding types to preserve from the currently deployed version. */
  keep_bindings?: string[];
  keep_assets?: boolean;
  /**
   * The Worker's container-enabled Durable Object classes, each by its
   * container application's name (wrangler 4.136.2's `getContainerMetadata`
   * for containers with a `class_name` and a registry image). Cloudflare
   * echoes them in a version's `resources.script_runtime.containers`.
   */
  containers?: Array<{ name?: string; class_name?: string }>;
  [key: string]: unknown;
}

/** Metadata JSON part of a `POST /workers/scripts/{name}/versions` upload. */
export interface VersionMetadata extends ScriptMetadata {
  /** e.g. `{ "workers/message": "...", "workers/tag": "..." }`. */
  annotations?: Record<string, string>;
}

/** `GET /accounts/{id}`: the fields Appflare reads. */
export interface AccountDetails {
  id: string;
  name: string;
  /** `standard` or `enterprise`. */
  type?: string;
  created_on?: string;
}

export interface TokenVerifyResult {
  id: string;
  status: string;
  not_before?: string;
  expires_on?: string;
}

export interface WorkerScript {
  id: string;
  created_on?: string;
  modified_on?: string;
  etag?: string;
  usage_model?: string;
  /**
   * Event handlers the Worker's code exports (`fetch`, `scheduled`, `queue`,
   * `email`, ...), as `GET /workers/scripts` lists them.
   */
  handlers?: string[];
  /** The last Durable Object migration tag applied to the Worker, when it has one. */
  migration_tag?: string;
}

export interface ScriptUploadResult {
  id: string;
  etag?: string;
  startup_time_ms?: number;
  /** The new version id (wrangler reads it as the "Current Version ID"); may lack hyphens. */
  deployment_id?: string | null;
  [key: string]: unknown;
}

export interface SubdomainResult {
  enabled: boolean;
  previews_enabled?: boolean;
}

export interface AccountSubdomain {
  subdomain: string;
}

export interface WorkerSecret {
  name: string;
  type: string;
}

export interface WorkerSchedule {
  cron: string;
  created_on?: string;
  modified_on?: string;
}

export interface WorkerVersion {
  id: string;
  number?: number;
  metadata?: Record<string, unknown>;
  annotations?: Record<string, string>;
  resources?: Record<string, unknown>;
}

/**
 * `POST /workers/scripts/{name}/versions` result: `id` is the new version id
 * (wrangler 4.136.2 reads `result.id` and `result.metadata.has_preview`).
 */
export interface VersionUploadResult {
  id: string;
  number?: number;
  startup_time_ms?: number;
  metadata?: {
    /** False when Cloudflare serves no preview URL for the version (Workers with Durable Objects). */
    has_preview?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** `GET /workers/scripts/{name}/deployments` lists the deployment serving traffic first. */
export interface WorkerDeployment {
  id: string;
  created_on?: string;
  source?: string;
  strategy?: string;
  versions?: Array<{ version_id: string; percentage: number }>;
  annotations?: Record<string, string>;
}

/** One version+traffic entry of a `createDeployment` request. */
export interface DeploymentVersion {
  version_id: string;
  percentage: number;
}

export interface AssetUploadSession {
  jwt: string;
  buckets: string[][];
}

export interface KvNamespace {
  id: string;
  title: string;
  supports_url_encoding?: boolean;
}

export interface D1Database {
  uuid: string;
  name: string;
  version?: string;
  created_at?: string;
  /** Database size in bytes (`GET /d1/database/{uuid}`). */
  file_size?: number;
  num_tables?: number;
}

export interface D1QueryResult {
  results: Array<Record<string, unknown>>;
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1TimeTravelBookmark {
  bookmark: string;
}

export interface D1TimeTravelRestore {
  bookmark: string;
  previous_bookmark?: string;
}

/** One entry of `GET /r2/buckets/{name}/objects` (fields the manager reads). */
export interface R2Object {
  key: string;
  size?: number;
  etag?: string;
  last_modified?: string;
}

/** One page of a cursor-paginated listing. `cursor` is null on the last page. */
export interface CursorPage<T> {
  items: T[];
  cursor: string | null;
}

/** One entry of `GET /storage/kv/namespaces/{id}/keys`. */
export interface KvKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

export interface R2Bucket {
  name: string;
  creation_date?: string;
  location?: string;
  storage_class?: string;
}

export interface Queue {
  queue_id: string;
  queue_name: string;
  created_on?: string;
}

/**
 * Delivery settings of a Worker queue consumer, in the API's names and units
 * (wrangler's `max_batch_timeout` in seconds is `max_wait_time_ms` here).
 * `max_concurrency: null` asks for the platform's maximum.
 */
export interface QueueConsumerSettings {
  batch_size?: number;
  max_retries?: number;
  max_wait_time_ms?: number;
  max_concurrency?: number | null;
  /** Seconds before a retried message is delivered again. */
  retry_delay?: number;
}

/**
 * Body of `POST /queues/{id}/consumers` and `PUT /queues/{id}/consumers/{consumer_id}`
 * for a Worker consumer (the shape wrangler 4.136.2's `updateQueueConsumers` sends).
 */
export interface WorkerQueueConsumerBody {
  type: "worker";
  script_name: string;
  /** The dead-letter queue's NAME, not its id. */
  dead_letter_queue?: string;
  settings?: QueueConsumerSettings;
}

/** A queue consumer as the API returns it (fields the manager reads). */
export interface QueueConsumerInfo {
  consumer_id: string;
  type?: string;
  queue_name?: string;
  script_name?: string;
  /** Some responses name the Worker `script` instead of `script_name`. */
  script?: string;
  /** Others name it `service` (wrangler checks `script` and `service`). */
  service?: string;
  dead_letter_queue?: string;
  settings?: QueueConsumerSettings;
  created_on?: string;
}

export interface VectorizeIndex {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
}

/** `GET /workflows/{name}` (fields the manager reads). */
export interface WorkflowInfo {
  id: string;
  name: string;
  class_name?: string;
  script_name?: string;
}

/** `GET /access/organizations`: the account's Zero Trust organization (fields read). */
export interface AccessOrganization {
  /** The team domain, `<team>.cloudflareaccess.com`; also the JWT issuer host. */
  auth_domain: string;
  name?: string;
}

/** `GET /access/identity_providers` (fields read). */
export interface AccessIdentityProvider {
  id: string;
  /** `onetimepin`, `cloudflare`, `google`, `github`, `azureAD`, `saml`, `oidc`, … */
  type: string;
  name?: string;
  config?: Record<string, unknown>;
}

/**
 * One rule of an Access policy's `include`/`exclude`/`require` list. Only the
 * rule kinds Appflare writes are typed; others pass through when read back.
 */
export type AccessRule =
  | { email: { email: string } }
  | { everyone: Record<string, never> }
  | Record<string, unknown>;

/** Body of `POST /access/apps` for a self-hosted application. */
export interface CreateAccessAppArgs {
  type: "self_hosted";
  name: string;
  /** Hostname, optionally with a path (`host/api/health`), that Access protects. */
  domain: string;
  /** How long a sign-in lasts, e.g. `24h`. */
  session_duration?: string;
  app_launcher_visible?: boolean;
  [key: string]: unknown;
}

export interface AccessApp {
  id: string;
  /** The application audience tag: the `aud` claim of its JWTs. */
  aud: string;
  name?: string;
  domain?: string;
  type?: string;
  session_duration?: string;
  /** The application's policies, as `GET` and `PUT /access/apps/{id}` answer them. */
  policies?: Array<{ id: string; name?: string; decision?: string; precedence?: number }>;
}

/** Body of `POST`/`PUT /access/apps/{id}/policies[/{policy_id}]`. */
export interface AccessPolicyArgs {
  name: string;
  decision: "allow" | "deny" | "bypass" | "non_identity";
  /** A request matches when it matches at least one rule. */
  include: AccessRule[];
  exclude?: AccessRule[];
  require?: AccessRule[];
  precedence?: number;
  [key: string]: unknown;
}

export interface AccessPolicy {
  id: string;
  name?: string;
  decision?: string;
  include?: AccessRule[];
  precedence?: number;
}

/** One RSA signing key of an Access team, as a JWK. */
export interface AccessJwk {
  kid: string;
  kty: "RSA";
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

/** `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`: the team's JWT signing keys. */
export interface AccessCerts {
  keys: AccessJwk[];
}

/**
 * One entry of `GET /accounts/{id}/subscriptions` (the fields Appflare reads;
 * the rest are kept loosely). Seen live: account plans such as `workers_paid`,
 * `r2_paid`, `teams_free` (`rate_plan.scope` `account`) and one `free` entry
 * per zone on the free zone plan (`scope` `zone`, with `zone`).
 */
export interface AccountSubscription {
  id?: string;
  rate_plan?: {
    id?: string;
    public_name?: string;
    scope?: string;
    externally_managed?: boolean;
    is_contract?: boolean;
  };
  product?: { name?: string; public_name?: string };
  /** `Paid`, `Trial`, `Provisioned`, `AwaitingPayment`, `Cancelled`, `Failed`, `Expired`. */
  state?: string;
  frequency?: string;
  price?: number;
  [key: string]: unknown;
}

/**
 * What a container application runs: `image` and `instance_type` are the
 * fields Appflare sets (wrangler 4.136.2's `UserDeploymentConfiguration`).
 */
export interface ContainerApplicationConfiguration {
  image?: string;
  /** `lite`, `basic`, `standard-1` … `standard-4`. */
  instance_type?: string;
  [key: string]: unknown;
}

/** Instance counts by state, in an application's (or a rollout's) `health`. */
export interface ContainerHealthInstances {
  active?: number;
  healthy?: number;
  failed?: number;
  starting?: number;
  scheduling?: number;
}

/** One entry of `GET /containers/applications`, or one application. */
export interface ContainerApplication {
  id: string;
  name: string;
  /** Bumped by every change of the application. */
  version?: number;
  max_instances?: number;
  configuration?: ContainerApplicationConfiguration;
  /** The Durable Object namespace whose objects the instances back. */
  durable_objects?: { namespace_id?: string };
  /** Set while a rollout moves the instances to a new configuration. */
  active_rollout_id?: string;
  health?: { instances?: ContainerHealthInstances };
  [key: string]: unknown;
}

/** `POST /containers/applications` body (wrangler 4.136.2's `CreateApplicationRequest`). */
export interface CreateContainerApplicationArgs {
  name: string;
  scheduling_policy: string;
  /** Deprecated by Cloudflare in favour of `max_instances`; wrangler sends 0. */
  instances: number;
  max_instances: number;
  configuration: ContainerApplicationConfiguration;
  /** Wrangler's default is `{ tiers: [1, 2] }`. */
  constraints?: { tiers?: number[]; [key: string]: unknown };
  observability?: { logs?: { enabled: boolean } };
  durable_objects: { namespace_id: string };
  rollout_active_grace_period?: number;
  [key: string]: unknown;
}

/** `PATCH /containers/applications/{id}` body: a subset of the create body, without name and namespace. */
export type ModifyContainerApplicationArgs = Partial<
  Omit<CreateContainerApplicationArgs, "name" | "durable_objects">
>;

/**
 * `POST /containers/applications/{id}/rollouts` body, as wrangler sends it:
 * `step_percentage` (5, 10, 20, 25, 50 or 100) or explicit `steps`.
 */
export interface CreateContainerRolloutArgs {
  description: string;
  strategy: "rolling";
  kind?: "full_auto" | "full_manual";
  target_configuration: ContainerApplicationConfiguration;
  step_percentage?: number;
  steps?: Array<{ step_size: { percentage: number }; description: string }>;
}

/** A rollout (wrangler 4.136.2's `ApplicationRollout`, the fields Appflare reads). */
export interface ContainerRollout {
  id: string;
  /** `pending`, `progressing`, `completed`, `reverted` or `replaced`. */
  status?: string;
  target_configuration?: ContainerApplicationConfiguration;
  health?: { instances?: ContainerHealthInstances };
  [key: string]: unknown;
}

/** One entry of `GET /workers/durable_objects/namespaces`. */
export interface DurableObjectNamespace {
  id: string;
  name?: string;
  /** The Worker that implements the class. */
  script?: string;
  class?: string;
  use_sqlite?: boolean;
}
