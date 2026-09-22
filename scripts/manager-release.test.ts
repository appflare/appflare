import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pack, verify } from "@appflare/pack";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountSpecificIds,
  checkManagerArtifactDir,
  MANAGER_BUILT_WRANGLER,
  MANAGER_CATALOG_MANIFEST,
  MANAGER_DIR,
  MANAGER_KEY_ID,
  MANAGER_WRANGLER_SOURCE,
  managerArtifactProblems,
  REPO_ROOT,
  stampCatalogManifest,
  zipEntryNames,
} from "./manager-release.ts";

const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("stampCatalogManifest", () => {
  const text = readFileSync(MANAGER_CATALOG_MANIFEST, "utf8");

  it("replaces the placeholder source with the release version and commit", () => {
    const stamped = stampCatalogManifest(text, { version: "1.2.3", sha: FAKE_SHA });
    expect(stamped.source).toEqual({ ref: "1.2.3", sha: FAKE_SHA });
    expect(stamped.slug).toBe("appflare");
    expect(stamped.install).toMatchObject({
      tier: "artifact",
      wranglerConfig: "dist/server/wrangler.json",
      workerName: "appflare",
    });
  });

  it("rejects a v-prefixed or non-semver version and a short sha", () => {
    expect(() => stampCatalogManifest(text, { version: "v1.2.3", sha: FAKE_SHA })).toThrow();
    expect(() => stampCatalogManifest(text, { version: "manager@1.2.3", sha: FAKE_SHA })).toThrow();
    expect(() => stampCatalogManifest(text, { version: "1.2.3", sha: "abc123" })).toThrow();
  });
});

describe("accountSpecificIds", () => {
  it("collects the pinned account, D1, and KV ids from the source wrangler.jsonc", () => {
    const ids = accountSpecificIds(readFileSync(MANAGER_WRANGLER_SOURCE, "utf8"));
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });
});

// Packs the BUILT manager (`pnpm build` or `pnpm --filter @appflare/manager build`
// first) exactly as release-pack.ts does, minus the build, and checks the result.
describe.skipIf(!existsSync(MANAGER_BUILT_WRANGLER))("the packed manager artifact", () => {
  let tmp: string;
  let outDir: string;
  let version: string;
  let sha: string;

  beforeAll(async () => {
    const built = JSON.parse(readFileSync(MANAGER_BUILT_WRANGLER, "utf8")) as {
      vars?: { APPFLARE_VERSION?: string };
    };
    version = built.vars?.APPFLARE_VERSION ?? "";
    const head = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
    sha = head.status === 0 ? head.stdout.trim() : FAKE_SHA;

    tmp = mkdtempSync(path.join(tmpdir(), "manager-release-test-"));
    const manifestPath = path.join(tmp, "appflare.json");
    const catalog = stampCatalogManifest(readFileSync(MANAGER_CATALOG_MANIFEST, "utf8"), {
      version,
      sha,
    });
    writeFileSync(manifestPath, JSON.stringify(catalog));
    outDir = path.join(tmp, "out");
    await pack({
      checkoutDir: MANAGER_DIR,
      manifestPath,
      outDir,
      install: false,
      keyId: MANAGER_KEY_ID,
    });
  });

  afterAll(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is an unsigned intermediate whose hashes verify", async () => {
    const result = await verify({ dir: outDir, hashesOnly: true });
    expect(result.keyId).toBe(MANAGER_KEY_ID);
    expect(result.signed).toBe(false);
    expect(existsSync(path.join(outDir, "manifest.sig"))).toBe(false);
  });

  it("passes every manager check", () => {
    expect(checkManagerArtifactDir(outDir, { version, sha, keyId: MANAGER_KEY_ID })).toEqual([]);
  });

  it("carries the dist/server worker, the dist/client assets, and nothing else", () => {
    const manifestText = readFileSync(path.join(outDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText) as {
      worker: { modules: Array<{ name: string }> };
      assets: { files: Array<{ route: string }> };
    };
    expect(manifest.worker.modules[0]?.name).toBe("index.js");
    const routes = manifest.assets.files.map((f) => f.route);
    expect(routes).toContain("/index.html");
    expect(routes.some((r) => r.includes(".assetsignore") || r.includes("wrangler"))).toBe(false);

    const names = zipEntryNames(readFileSync(path.join(outDir, `appflare-${version}.zip`)));
    expect(names.some((n) => n.includes(".dev.vars"))).toBe(false);
    expect(names.every((n) => /^(worker|assets|d1)\//.test(n) || n === "manifest.json")).toBe(true);
  });

  it("reports what is wrong with a tampered manifest", () => {
    const manifestText = readFileSync(path.join(outDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    manifest.worker.compatibilityFlags = ["nodejs_compat"];
    manifest.worker.bindings.push({ type: "kv_namespace", name: "EXTRA", id: "abc" });
    manifest.assets.config.not_found_handling = "none";
    const names = zipEntryNames(readFileSync(path.join(outDir, `appflare-${version}.zip`)));
    const problems = managerArtifactProblems(
      manifest,
      `${manifestText}"leaked-id"`,
      [...names.slice(0, -1), "dist/server/.dev.vars", "manifest.json"],
      { version, sha, keyId: "unsigned" },
      ["leaked-id"],
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'keyId is "appflare-2026-09", expected "unsigned"',
        "compatibility flag global_fetch_strictly_public is missing",
        "binding EXTRA carries id",
        'assets not_found_handling is "none"',
        "manifest.json contains an account-specific id",
        "zip entry dist/server/.dev.vars is not listed in manifest.json",
        "zip entry dist/server/.dev.vars must not ship",
      ]),
    );
  });
});
