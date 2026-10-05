import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectBindings,
  pack,
  type ResolvedWranglerConfig,
  readCatalogManifest,
  UnsupportedSectionError,
  unsupportedWranglerSections,
  verify,
} from "@appflare/pack";
import { SANDBOX_CONTAINERS } from "@appflare/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, stampCatalogManifest, zipEntryNames } from "./manager-release.ts";
import {
  checkSandboxArtifactDir,
  SANDBOX_ALLOWED_SECTIONS,
  SANDBOX_CATALOG_MANIFEST,
  SANDBOX_CONTAINER_CLASSES,
  SANDBOX_DIR,
  SANDBOX_RELEASE_WRANGLER,
  SANDBOX_WRANGLER_SOURCE,
  sandboxArtifactProblems,
  sandboxReleaseWranglerConfig,
} from "./sandbox-release.ts";

const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "1.2.3";

describe("sandboxReleaseWranglerConfig", () => {
  const source = readFileSync(SANDBOX_WRANGLER_SOURCE, "utf8");

  it("stamps the version into APPFLARE_VERSION and every image tag, and drops the account", () => {
    const config = sandboxReleaseWranglerConfig(source, VERSION) as {
      account_id?: string;
      main: string;
      vars: Record<string, string>;
      containers: Array<{ class_name: string; image: string; instance_type: string }>;
    };
    expect(config.account_id).toBeUndefined();
    expect(config.main).toBe("../src/index.ts");
    expect(config.vars.APPFLARE_VERSION).toBe(VERSION);
    expect(config.containers.map((c) => [c.class_name, c.image, c.instance_type])).toEqual([
      ["Sandbox", `docker.io/mendylanda/appflare-sandbox:${VERSION}`, "standard-1"],
      ["LargeSandbox", `docker.io/mendylanda/appflare-sandbox:${VERSION}`, "standard-2"],
      ["SelfDeployingSandbox", `docker.io/mendylanda/appflare-sandbox:${VERSION}`, "standard-1"],
      [
        "LargeSelfDeployingSandbox",
        `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
        "standard-2",
      ],
    ]);
  });

  it("declares the container classes the manager deploys, each with a binding and a migration", () => {
    const config = sandboxReleaseWranglerConfig(
      readFileSync(SANDBOX_WRANGLER_SOURCE, "utf8"),
      VERSION,
    ) as {
      containers: Array<Record<string, unknown>>;
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
    };
    // The manager creates the container applications from SANDBOX_CONTAINERS,
    // never from this config, so the two must say the same.
    expect(
      config.containers.map(({ name, class_name, instance_type, max_instances }) => ({
        name,
        class_name,
        instance_type,
        max_instances,
      })),
    ).toEqual(
      SANDBOX_CONTAINERS.map(({ name, class_name, instance_type, max_instances }) => ({
        name,
        class_name,
        instance_type,
        max_instances,
      })),
    );
    expect(SANDBOX_CONTAINER_CLASSES).toEqual(SANDBOX_CONTAINERS.map((c) => c.class_name));
    expect(config.durable_objects.bindings).toEqual(
      SANDBOX_CONTAINER_CLASSES.map((c) => ({ name: c, class_name: c })),
    );
    // Deployed sandbox Workers are at v1; migrations are only ever appended.
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["Sandbox", "LargeSandbox"] },
      { tag: "v2", new_sqlite_classes: ["SelfDeployingSandbox", "LargeSelfDeployingSandbox"] },
    ]);
  });

  it("stamps the sandbox Worker's catalog manifest like the manager's", () => {
    const stamped = stampCatalogManifest(readFileSync(SANDBOX_CATALOG_MANIFEST, "utf8"), {
      version: VERSION,
      sha: FAKE_SHA,
    });
    // As the packer reads it: strictly, defaults filled in.
    const manifest = readCatalogManifest(JSON.stringify(stamped));
    expect(manifest).toMatchObject({
      slug: "appflare-sandbox",
      source: { ref: VERSION, sha: FAKE_SHA },
      install: { wranglerConfig: "dist/wrangler.release.json", fixedWorkerName: true },
    });
    // The Worker name defaults to the slug.
    expect(manifest.install.workerName ?? manifest.slug).toBe("appflare-sandbox");
  });

  it("allows exactly the refused sections the release config declares", () => {
    const config = sandboxReleaseWranglerConfig(
      readFileSync(SANDBOX_WRANGLER_SOURCE, "utf8"),
      VERSION,
    ) as ResolvedWranglerConfig;
    // A section the sandbox Worker gains must be allowed here on purpose,
    // and an allowance it no longer needs dropped.
    expect(unsupportedWranglerSections(config)).toEqual(SANDBOX_ALLOWED_SECTIONS);
    expect(() => collectBindings(config)).toThrow(UnsupportedSectionError);
    expect(() =>
      collectBindings(config, undefined, { allowSections: SANDBOX_ALLOWED_SECTIONS }),
    ).not.toThrow();
  });
});

// Packs apps/sandbox exactly as `pnpm release:pack --app sandbox` does. The
// packer bundles the Worker with `wrangler deploy --dry-run`, which resolves
// @appflare/schema through its dist/ (run `pnpm build` first; CI does).
const schemaBuilt = existsSync(path.join(REPO_ROOT, "packages", "schema", "dist", "index.js"));

describe.skipIf(!schemaBuilt)("the packed sandbox Worker artifact", () => {
  let tmp: string;
  let outDir: string;

  beforeAll(async () => {
    mkdirSync(path.dirname(SANDBOX_RELEASE_WRANGLER), { recursive: true });
    writeFileSync(
      SANDBOX_RELEASE_WRANGLER,
      JSON.stringify(
        sandboxReleaseWranglerConfig(readFileSync(SANDBOX_WRANGLER_SOURCE, "utf8"), VERSION),
      ),
    );
    tmp = mkdtempSync(path.join(tmpdir(), "sandbox-release-test-"));
    const manifestPath = path.join(tmp, "appflare.json");
    const catalog = stampCatalogManifest(readFileSync(SANDBOX_CATALOG_MANIFEST, "utf8"), {
      version: VERSION,
      sha: FAKE_SHA,
    });
    writeFileSync(manifestPath, JSON.stringify(catalog));
    outDir = path.join(tmp, "out");
    await pack({
      checkoutDir: SANDBOX_DIR,
      manifestPath,
      outDir,
      install: false,
      allowSections: SANDBOX_ALLOWED_SECTIONS,
    });
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("verifies and passes every sandbox Worker check", async () => {
    const result = await verify({ dir: outDir, hashesOnly: true });
    expect(result.signed).toBe(false);
    expect(
      checkSandboxArtifactDir(outDir, { version: VERSION, sha: FAKE_SHA, keyId: "unsigned" }),
    ).toEqual([]);
    expect(existsSync(path.join(outDir, `appflare-sandbox-${VERSION}.zip`))).toBe(true);
  });

  it("reports what is wrong with a tampered manifest", () => {
    const manifestText = readFileSync(path.join(outDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    manifest.worker.bindings = manifest.worker.bindings
      .filter(
        (b: { name: string }) =>
          b.name !== "LargeSandbox" &&
          b.name !== "SelfDeployingSandbox" &&
          b.name !== "CF_VERSION_METADATA",
      )
      .map((b: { type: string }) =>
        b.type === "r2_bucket" ? { ...b, bucket_name: "appflare-builds" } : b,
      );
    manifest.worker.migrations = [];
    const names = zipEntryNames(readFileSync(path.join(outDir, `appflare-sandbox-${VERSION}.zip`)));
    const problems = sandboxArtifactProblems(
      manifest,
      manifestText,
      [...names.slice(0, -1), "wrangler.jsonc", "manifest.json"],
      { version: VERSION, sha: FAKE_SHA, keyId: "appflare-2026-09" },
      [],
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'keyId is "unsigned", expected "appflare-2026-09"',
        "durable object binding LargeSandbox is missing",
        "durable object binding SelfDeployingSandbox is missing",
        "version_metadata binding CF_VERSION_METADATA is missing",
        "binding BUILDS carries bucket_name",
        "no migration creates Sandbox as a SQLite class",
        "no migration creates LargeSelfDeployingSandbox as a SQLite class",
        "zip entry wrangler.jsonc is not listed in manifest.json",
      ]),
    );
  });
});
