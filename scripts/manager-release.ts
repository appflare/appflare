import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_WORKER_MODULES, type PackResult, parseJsonc } from "@appflare/pack";

// The root package depends on @appflare/pack only; its bundled schema types are
// reached through PackResult. Runtime validation of both manifests is the
// packer's job (`appflare-pack` and `appflare-pack verify` parse them with
// @appflare/schema), and release-pack.ts runs `verify` before these checks.
type ArtifactManifest = PackResult["manifest"];

/**
 * The manager's own release artifact (docs/RELEASING.md): how its
 * catalog manifest is stamped for a release, and what the packed artifact must look
 * like. Used by scripts/release-pack.ts on every release build and by
 * scripts/manager-release.test.ts against the built manager.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANAGER_DIR = path.join(REPO_ROOT, "apps", "manager");
export const MANAGER_CATALOG_MANIFEST = path.join(MANAGER_DIR, "appflare.jsonc");
export const MANAGER_WRANGLER_SOURCE = path.join(MANAGER_DIR, "wrangler.jsonc");
/** The Cloudflare Vite plugin's generated deploy config. */
export const MANAGER_BUILT_WRANGLER = path.join(MANAGER_DIR, "dist", "server", "wrangler.json");
/**
 * The deploy config a release is packed from: the generated one without the
 * Worker's service binding to itself. `pnpm --filter @appflare/manager build`
 * writes it (apps/manager/scripts/release-wrangler-config.mjs), and
 * apps/manager/appflare.jsonc names it, so every pack of the manager uses it.
 */
export const MANAGER_RELEASE_WRANGLER = path.join(
  MANAGER_DIR,
  "dist",
  "server",
  "wrangler.release.json",
);

/** The key id manager releases are signed with (packages/schema/src/keys.ts). */
export const MANAGER_KEY_ID = "appflare-2026-09";

/**
 * A release version: semver without a leading `v`. The packer derives the artifact
 * version from `source.ref` when it is a semver tag, so stamping `ref` with this
 * string makes `manifest.version` equal it exactly.
 */
const RELEASE_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version);
}

/**
 * The committed apps/manager/appflare.jsonc with its placeholder `source`
 * replaced: `ref` = the release version (the release tag is `manager@<version>`,
 * which is not a semver ref, so the bare version is recorded), `sha` = the commit
 * being built.
 */
export function stampCatalogManifest(
  jsoncText: string,
  release: { version: string; sha: string },
): Record<string, unknown> {
  if (!isReleaseVersion(release.version)) {
    throw new Error(`"${release.version}" is not a release version (semver without a leading v)`);
  }
  if (!/^[0-9a-f]{40}$/.test(release.sha)) {
    throw new Error(`"${release.sha}" is not a 40-character commit SHA`);
  }
  const parsed = parseJsonc(jsoncText) as Record<string, unknown> | null;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.source !== "object") {
    throw new Error("the catalog manifest has no source block");
  }
  return { ...parsed, source: { ref: release.version, sha: release.sha } };
}

