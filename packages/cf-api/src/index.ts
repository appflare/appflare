/**
 * `@appflare/cf-api`: a thin, typed, runtime-agnostic client over the Cloudflare
 * REST API for the endpoints Appflare uses. Entry `.` is safe in Workers and
 * Node; the Node-only `loadDevContext` lives at the `./dev` subpath.
 */

export type { AssetManifestFile, AssetUploadManifest } from "./asset-hash";
export { assetHash, buildAssetsManifest } from "./asset-hash";
export type { CloudflareClient } from "./client";
export { createClient } from "./client";
export type { CloudflareApiErrorInit, CloudflareError } from "./errors";
export { CloudflareApiError } from "./errors";
export type {
  ClientOptions,
  CloudflareEnvelope,
  FetchLike,
  RequestLog,
  ResultInfo,
} from "./http";
export { CLOUDFLARE_API_BASE } from "./http";
export type { WorkerModule, WorkerModuleType } from "./modules";
export { buildUploadFormData, MODULE_CONTENT_TYPES } from "./modules";

export {
  AccessCertsError,
  accessCertsUrl,
  fetchAccessCerts,
  isAccessTeamDomain,
} from "./namespaces/access";
export type {
  AssetBucketFile,
  AssetBucketResult,
} from "./namespaces/assets";
export type { RestoreArgs } from "./namespaces/d1";
export type { CreateBucketArgs } from "./namespaces/r2";
export { isAddressableObjectKey } from "./namespaces/r2";
export type {
  CreateVectorizeIndexArgs,
  VectorizeConfig,
} from "./namespaces/vectorize";
export type {
  CreateDeploymentArgs,
  UploadVersionArgs,
} from "./namespaces/versions";
export type {
  AttachWorkerDomainArgs,
  ListWorkerDomainsArgs,
  WorkerDomain,
} from "./namespaces/worker-domains";
export { DOMAIN_DNS_RECORD_CONFLICT, DOMAIN_ORIGIN_CONFLICT } from "./namespaces/worker-domains";
export type {
  EnableSubdomainArgs,
  PutSecretArgs,
  UploadScriptArgs,
} from "./namespaces/workers";

export type {
  DnsRecord,
  ListZonesArgs,
  WorkerRoute,
  Zone,
  ZoneStatus,
} from "./namespaces/zones";

export type * from "./types";
