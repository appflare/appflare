import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VerifiedArtifact } from "@appflare/cli";
import { pack, parseJsonc } from "@appflare/pack";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDeployRepo,
  DEPLOY_BUTTON_URL,
  deployRepoPackageJson,
  deployRepoProblems,
  deployRepoReadme,
  deployRepoWranglerConfig,
  renderWranglerJsonc,
  repoWranglerVersion,
} from "./deploy-repo.ts";
import {
  MANAGER_BUILT_WRANGLER,
  MANAGER_CATALOG_MANIFEST,
  MANAGER_DIR,
  MANAGER_RELEASE_WRANGLER,
  REPO_ROOT,
  stampCatalogManifest,
} from "./manager-release.ts";

type ArtifactManifest = VerifiedArtifact["manifest"];

/** The parts of a manager release manifest the config is built from. */
function manifest(bindings: Array<Record<string, unknown>>): ArtifactManifest {
  return {
    version: "1.2.3",
    worker: {
      name: "appflare",
      mainModule: "index.js",
      compatibilityDate: "2026-09-21",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      modules: [{ name: "index.js", type: "esm" }],
      bindings,
      migrations: [],
      crons: ["*/30 * * * *"],
      observability: { enabled: true },
      placement: null,
      limits: null,
    },
    assets: {
      binding: "ASSETS",
      config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
      files: [],
    },
  } as unknown as ArtifactManifest;
}

