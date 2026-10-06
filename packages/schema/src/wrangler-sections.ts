/**
 * The sections of a wrangler config the packer does not carry into the
 * artifact, each with the words the manager shows for it. An app that relies
 * on one would run without it, so the packer refuses a config that declares
 * any of them, and the manager refuses a build from a repository whose config
 * does. A catalog entry may drop one with its config patch (`"<key>": null`)
 * when the app works without it.
 *
 * `containers` is refused like the rest: Appflare cannot install a
 * container application yet. Appflare's own sandbox Worker declares it, and
 * its release is packed with an explicit allowance (the packer's
 * `allowSections`), because the manager deploys those containers itself;
 * catalog entries are never packed with one.
 *
 * `pipelines` and `unsafe` are listed, and the packer still reads them:
 * a Pipelines stream is carried only when the catalog manifest describes it
 * (`resources.pipelines`), which a repository has no place for, and only the
 * rate limits among `unsafe.bindings` are carried.
 *
 * `mtls_certificates` is refused like the rest: a certificate is uploaded to
 * one account, with its private key, and an artifact cannot bring one, so
 * an app that binds one can only be installed without it.
 *
 * Bindings the packer cannot record as written (a service binding to
 * another Worker, a Hyperdrive binding the catalog manifest does not
 * declare) are refused by the packer and the install plan instead.
 *
 * This module imports nothing: the catalog manifest's schema uses it, and the
 * JSON Schema export runs that schema under Node's type stripping.
 */
export const UNSUPPORTED_WRANGLER_SECTION_LABELS = {
  containers: "Containers",
  cloudchamber: "Containers (cloudchamber)",
  dispatch_namespaces: "dispatch namespaces (Workers for Platforms)",
  mtls_certificates: "mTLS certificates",
  tail_consumers: "Tail Workers",
  streaming_tail_consumers: "streaming Tail Workers",
  logfwdr: "log forwarding bindings",
  pipelines: "Pipelines",
  secrets_store_secrets: "Secrets Store secrets",
  unsafe: "unsafe bindings",
  vpc_services: "Workers VPC services",
  vpc_networks: "Workers VPC networks",
  ai_search_namespaces: "AI Search namespaces",
  ai_search: "AI Search instances",
  agent_memory: "Agent Memory namespaces",
  media: "Media Transformations",
  stream: "Stream",
  artifacts: "Artifacts",
  flagship: "Flagship feature flags",
  unsafe_hello_world: "the example Hello World binding",
  connect: "raw TCP sockets (connect)",
  addresses: "inbound email addresses",
  site: "Workers Sites",
  pages_build_output_dir: "a Pages project",
  wasm_modules: "service-worker WebAssembly modules",
  text_blobs: "service-worker text blobs",
  data_blobs: "service-worker data blobs",
} as const satisfies Readonly<Record<string, string>>;

/** A wrangler config section the packer refuses; see {@link UNSUPPORTED_WRANGLER_SECTION_LABELS}. */
export type UnsupportedWranglerSection = keyof typeof UNSUPPORTED_WRANGLER_SECTION_LABELS;

/** The keys of {@link UNSUPPORTED_WRANGLER_SECTION_LABELS}, in its order. */
export const UNSUPPORTED_WRANGLER_SECTIONS = Object.keys(
  UNSUPPORTED_WRANGLER_SECTION_LABELS,
) as readonly UnsupportedWranglerSection[];

/** Whether `key` is a wrangler config section the packer refuses. */
export function isUnsupportedWranglerSection(key: string): key is UnsupportedWranglerSection {
  return Object.hasOwn(UNSUPPORTED_WRANGLER_SECTION_LABELS, key);
}
