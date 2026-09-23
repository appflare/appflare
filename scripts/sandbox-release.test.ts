import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pack, verify } from "@appflare/pack";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, stampCatalogManifest, zipEntryNames } from "./manager-release.ts";
import {
  checkSandboxArtifactDir,
  SANDBOX_CATALOG_MANIFEST,
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
      ["Sandbox", `docker.io/appflare/sandbox:${VERSION}`, "standard-1"],
      ["LargeSandbox", `docker.io/appflare/sandbox:${VERSION}`, "standard-2"],
    ]);
  });

  it("stamps the sandbox Worker's catalog manifest like the manager's", () => {
    const stamped = stampCatalogManifest(readFileSync(SANDBOX_CATALOG_MANIFEST, "utf8"), {
      version: VERSION,
      sha: FAKE_SHA,
    });
    expect(stamped).toMatchObject({
      slug: "appflare-sandbox",
      source: { ref: VERSION, sha: FAKE_SHA },
      install: { wranglerConfig: "dist/wrangler.release.json", workerName: "appflare-sandbox" },
    });
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
    await pack({ checkoutDir: SANDBOX_DIR, manifestPath, outDir, install: false });
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
      .filter((b: { name: string }) => b.name !== "LargeSandbox")
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
        "binding BUILDS carries bucket_name",
        "no migration creates Sandbox as a SQLite class",
        "zip entry wrangler.jsonc is not listed in manifest.json",
      ]),
    );
  });
});
