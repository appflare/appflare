import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type PackResult, parseJsonc } from "@appflare/pack";
import { accountSpecificIds, REPO_ROOT, zipEntryNames } from "./manager-release.ts";

// Schema-validated by `appflare-pack verify`, which release-pack.ts runs first.
type ArtifactManifest = PackResult["manifest"];

/**
 * The sandbox Worker's release artifact (docs/RELEASING.md): the deploy config
 * it is packed from, and what the packed artifact must look like. Used by
 * scripts/release-pack.ts (`--app sandbox`) and scripts/sandbox-release.test.ts.
 *
 * The sandbox Worker is released as `sandbox@<version>` with the assets
 * `appflare-sandbox-<version>.zip`, `manifest.json`, and `manifest.sig`;
 * `appflare sandbox enable` deploys it from them. Its container image,
 * `docker.io/mendylanda/appflare-sandbox:<version>`, is built from the same tag by
 * .github/workflows/sandbox-image.yml.
 */

export const SANDBOX_APP = "appflare-sandbox";
export const SANDBOX_DIR = path.join(REPO_ROOT, "apps", "sandbox");
export const SANDBOX_CATALOG_MANIFEST = path.join(SANDBOX_DIR, "appflare.jsonc");
export const SANDBOX_WRANGLER_SOURCE = path.join(SANDBOX_DIR, "wrangler.jsonc");
/** What apps/sandbox/appflare.jsonc names as its wrangler config; written at pack time. */
export const SANDBOX_RELEASE_WRANGLER = path.join(SANDBOX_DIR, "dist", "wrangler.release.json");

interface ContainerConfig {
  class_name: string;
  image: string;
  [key: string]: unknown;
}

/**
 * apps/sandbox/wrangler.jsonc as the release packs it, written to
 * SANDBOX_RELEASE_WRANGLER: no account id, `main` relative to dist/, and the
 * release version as APPFLARE_VERSION and as every container's image tag (the
 * image repository stays the one wrangler.jsonc names).
 */
export function sandboxReleaseWranglerConfig(
  jsoncText: string,
  version: string,
): Record<string, unknown> {
  const config = parseJsonc(jsoncText) as Record<string, unknown> | null;
  if (typeof config !== "object" || config === null) {
    throw new Error("apps/sandbox/wrangler.jsonc is not an object");
  }
  const { account_id: _accountId, $schema: _schema, ...rest } = config;
  const main = rest.main;
  if (typeof main !== "string") {
    throw new Error("apps/sandbox/wrangler.jsonc has no main");
  }
  const containers = rest.containers as ContainerConfig[] | undefined;
  if (!Array.isArray(containers) || containers.length === 0) {
    throw new Error("apps/sandbox/wrangler.jsonc has no containers");
  }
  return {
    ...rest,
    main: path.posix.join("..", main),
    containers: containers.map((c) => ({
      ...c,
      image: c.image.replace(/:[^:/@]+$/, `:${version}`),
    })),
    vars: { ...(rest.vars as Record<string, unknown> | undefined), APPFLARE_VERSION: version },
  };
}

export interface SandboxArtifactExpectations {
  version: string;
  sha: string;
  keyId: string;
}

/** Binding fields that would carry an account-specific id. */
const ID_FIELDS = ["id", "account_id", "namespace_id", "bucket_name"];

/**
 * Checks a sandbox Worker artifact manifest and its zip entry list; returns every
 * problem found (empty = OK): identity and source, `nodejs_compat`, the two
 * Sandbox Durable Object classes with their SQLite migration, the BUILDS
 * bucket without its name, APPFLARE_VERSION, the version metadata binding
 * the manager reads the answering version from, no assets, crons, or D1
 * migrations, no account-specific id, and a zip holding exactly the listed
 * files.
 */
