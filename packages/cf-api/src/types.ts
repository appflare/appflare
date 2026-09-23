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
  [key: string]: unknown;
}

/** Metadata JSON part of a `POST /workers/scripts/{name}/versions` upload. */
export interface VersionMetadata extends ScriptMetadata {
  /** e.g. `{ "workers/message": "...", "workers/tag": "..." }`. */
  annotations?: Record<string, string>;
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

export interface WorkerDeployment {
  id: string;
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

export interface AccessApp {
  id: string;
  aud?: string;
  name?: string;
  domain?: string;
}

export interface AccessPolicy {
  id: string;
  name?: string;
  decision?: string;
}

/** `GET /accounts/{id}/access/certs` — Access JWT-verification material. */
export interface AccessCerts {
  keys?: unknown[];
  public_cert?: { kid: string; cert: string };
  public_certs?: Array<{ kid: string; cert: string }>;
}
