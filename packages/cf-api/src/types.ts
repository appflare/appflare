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
  /**
   * The script's tag, as the upload answered it ({@link ScriptUploadResult.tag}):
   * what an Access `worker` destination names the Worker by.
   */
  tag?: string;
}

export interface ScriptUploadResult {
  id: string;
  etag?: string;
  startup_time_ms?: number;
  /** The new version id (wrangler reads it as the "Current Version ID"); may lack hyphens. */
  deployment_id?: string | null;
  /**
   * The script's tag: what an Access `worker` destination names the Worker
   * by (`worker_id`).
   */
  tag?: string;
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

/** `GET` and `PUT /workflows/{name}` (fields the manager reads). */
export interface WorkflowInfo {
  id: string;
  name: string;
  class_name?: string;
  script_name?: string;
  /**
   * The cron triggers that start an instance (`GET` only); absent when the
   * Workflow has none. The other settings of a `PUT` are not returned.
   */
  schedules?: Array<{ cron: string; next_instance?: string }>;
}

/**
 * A Workflow's retention of finished instances: milliseconds, or a duration
 * string such as `"3 days"` (wrangler's `default_retention` fields).
 */
export interface WorkflowRetention {
  success_retention?: number | string;
  error_retention?: number | string;
}

/**
 * `PUT /workflows/{name}` body, as wrangler 4.136.2 sends it after a deploy
 * (`triggersDeploy`): the script and class that run the Workflow, and the
 * settings the Worker's config gives it, each only when set.
 */
export interface WorkflowPutBody {
  script_name: string;
  class_name: string;
  limits?: { steps?: number };
  concurrency?: { limit?: number };
  /**
   * Cron triggers that start an instance; Workers Paid only, though an
   * empty list, which says the Workflow has none, is taken on Workers Free.
   */
  schedules?: Array<{ cron: string }>;
  default_retention?: WorkflowRetention;
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
 * rule kinds Appflare writes are typed; others pass through when read back
 * (and may be written through the last, untyped member).
 */
export type AccessRule =
  /** One email address (matched case-insensitively by Access). */
  | { email: { email: string } }
  /** Anyone at all; used with `bypass`, or with `allow` behind a login. */
  | { everyone: Record<string, never> }
  /** One service token, by its `id` (not its `client_id`); for `non_identity` policies. */
  | { service_token: { token_id: string } }
  /** Any service token of the account; for `non_identity` policies. */
  | { any_valid_service_token: Record<string, never> }
  | Record<string, unknown>;

/**
 * What an Access application's policy decides for a matching request.
 * `non_identity` lets requests through without a sign-in when they match a
 * rule that is not a person (a service token), so it only makes sense with
 * `service_token` or `any_valid_service_token` rules.
 */
export type AccessDecision = "allow" | "deny" | "bypass" | "non_identity";

/**
 * A hostname Access protects, optionally with a path. `uri` is `host` or
 * `host/path`; a path ending in `/*` covers everything under it
 * (`host/open/*` covers `/open/x` but not `/opener`) and only on that host.
 * A hostname no Worker serves yet is accepted and protected from its first
 * request.
 */
export interface AccessPublicDestination {
  type: "public";
  uri: string;
}

/**
 * Every address of one Worker: its workers.dev URL, every version preview URL
 * (including ones created later) and its Workers custom domains. `worker_id`
 * is the script's `tag` from the upload answer ({@link ScriptUploadResult.tag}),
 * not its name.
 */
export interface AccessWorkerDestination {
  type: "worker";
  worker_id: string;
}

/** A destination Appflare writes: a hostname (and path) or a Worker. */
export type AccessDestination = AccessPublicDestination | AccessWorkerDestination;

/**
 * Any other kind of destination an application read back may carry
 * (`private` networks, …), kept verbatim. Check `type` and the field
 * before reading one, or use `accessAppCoverage`.
 */
export interface AccessOtherDestination {
  type: string;
  [key: string]: unknown;
}

/**
 * A reusable (account-level) policy attached to an application by id.
 * `precedence` orders the application's policies, 1 first.
 */
export interface AccessPolicyReference {
  id: string;
  precedence?: number;
}

/**
 * One entry of an application's `policies` when creating or updating it:
 * a reusable policy by id, or a policy written inline, which then belongs to
 * that application alone.
 */
export type AccessAppPolicyArgs = AccessPolicyReference | AccessPolicyArgs;

interface AccessAppArgsBase {
  type: "self_hosted";
  name: string;
  /** How long a sign-in lasts, e.g. `24h`. */
  session_duration?: string;
  app_launcher_visible?: boolean;
  /**
   * The application's policies, in any order (`precedence` decides). Left out
   * of a `PUT`, the application keeps the policies it has.
   */
  policies?: AccessAppPolicyArgs[];
  [key: string]: unknown;
}

/**
 * Body of `POST /access/apps` (and `PUT /access/apps/{id}`) for a
 * self-hosted application: either one `domain`, or `destinations` covering
 * several hostnames, paths and Workers at once. An application created from
 * `destinations` answers `domain: null`.
 */
export type CreateAccessAppArgs = AccessAppArgsBase &
  (
    | {
        /** Hostname, optionally with a path (`host/api/health`), that Access protects. */
        domain: string;
        destinations?: AccessDestination[];
      }
    | { domain?: string; destinations: AccessDestination[] }
  );

export interface AccessApp {
  id: string;
  /**
   * The application audience tag: the `aud` claim of its JWTs. Kept when the
   * application is replaced with `PUT` (destinations changed included).
   */
  aud: string;
  name?: string;
  /** The single protected `host[/path]`; `null` for an application created from `destinations`. */
  domain?: string | null;
  /** Every `host[/path]` it protects, the older way Cloudflare lists them. */
  self_hosted_domains?: string[];
  /** Every destination it protects, as written (plus kinds Appflare does not write). */
  destinations?: Array<AccessDestination | AccessOtherDestination>;
  type?: string;
  session_duration?: string;
  /** The application's policies, as `GET` and `PUT /access/apps/{id}` answer them. */
  policies?: Array<{ id: string; name?: string; decision?: string; precedence?: number }>;
}

/**
 * Body of `POST`/`PUT /access/policies[/{id}]`: a reusable policy, which any
 * number of applications reference by id.
 */
export interface AccessReusablePolicyArgs {
  name: string;
  decision: AccessDecision;
  /** A request matches when it matches at least one rule. */
  include: AccessRule[];
  exclude?: AccessRule[];
  /** A request must also match every one of these. */
  require?: AccessRule[];
  session_duration?: string;
  [key: string]: unknown;
}

/** Body of `POST`/`PUT /access/apps/{id}/policies[/{policy_id}]`, or an inline app policy. */
export interface AccessPolicyArgs extends AccessReusablePolicyArgs {
  precedence?: number;
}

export interface AccessPolicy {
  id: string;
  name?: string;
  decision?: string;
  include?: AccessRule[];
  precedence?: number;
}

/** A reusable policy as `/access/policies` answers it (fields read). */
export interface AccessReusablePolicy extends AccessPolicy {
  exclude?: AccessRule[];
  require?: AccessRule[];
  /** Always true for a policy from `/access/policies`. */
  reusable?: boolean;
  /** How many applications reference it (in list and `PUT` answers). */
  app_count?: number;
  session_duration?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * An Access service token (`/access/service_tokens`). A request carrying
 * `CF-Access-Client-Id: <client_id>` and `CF-Access-Client-Secret: <secret>`
 * passes a `non_identity` policy that names the token, and the Worker behind
 * it still receives a `Cf-Access-Jwt-Assertion`.
 */
export interface AccessServiceToken {
  id: string;
  name: string;
  client_id: string;
  /** How long it stays valid from creation or refresh, e.g. `8760h`. */
  duration?: string;
  expires_at?: string;
  created_at?: string;
  updated_at?: string;
  last_seen_at?: string;
}

/**
 * A service token as created or rotated: the only answers that carry
 * `client_secret`. Store it at once; it cannot be read again.
 */
export interface AccessServiceTokenWithSecret extends AccessServiceToken {
  client_secret: string;
}

/** Body of `POST /access/service_tokens`. */
export interface CreateAccessServiceTokenArgs {
  name: string;
  /** Validity, e.g. `8760h` (Cloudflare's default) or `forever`. */
  duration?: string;
  [key: string]: unknown;
}

/**
 * What an Access application protects, from {@link AccessApp.domain},
 * {@link AccessApp.self_hosted_domains} and its `public` destinations.
 */
export interface AccessAppCoverage {
  /**
   * Every `host` or `host/path`, host lower-cased, paths as written,
   * deduplicated, in the order Cloudflare lists them.
   */
  uris: string[];
  /** The hostnames of `uris`, deduplicated. */
  hostnames: string[];
  /**
   * The script tags of its `worker` destinations. Each covers that Worker's
   * workers.dev URL, its preview URLs and its custom domains, which the
   * application itself does not list.
   */
  workerIds: string[];
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
