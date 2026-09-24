/**
 * `@appflare/cf-api`: a thin, typed, runtime-agnostic client over the Cloudflare
 * REST API for the endpoints Appflare uses. Entry `.` is safe in Workers and
 * Node; the Node-only `loadDevContext` lives at the `./dev` subpath.
 */

export type { AssetManifestFile, AssetUploadManifest } from "./asset-hash";
export { assetHash, buildAssetsManifest } from "./asset-hash";
export type {
  AccountCapabilities,
  AccountSetupCapabilities,
  CapabilityClient,
  CapabilityUnknown,
  CapabilityUnknownReason,
  ContainersCapability,
  DomainCapabilities,
  EmailRoutingCapability,
  R2Capability,
  WorkersDevCapability,
  WorkersPlanCapability,
  ZeroTrustCapability,
  ZoneCapability,
} from "./capabilities";
export {
  CONTAINERS_PROBE_NAME,
  createCapabilityClient,
  detectedWorkersPlan,
  failureDetail,
  probeAccountCapabilities,
  probeAccountSetup,
  probeContainers,
  probeDomainCapabilities,
  probeEmailRouting,
  probeR2,
  probeWorkersDev,
  probeWorkersPlan,
  probeZeroTrust,
  R2_NOT_ENABLED_CODE,
  WORKERS_DEV_NOT_REGISTERED_CODE,
} from "./capabilities";
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
export type { SubscriptionsPage } from "./namespaces/billing";
export type {
  CreateCustomHostnameArgs,
  CustomHostname,
  CustomHostnameQuota,
  CustomHostnameSslMethod,
  FallbackOrigin,
  SslValidationRecord,
} from "./namespaces/custom-hostnames";
export {
  CUSTOM_HOSTNAME_DUPLICATE,
  CUSTOM_HOSTNAMES_NOT_ENABLED,
  FALLBACK_ORIGIN_NOT_GRANTED,
  FALLBACK_ORIGIN_NOT_SET,
} from "./namespaces/custom-hostnames";
export type { RestoreArgs } from "./namespaces/d1";
export type {
  CreateEmailRoutingRuleArgs,
  EmailRoutingAction,
  EmailRoutingAddress,
  EmailRoutingCatchAll,
  EmailRoutingDnsRecord,
  EmailRoutingMatcher,
  EmailRoutingRule,
  EmailRoutingSettings,
  EmailRoutingStatus,
  UpdateEmailRoutingCatchAllArgs,
} from "./namespaces/email-routing";
export { EmailRoutingShapeError } from "./namespaces/email-routing";
export type { CreateBucketArgs } from "./namespaces/r2";
export { isAddressableObjectKey } from "./namespaces/r2";
export type {
  CreateVectorizeIndexArgs,
  VectorizeConfig,
} from "./namespaces/vectorize";
export type {
  CreateDeploymentArgs,
  EnvBinding,
  LatestVersionPatch,
  PatchedVersion,
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
  CreateDnsRecordArgs,
  DnsRecord,
  ListZonesArgs,
  WorkerRoute,
  Zone,
  ZoneStatus,
} from "./namespaces/zones";

export type * from "./types";
