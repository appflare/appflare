/**
 * `@appflare/cf-api`: a thin, typed, runtime-agnostic client over the Cloudflare
 * REST API for the endpoints Appflare uses, and Cloudflare OAuth for a public
 * client. Entry `.` is safe in Workers and Node; the Node-only
 * `loadDevContext` lives at the `./dev` subpath, and `./oauth` carries the
 * OAuth module alone for browser bundles.
 */

export type { AssetManifestFile, AssetUploadManifest } from "./asset-hash";
export { assetHash, buildAssetsManifest } from "./asset-hash";
export type {
  AccessServiceTokensCapability,
  AccountCapabilities,
  AccountSetupCapabilities,
  AnalyticsEngineCapability,
  CapabilityClient,
  CapabilityProbe,
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
  ANALYTICS_ENGINE_NOT_ENABLED_CODE,
  ANALYTICS_ENGINE_PROBE_QUERY,
  CONTAINERS_PROBE_NAME,
  createCapabilityClient,
  detectedWorkersPlan,
  failureDetail,
  probeAccessServiceTokens,
  probeAccountCapabilities,
  probeAccountSetup,
  probeAnalyticsEngine,
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
  ACCESS_SERVICE_TOKEN_IN_USE,
  AccessCertsError,
  accessAppCoverage,
  accessCertsUrl,
  fetchAccessCerts,
  isAccessTeamDomain,
  isServiceTokenInUse,
} from "./namespaces/access";
export type {
  AnalyticsEngineSqlColumn,
  AnalyticsEngineSqlResult,
} from "./namespaces/analytics-engine";
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
  UpdateEmailRoutingRuleArgs,
} from "./namespaces/email-routing";
export { EmailRoutingShapeError } from "./namespaces/email-routing";
export type {
  CreateHyperdriveConfigArgs,
  HyperdriveConfig,
  HyperdriveOriginInput,
  PatchHyperdriveConfigArgs,
} from "./namespaces/hyperdrive";
export type {
  CreateCatalogSinkArgs,
  CreatePipelineArgs,
  CreateStreamArgs,
  Pipeline,
  PipelineSink,
  PipelineStream,
  R2DataCatalogSinkConfig,
  StreamSchemaField,
} from "./namespaces/pipelines";
export type { CreateBucketArgs } from "./namespaces/r2";
export { isAddressableObjectKey } from "./namespaces/r2";
export type { CatalogMaintenanceUpdate, R2Catalog } from "./namespaces/r2-catalog";
export { R2_CATALOG_NOT_FOUND_CODE } from "./namespaces/r2-catalog";
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
export {
  isWorkflowCronPaidOnly,
  isWorkflowNotFound,
  WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE,
  WORKFLOW_NOT_FOUND_CODE,
} from "./namespaces/workflows";
export type {
  CreateDnsRecordArgs,
  DnsRecord,
  ListZonesArgs,
  WorkerRoute,
  Zone,
  ZoneStatus,
} from "./namespaces/zones";
export type {
  AuthorizationUrlArgs,
  CloudflareOAuthErrorInit,
  ExchangeCodeArgs,
  ManagerOAuthGroupKey,
  OAuthOperation,
  OAuthRequestOptions,
  OAuthState,
  OAuthTokens,
  Pkce,
  RefreshedTokens,
  RefreshGrantArgs,
  RevokeTokenArgs,
} from "./oauth";
export {
  APPFLARE_OAUTH_CALLBACK_URL,
  authorizationUrl,
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  CLOUDFLARE_OAUTH_REVOKE_URL,
  CLOUDFLARE_OAUTH_TOKEN_URL,
  CloudflareOAuthError,
  createOAuthState,
  createPkce,
  decodeOAuthState,
  encodeOAuthState,
  exchangeCode,
  isOAuthRelayOrigin,
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPE_BY_GROUP,
  MANAGER_OAUTH_SCOPES,
  MANAGER_OAUTH_SCOPES_BY_PROBE,
  missingManagerScopes,
  OAUTH_INVALID_RESPONSE,
  OAUTH_NETWORK_ERROR,
  OFFLINE_ACCESS_SCOPE,
  pkceChallenge,
  refreshGrant,
  revokeToken,
  signInCanProbe,
} from "./oauth";

export type * from "./types";
