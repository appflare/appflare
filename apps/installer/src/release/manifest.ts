import {
  type ArtifactManifest,
  artifactD1Files,
  artifactManifestSchema,
  type SigningKey,
  unknownArtifactFormatProblem,
  verifyManifestSignature,
  workerUploadProblem,
} from "@appflare/schema";
import { ReleaseError, sha256Hex } from "./fetch";
import type { ReleaseFileRef } from "./reader";

/** `manifest.app` of every Appflare release. */
export const MANAGER_APP = "appflare";

/**
 * The bindings an Appflare release may declare, and the one resource each of
 * the first three needs. Anything else means the release is newer than this
 * installer.
 */
export const RESOURCE_BINDINGS = ["d1", "kv_namespace", "workflow"] as const;
const PLAIN_BINDINGS: ReadonlySet<string> = new Set(["version_metadata", "plain_text", "json"]);

/** Vars the installer sets on the manager; a release may not set them itself. */
export const INSTALLER_ORIGIN_VAR = "APPFLARE_INSTALLER_ORIGIN";
export const INSTALL_SOURCE_VAR = "APPFLARE_INSTALL_SOURCE";
/** The one secret the installer sets: `v1.<sha256 hex of the handoff secret>`. */
export const HANDOFF_SECRET = "APPFLARE_HANDOFF";
/** The manager's service binding to itself, which the manager adds on its own. */
const SELF_BINDING = "SELF";

export interface VerifiedManifest {
  manifest: ArtifactManifest;
  /** The exact bytes, as text: what the installation record keeps. */
  text: string;
  digest: string;
  keyId: string;
}

/**
 * Checks `manifest.json` against `manifest.sig` with `keys` (the key is
 * picked by the manifest's own `keyId`; unknown ids and `unsigned` are
 * refused), requires a key id starting with `keyIdPrefix` (Appflare's
 * releases are signed by `appflare-*` keys, never a catalog key), then the
 * schema, the app and, when given, the version. Throws `ReleaseError`.
 */
export async function verifyReleaseManifest(
  bytes: Uint8Array,
  signature: string,
  opts: { keys: readonly SigningKey[]; keyIdPrefix: string; expectedVersion?: string },
): Promise<VerifiedManifest> {
  let keyId: string;
  try {
    ({ keyId } = await verifyManifestSignature(bytes, signature.trim(), opts.keys));
  } catch (error) {
    throw new ReleaseError(
      "signature",
      `the release signature does not check out (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!keyId.startsWith(opts.keyIdPrefix)) {
    throw new ReleaseError(
      "signature",
      `the release is signed with "${keyId}", which does not sign Appflare`,
    );
  }
  const text = new TextDecoder().decode(bytes);
  const manifest = parseManifestText(text);
  if (opts.expectedVersion !== undefined && manifest.version !== opts.expectedVersion) {
    throw new ReleaseError(
      "manifest",
      `the release is ${opts.expectedVersion} but its manifest says ${manifest.version}`,
    );
  }
  return { manifest, text, digest: await sha256Hex(bytes), keyId };
}

function parseManifestText(text: string): ArtifactManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReleaseError("manifest", "the release manifest is not JSON");
  }
  const format = unknownArtifactFormatProblem(json);
  if (format !== null) throw new ReleaseError("format", format);
  const parsed = artifactManifestSchema.safeParse(json);
  if (!parsed.success) throw new ReleaseError("manifest", "the release manifest is not valid");
  if (parsed.data.app !== MANAGER_APP) {
    throw new ReleaseError("manifest", `the release is "${parsed.data.app}", not Appflare`);
  }
  return parsed.data;
}

/**
 * The manifest an installation record keeps, after checking it is still
 * the exact text whose signature was verified.
 */
export async function storedManifest(text: string, digest: string): Promise<ArtifactManifest> {
  if ((await sha256Hex(new TextEncoder().encode(text))) !== digest) {
    throw new ReleaseError("manifest", "the stored release manifest does not match its digest");
  }
  return parseManifestText(text);
}

/**
 * Why this installer cannot deploy `manifest` as it is, or null. A release
 * that needs more than one Worker, Durable Objects, settings or bindings
 * this installer does not create is refused before anything is created.
 */
export function deployProblem(manifest: ArtifactManifest): string | null {
  const { worker } = manifest;
  if (worker.mainModule === undefined) return "the release has no Worker code";
  if (manifest.workers !== undefined) return "the release has several Workers";
  if (worker.migrations.length > 0 || (worker.exports && Object.keys(worker.exports).length > 0)) {
    return "the release declares Durable Objects";
  }
  if (worker.queueConsumers.length > 0) return "the release consumes queues";
  if (worker.workflowSettings !== undefined) return "the release has Workflow settings";
  const counts = new Map<string, number>();
  for (const binding of worker.bindings) {
    const type = binding.type;
    if (binding.name === SELF_BINDING && type === "service") continue;
    if ((RESOURCE_BINDINGS as readonly string[]).includes(type)) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
      if (type === "workflow" && typeof binding.script_name === "string") {
        return "the release runs a Workflow of another Worker";
      }
      continue;
    }
    if (!PLAIN_BINDINGS.has(type)) return `the release has a ${type} binding`;
    if (binding.name === INSTALLER_ORIGIN_VAR || binding.name === INSTALL_SOURCE_VAR) {
      return `the release sets ${binding.name} itself`;
    }
  }
  for (const type of RESOURCE_BINDINGS) {
    if (counts.get(type) !== 1)
      return `the release needs ${counts.get(type) ?? 0} ${type} bindings`;
  }
  if (!worker.bindings.some((b) => b.type === "version_metadata")) {
    return "the release has no version metadata binding";
  }
  return workerUploadProblem(worker.modules, "The release");
}

/** Every file of the release: modules, static assets and D1 SQL. */
export function releaseFiles(manifest: ArtifactManifest): ReleaseFileRef[] {
  return [...manifest.worker.modules, ...manifest.assets.files, ...artifactD1Files(manifest)];
}