const RELEASE_BINDINGS = [
  { type: "kv_namespace", name: "KV" },
  { type: "d1", name: "DB" },
  { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs", class_name: "JobWorkflow" },
  { type: "plain_text", name: "APPFLARE_VERSION", text: "1.2.3" },
  { type: "version_metadata", name: "CF_VERSION_METADATA" },
];

/** A release from before token-first setup: no version_metadata binding. */
const LEGACY_BINDINGS = RELEASE_BINDINGS.filter((b) => b.type !== "version_metadata");

describe("deployRepoWranglerConfig", () => {
  const config = deployRepoWranglerConfig(manifest(RELEASE_BINDINGS));

  it("declares D1 and KV without ids, the Workflow, assets, the cron, and the version", () => {
    expect(config).toMatchObject({
      name: "appflare",
      main: "worker/index.js",
      no_bundle: true,
      base_dir: "worker",
      rules: [{ type: "ESModule", globs: ["index.js"] }],
      d1_databases: [{ binding: "DB", database_name: "appflare" }],
      kv_namespaces: [{ binding: "KV" }],
      workflows: [{ binding: "JOBS", name: "appflare-jobs", class_name: "JobWorkflow" }],
      assets: {
        binding: "ASSETS",
        directory: "assets",
        not_found_handling: "single-page-application",
        run_worker_first: ["/api/*"],
      },
      triggers: { crons: ["*/30 * * * *"] },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      vars: { APPFLARE_VERSION: "1.2.3", APPFLARE_INSTALL_SOURCE: "deploy-button" },
      preview_urls: true,
      send_metrics: false,
    });
  });

  it("has no account id, no SELF or other service binding, and no secrets", () => {
    expect(config).not.toHaveProperty("account_id");
    expect(config).not.toHaveProperty("services");
    expect(JSON.stringify(config)).not.toMatch(/database_id|"id"|SECRET|TOKEN/);
  });

  it("keeps the release's own version_metadata binding", () => {
    const own = deployRepoWranglerConfig(
      manifest([...LEGACY_BINDINGS, { type: "version_metadata", name: "VERSION" }]),
    );
    expect(own.version_metadata).toEqual({ binding: "VERSION" });
  });

  it("refuses a release that predates token-first setup, unless told to allow it", () => {
    expect(() => deployRepoWranglerConfig(manifest(LEGACY_BINDINGS))).toThrow(
      /no version_metadata binding: the release predates token-first setup/,
    );
    expect(
      deployRepoWranglerConfig(manifest(LEGACY_BINDINGS), { allowLegacy: true }).version_metadata,
    ).toEqual({ binding: "CF_VERSION_METADATA" });
  });

  it("refuses bindings the button cannot provision", () => {
    expect(() =>
      deployRepoWranglerConfig(
        manifest([...RELEASE_BINDINGS, { type: "service", name: "SELF", service: "appflare" }]),
      ),
    ).toThrow(/service binding \(SELF\)/);
    expect(() =>
      deployRepoWranglerConfig(manifest([...RELEASE_BINDINGS, { type: "r2_bucket", name: "B" }])),
    ).toThrow(/r2_bucket/);
    expect(() => deployRepoWranglerConfig(manifest(RELEASE_BINDINGS.slice(0, 1)))).toThrow(
      /0 D1 bindings/,
    );
  });

  it("renders as commented JSONC that parses back to the same config", () => {
    const text = renderWranglerJsonc(config, "1.2.3");
    expect(parseJsonc(text)).toEqual(config);
    expect(text).toContain("// No SELF service binding here");
    expect(text).toContain("No secrets are declared");
  });
});

describe("the deploy repository's npm project", () => {
  it("deploys with the pinned wrangler, without building", () => {
    const pkg = deployRepoPackageJson({ version: "1.2.3", wranglerVersion: repoWranglerVersion() });
    expect(pkg).toMatchObject({
      version: "1.2.3",
      private: true,
      packageManager: expect.stringMatching(/^npm@\d+\.\d+\.\d+$/),
      scripts: { deploy: "wrangler deploy" },
      devDependencies: { wrangler: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
    });
    expect(pkg).not.toHaveProperty("dependencies");
    expect(pkg.scripts).not.toHaveProperty("build");
  });

  it("has a README with the button and the three steps", () => {
    const readme = deployRepoReadme("1.2.3");
    expect(readme).toContain(`(${DEPLOY_BUTTON_URL})`);
    expect(readme).toContain("https://deploy.workers.cloudflare.com/button");
    expect(readme).toMatch(
      /1\. \*\*Deploy\.\*\*[\s\S]*2\. \*\*Set up\.\*\*[\s\S]*3\. \*\*Clean up\.\*\*/,
    );
    expect(readme).toContain("manager@1.2.3");
  });
});

describe.skipIf(!existsSync(MANAGER_RELEASE_WRANGLER))(
  "the deploy repository of the built manager",
  () => {
    let tmp: string;
    let outDir: string;
    let version: string;

    beforeAll(async () => {
      const built = JSON.parse(readFileSync(MANAGER_BUILT_WRANGLER, "utf8")) as {
        vars?: { APPFLARE_VERSION?: string };
      };
      version = built.vars?.APPFLARE_VERSION ?? "";
      tmp = mkdtempSync(path.join(tmpdir(), "deploy-repo-test-"));
      const manifestPath = path.join(tmp, "appflare.json");
      const catalog = stampCatalogManifest(readFileSync(MANAGER_CATALOG_MANIFEST, "utf8"), {
        version,
        sha: "0123456789abcdef0123456789abcdef01234567",
      });
      writeFileSync(manifestPath, JSON.stringify(catalog));
      const releaseDir = path.join(tmp, "release");
      await pack({ checkoutDir: MANAGER_DIR, manifestPath, outDir: releaseDir, install: false });
      outDir = path.join(tmp, "deploy");
      // The built manager may not declare version_metadata yet.
      const release = JSON.parse(readFileSync(MANAGER_RELEASE_WRANGLER, "utf8")) as {
        version_metadata?: { binding?: string };
      };
      const legacy = typeof release.version_metadata?.binding !== "string";
      const result = await buildDeployRepo({
        artifactDir: releaseDir,
        outDir,
        allowUnsigned: true,
        allowLegacy: legacy,
        expectedVersion: version,
        lockfile: false,
      });
      expect(result.problems).toEqual([]);
    });

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it("holds the built Worker and client assets byte for byte", () => {
      expect(readFileSync(path.join(outDir, "worker", "index.js"))).toEqual(
        readFileSync(path.join(MANAGER_DIR, "dist", "server", "index.js")),
      );
      expect(readFileSync(path.join(outDir, "assets", "index.html"))).toEqual(
        readFileSync(path.join(MANAGER_DIR, "dist", "client", "index.html")),
      );
      expect(existsSync(path.join(outDir, "assets", ".dev.vars"))).toBe(false);
      expect(existsSync(path.join(outDir, ".dev.vars.example"))).toBe(false);
    });

    it("names the release's version in the config and package.json", () => {
      const config = parseJsonc(readFileSync(path.join(outDir, "wrangler.jsonc"), "utf8")) as {
        vars: Record<string, string>;
      };
      expect(config.vars.APPFLARE_VERSION).toBe(version);
      const pkg = JSON.parse(readFileSync(path.join(outDir, "package.json"), "utf8")) as {
        version: string;
      };
      expect(pkg.version).toBe(version);
    });

    it("reports a repository that would prompt for secrets or build", () => {
      writeFileSync(path.join(outDir, ".dev.vars.example"), "BETTER_AUTH_SECRET=change-me\n");
      expect(deployRepoProblems(outDir, { lockfile: false })).toEqual([
        ".dev.vars.example must not exist: the button would prompt for its entries",
      ]);
      rmSync(path.join(outDir, ".dev.vars.example"));
      expect(deployRepoProblems(outDir, { lockfile: true })).toEqual([
        "package-lock.json is missing",
      ]);
    });

    it("is accepted by `wrangler deploy --dry-run`", () => {
      const env: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (!/^(CLOUDFLARE_|CF_API_)/.test(name)) env[name] = value;
      }
      env.WRANGLER_SEND_METRICS = "false";
      const wrangler = path.join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
      const res = spawnSync(
        process.execPath,
        [wrangler, "deploy", "--dry-run", "--outdir", path.join(tmp, "dry-run")],
        { cwd: outDir, env, encoding: "utf8" },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("env.CF_VERSION_METADATA");
      expect(res.stdout).toContain('env.APPFLARE_INSTALL_SOURCE ("deploy-button")');
      expect(res.stdout).not.toContain("SELF");
    });
  },
);