/** Names of every entry in a zip's central directory (classic, non-ZIP64). */
export function zipEntryNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("not a zip: end-of-central-directory record not found");
  }
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error(`corrupt zip: bad central directory header at ${at}`);
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    names.push(decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** Account-specific values in the manager's source wrangler.jsonc that must never ship. */
export function accountSpecificIds(wranglerJsoncText: string): string[] {
  const config = parseJsonc(wranglerJsoncText) as {
    account_id?: string;
    d1_databases?: Array<{ database_id?: string }>;
    kv_namespaces?: Array<{ id?: string; preview_id?: string }>;
  };
  const ids = [
    config.account_id,
    ...(config.d1_databases ?? []).map((d) => d.database_id),
    ...(config.kv_namespaces ?? []).flatMap((k) => [k.id, k.preview_id]),
  ];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export interface ManagerArtifactExpectations {
  version: string;
  sha: string;
  /** `manifest.keyId`: the release key id, or "unsigned" for a local build. */
  keyId: string;
}

/**
 * The most Worker modules a manager release may have. The manager updates
 * itself by Range-fetching every module from the release zip for one version
 * upload, inside one Workflow invocation, and the free plan caps that
 * invocation's subrequests; Appflare can upload at most MAX_WORKER_MODULES.
 * apps/manager/vite.config.ts builds the server as one module, so this is
 * well above what a correct build emits and far below a code-split build
 * (84 chunks), which could never be installed by a self-update.
 */
export const MANAGER_MAX_MODULES = 8;

const REQUIRED_FLAGS = ["nodejs_compat", "global_fetch_strictly_public"];
const REQUIRED_RUN_WORKER_FIRST = ["/api/*", "/_serverFn/*"];
/** Binding fields that would carry an account-specific id. */
const ID_FIELDS = ["id", "account_id", "database_id", "namespace_id", "preview_id", "bucket_name"];

/**
 * Checks a manager artifact manifest and its zip entry list. Returns every
 * problem found (empty = OK): identity and source, at most MANAGER_MAX_MODULES
 * Worker modules, both compatibility flags,
 * the DB/KV/JOBS/APPFLARE_VERSION bindings without ids, the cron, the SPA assets
 * config, no account-specific id anywhere in manifest.json, and a zip that holds
 * exactly the listed worker modules, assets, D1 migrations, and manifest.json
 * (so nothing else from dist/, such as dist/server/.dev.vars, can ship).
 */
export function managerArtifactProblems(
  manifest: ArtifactManifest,
  manifestText: string,
  zipNames: string[],
  expected: ManagerArtifactExpectations,
  forbiddenIds: string[],
): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string): void => {
    if (!ok) {
      problems.push(message);
    }
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  expect(manifest.app === "appflare", `app is "${manifest.app}", expected "appflare"`);
  expect(
    manifest.version === expected.version,
    `version is "${manifest.version}", expected "${expected.version}"`,
  );
  expect(
    manifest.keyId === expected.keyId,
    `keyId is "${manifest.keyId}", expected "${expected.keyId}"`,
  );
  expect(
    same(manifest.source, { repo: "appflare/appflare", sha: expected.sha, ref: expected.version }),
    `source is ${JSON.stringify(manifest.source)}`,
  );

  const worker = manifest.worker;
  expect(worker.name === "appflare", `worker.name is "${worker.name}"`);
  expect(worker.mainModule === "index.js", `worker.mainModule is "${worker.mainModule}"`);
  expect(worker.modules[0]?.name === "index.js", "the first module is not index.js");
  for (const module of worker.modules) {
    expect(/\.m?js$/.test(module.name), `unexpected worker module ${module.name}`);
  }
  expect(
    worker.modules.length <= MANAGER_MAX_MODULES,
    `the Worker has ${worker.modules.length} modules; a manager release may have at most ${MANAGER_MAX_MODULES}. A self-update fetches every module for one upload within the free plan's subrequest limit (at most ${MAX_WORKER_MODULES} modules), so a code-split server build can never be installed. Check that apps/manager/vite.config.ts still builds the server as one module.`,
  );
  for (const flag of REQUIRED_FLAGS) {
    expect(worker.compatibilityFlags.includes(flag), `compatibility flag ${flag} is missing`);
  }
  expect(same(worker.crons, ["*/30 * * * *"]), `crons are ${JSON.stringify(worker.crons)}`);

  const binding = (type: string, name: string) =>
    worker.bindings.find((b) => b.type === type && b.name === name) as
      | Record<string, unknown>
      | undefined;
  expect(binding("d1", "DB") !== undefined, "d1 binding DB is missing");
  expect(binding("kv_namespace", "KV") !== undefined, "kv_namespace binding KV is missing");
  const jobs = binding("workflow", "JOBS");
  expect(
    jobs?.workflow_name === "appflare-jobs" && jobs?.class_name === "JobWorkflow",
    `workflow binding JOBS is ${JSON.stringify(jobs)}`,
  );
  const version = binding("plain_text", "APPFLARE_VERSION");
  expect(
    version?.text === expected.version,
    `APPFLARE_VERSION is ${JSON.stringify(version?.text)}, expected "${expected.version}"`,
  );
  expect(
    !worker.bindings.some((b) => b.type === "service"),
    "the manifest declares a service binding; the SELF binding is added at install and self-update time, and managers before job units refuse a service binding",
  );
  for (const b of worker.bindings) {
    for (const field of ID_FIELDS) {
      expect(!(field in b), `binding ${b.name} carries ${field}`);
    }
  }

  const assets = manifest.assets;
  expect(assets.binding === "ASSETS", `assets.binding is ${JSON.stringify(assets.binding)}`);
  expect(
    assets.config.not_found_handling === "single-page-application",
    `assets not_found_handling is ${JSON.stringify(assets.config.not_found_handling)}`,
  );
  expect(
    same(assets.config.run_worker_first, REQUIRED_RUN_WORKER_FIRST),
    `assets run_worker_first is ${JSON.stringify(assets.config.run_worker_first)}`,
  );
  expect(
    assets.files.some((f) => f.route === "/index.html"),
    "the SPA shell /index.html is not among the assets",
  );

  for (const id of forbiddenIds) {
    expect(!manifestText.includes(id), "manifest.json contains an account-specific id");
  }

  const listed = new Set<string>([
    ...worker.modules.map((m) => m.path),
    ...assets.files.map((f) => f.path),
    ...Object.values(manifest.d1Migrations)
      .flat()
      .map((f) => f.path),
    "manifest.json",
  ]);
  for (const name of zipNames) {
    expect(listed.has(name), `zip entry ${name} is not listed in manifest.json`);
    expect(
      !/(^|\/)(\.dev\.vars|\.env|wrangler\.jsonc?)$/.test(name),
      `zip entry ${name} must not ship`,
    );
  }
  expect(zipNames.length === listed.size, "zip entries and manifest.json listings differ");
  expect(zipNames.at(-1) === "manifest.json", "manifest.json is not the last zip entry");
  return problems;
}

/**
 * Reads `<dir>/manifest.json` and its zip and runs {@link managerArtifactProblems}.
 * Run `appflare-pack verify` on `dir` first: it validates the manifest schema.
 */
export function checkManagerArtifactDir(
  dir: string,
  expected: ManagerArtifactExpectations,
): string[] {
  const manifestText = readFileSync(path.join(dir, "manifest.json"), "utf8");
  // Schema-validated by `appflare-pack verify`, which runs first.
  const manifest = JSON.parse(manifestText) as ArtifactManifest;
  const zipPath = path.join(dir, `${manifest.app}-${manifest.version}.zip`);
  if (!existsSync(zipPath)) {
    const present = readdirSync(dir).join(", ");
    return [`${path.basename(zipPath)} not found in ${dir} (found: ${present})`];
  }
  return managerArtifactProblems(
    manifest,
    manifestText,
    zipEntryNames(readFileSync(zipPath)),
    expected,
    accountSpecificIds(readFileSync(MANAGER_WRANGLER_SOURCE, "utf8")),
  );
}