export function sandboxArtifactProblems(
  manifest: ArtifactManifest,
  manifestText: string,
  zipNames: string[],
  expected: SandboxArtifactExpectations,
  forbiddenIds: string[],
): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  expect(manifest.app === SANDBOX_APP, `app is "${manifest.app}", expected "${SANDBOX_APP}"`);
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
  expect(worker.name === SANDBOX_APP, `worker.name is "${worker.name}"`);
  expect(worker.mainModule === "index.js", `worker.mainModule is "${worker.mainModule}"`);
  expect(worker.modules.length > 0, "the Worker has no modules");
  for (const module of worker.modules) {
    expect(/\.m?js$/.test(module.name), `unexpected worker module ${module.name}`);
  }
  expect(
    worker.compatibilityFlags.includes("nodejs_compat"),
    "compatibility flag nodejs_compat is missing",
  );
  expect(worker.crons.length === 0, `crons are ${JSON.stringify(worker.crons)}`);

  const binding = (type: string, name: string) =>
    worker.bindings.find((b) => b.type === type && b.name === name) as
      | Record<string, unknown>
      | undefined;
  for (const className of ["Sandbox", "LargeSandbox"]) {
    expect(
      binding("durable_object_namespace", className)?.class_name === className,
      `durable object binding ${className} is missing`,
    );
  }
  expect(binding("r2_bucket", "BUILDS") !== undefined, "r2_bucket binding BUILDS is missing");
  const version = binding("plain_text", "APPFLARE_VERSION");
  expect(
    version?.text === expected.version,
    `APPFLARE_VERSION is ${JSON.stringify(version?.text)}, expected "${expected.version}"`,
  );
  expect(
    binding("version_metadata", "CF_VERSION_METADATA") !== undefined,
    "version_metadata binding CF_VERSION_METADATA is missing",
  );
  for (const b of worker.bindings) {
    for (const field of ID_FIELDS) {
      expect(!(field in b), `binding ${b.name} carries ${field}`);
    }
  }
  const sqliteClasses = worker.migrations.flatMap((m) =>
    Array.isArray(m.new_sqlite_classes) ? (m.new_sqlite_classes as unknown[]) : [],
  );
  for (const className of ["Sandbox", "LargeSandbox"]) {
    expect(
      sqliteClasses.includes(className),
      `no migration creates ${className} as a SQLite class`,
    );
  }

  expect(manifest.assets.files.length === 0, "the sandbox Worker artifact carries static assets");
  expect(
    Object.keys(manifest.d1Migrations).length === 0,
    "the sandbox Worker artifact carries D1 migrations",
  );
  for (const id of forbiddenIds) {
    expect(!manifestText.includes(id), "manifest.json contains an account-specific id");
  }

  const listed = new Set<string>([...worker.modules.map((m) => m.path), "manifest.json"]);
  for (const name of zipNames) {
    expect(listed.has(name), `zip entry ${name} is not listed in manifest.json`);
  }
  expect(zipNames.length === listed.size, "zip entries and manifest.json listings differ");
  expect(zipNames.at(-1) === "manifest.json", "manifest.json is not the last zip entry");
  return problems;
}

/**
 * Reads `<dir>/manifest.json` and its zip and runs {@link sandboxArtifactProblems}.
 * Run `appflare-pack verify` on `dir` first: it validates the manifest schema.
 */
export function checkSandboxArtifactDir(
  dir: string,
  expected: SandboxArtifactExpectations,
): string[] {
  const manifestText = readFileSync(path.join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as ArtifactManifest;
  const zipPath = path.join(dir, `${manifest.app}-${manifest.version}.zip`);
  if (!existsSync(zipPath)) {
    const present = readdirSync(dir).join(", ");
    return [`${path.basename(zipPath)} not found in ${dir} (found: ${present})`];
  }
  return sandboxArtifactProblems(
    manifest,
    manifestText,
    zipEntryNames(readFileSync(zipPath)),
    expected,
    accountSpecificIds(readFileSync(SANDBOX_WRANGLER_SOURCE, "utf8")),
  );
}
