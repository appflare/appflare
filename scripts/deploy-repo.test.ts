import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VerifiedArtifact } from "@appflare/cli";
import { pack, parseJsonc } from "@appflare/pack";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siteUrl } from "../apps/docs/src/lib/shared.ts";
import {
  buildDeployRepo,
  DEPLOY_BUTTON_URL,
  deployButtonUrl,
  deployRepoPackageJson,
  deployRepoProblems,
  deployRepoReadme,
  deployRepoWranglerConfig,
  docsPage,
  parseDeployRepository,
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

  it("links the documentation on the docs site's own address", () => {
    const readme = deployRepoReadme("1.2.3");
    expect(docsPage("start", "deploy-button")).toBe(`${siteUrl}/start/deploy-button/`);
    expect(readme).toContain(`(${siteUrl}/start/deploy-button/)`);
    expect(readme).toContain(`(${siteUrl}/start/install/)`);
    const docsLinks = readme.match(/\]\((https:\/\/[^)]+)\)/g) ?? [];
    for (const link of docsLinks.filter((l) => !/github\.com|cloudflare\.com/.test(l))) {
      expect(link).toContain(siteUrl);
    }
  });

  it("points the README's button at another repository when asked", () => {
    expect(DEPLOY_BUTTON_URL).toBe(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/appflare/deploy",
    );
    const readme = deployRepoReadme("1.2.3", { repository: "someone/appflare-deploy-trial" });
    expect(readme).toContain(
      "(https://deploy.workers.cloudflare.com/?url=https://github.com/someone/appflare-deploy-trial)",
    );
    expect(readme).not.toContain(`(${DEPLOY_BUTTON_URL})`);
    expect(deployButtonUrl("a/b")).toBe(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/a/b",
    );
  });

  it("accepts only owner/name for --repo", () => {
    expect(parseDeployRepository(" MendyLanda/deploy-trial.v2 ")).toBe(
      "MendyLanda/deploy-trial.v2",
    );
    for (const bad of [
      "",
      "deploy",
      "a/b/c",
      "https://github.com/a/b",
      "-owner/name",
      "owner/",
      "owner/..",
      "owner/na me",
      "owner/name?x=1",
    ]) {
      expect(() => parseDeployRepository(bad), bad).toThrow(/owner\/name/);
    }
  });

  it("refuses a bad repository before reading the release or writing anything", async () => {
    const out = path.join(tmpdir(), `deploy-repo-never-${process.pid}`);
    await expect(
      buildDeployRepo({ artifactDir: "/nonexistent", outDir: out, repository: "not a repo" }),
    ).rejects.toThrow(/owner\/name/);
    expect(existsSync(out)).toBe(false);
  });
});

/**
 * The push job's `deploy_repo_action` shell function, as written in
 * release.yml: the job checks out nothing from this repository, so the
 * decision lives in the workflow and is tested from there.
 */
function runDeployRepoAction(current: string, next: string, reset: boolean) {
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "release.yml"),
    "utf8",
  ).split("\n");
  const start = workflow.findIndex((line) => /^\s*deploy_repo_action\(\) \{$/.test(line));
  expect(start, "deploy_repo_action is not defined in release.yml").toBeGreaterThanOrEqual(0);
  const indent = (workflow[start] ?? "").match(/^\s*/)?.[0] ?? "";
  const end = workflow.indexOf(`${indent}}`, start);
  expect(end).toBeGreaterThan(start);
  const fn = workflow
    .slice(start, end + 1)
    .map((line) => line.slice(indent.length))
    .join("\n");
  return spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `${fn}\ndeploy_repo_action "$1" "$2" "$3"`,
      "bash",
      current,
      next,
      String(reset),
    ],
    { encoding: "utf8" },
  );
}

function deployRepoAction(current: string, next: string, reset: boolean): string {
  const res = runDeployRepoAction(current, next, reset);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.trim();
}

describe("the push job's version decision", () => {
  it("pushes to an empty repository, or over an older version", () => {
    expect(deployRepoAction("", "0.1.0", false)).toBe("push");
    expect(deployRepoAction("1.2.3", "1.2.4", false)).toBe("push");
    expect(deployRepoAction("1.9.0", "1.10.0", false)).toBe("push");
    expect(deployRepoAction("1.2.3", "2.0.0", true)).toBe("push");
  });

  it("leaves the same or a newer version alone", () => {
    expect(deployRepoAction("1.2.3", "1.2.3", false)).toBe("skip");
    expect(deployRepoAction("1.10.0", "1.9.0", false)).toBe("skip");
    expect(deployRepoAction("0.4.2", "0.1.0", false)).toBe("skip");
  });

  it("replaces the same or a newer version only when a reset is asked for", () => {
    expect(deployRepoAction("0.4.2", "0.1.0", true)).toBe("reset");
    expect(deployRepoAction("0.1.0", "0.1.0", true)).toBe("reset");
    expect(deployRepoAction("0.1.0", "0.1.0-rc.1", true)).toBe("reset");
    expect(deployRepoAction("0.1.1", "0.1.0", true)).toBe("reset");
  });

  it("ranks versions by semantic versioning precedence", () => {
    // A release ranks above its own pre-releases (sort -V says otherwise).
    expect(deployRepoAction("0.1.0-rc.1", "0.1.0", false)).toBe("push");
    expect(deployRepoAction("0.1.0-rc.1", "0.1.0-rc.2", false)).toBe("push");
    expect(deployRepoAction("0.1.0", "0.1.0-rc.1", false)).toBe("skip");
    expect(deployRepoAction("0.1.0", "0.2.0", false)).toBe("push");
    expect(deployRepoAction("0.1.1", "0.1.0", false)).toBe("skip");
    // Numeric identifiers compare as numbers, below words; more identifiers
    // rank above fewer; build metadata does not count.
    expect(deployRepoAction("1.0.0-rc.9", "1.0.0-rc.10", false)).toBe("push");
    expect(deployRepoAction("1.0.0-alpha", "1.0.0-alpha.1", false)).toBe("push");
    expect(deployRepoAction("1.0.0-alpha.1", "1.0.0-alpha.beta", false)).toBe("push");
    expect(deployRepoAction("1.0.0-beta", "1.0.0-alpha", false)).toBe("skip");
    expect(deployRepoAction("1.0.0-rc.1", "1.0.0-rc.1", false)).toBe("skip");
    expect(deployRepoAction("1.0.0+a", "1.0.0+b", false)).toBe("skip");
    expect(deployRepoAction("0.9.0", "0.10.0-rc.1", false)).toBe("push");
    expect(deployRepoAction("99999999999999999999.0.0", "100000000000000000000.0.0", false)).toBe(
      "push",
    );
  });

  it("follows the precedence order of the semantic versioning specification", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (const [i, lower] of ordered.entries()) {
      for (const higher of ordered.slice(i + 1)) {
        expect(deployRepoAction(lower, higher, false), `${higher} over ${lower}`).toBe("push");
        expect(deployRepoAction(higher, lower, false), `${lower} over ${higher}`).toBe("skip");
      }
    }
  });

  it("fails on a version that is not a semantic version, unless a reset replaces it", () => {
    const bad = runDeployRepoAction("0.1.0", "v0.2", false);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("'v0.2' is not a semantic version");
    const held = runDeployRepoAction("latest", "0.1.0", false);
    expect(held.status).not.toBe(0);
    expect(held.stderr).toContain("deploy_repo_reset");
    expect(deployRepoAction("latest", "0.1.0", true)).toBe("reset");
    expect(runDeployRepoAction("0.1.0", "01.2.0", true).status).not.toBe(0);
  });

  it("never resets on a push", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(workflow).toMatch(
      /RESET: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.deploy_repo_reset \}\}\n/,
    );
    expect(workflow).toMatch(/deploy_repo_reset:\n(?: {8}.*\n)*? {8}default: false\n/);
  });
});

describe.skipIf(!existsSync(MANAGER_RELEASE_WRANGLER))(
  "the deploy repository of the built manager",
  () => {
    let tmp: string;
    let releaseDir: string;
    let outDir: string;
    let version: string;
    let legacy: boolean;

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
      releaseDir = path.join(tmp, "release");
      await pack({ checkoutDir: MANAGER_DIR, manifestPath, outDir: releaseDir, install: false });
      outDir = path.join(tmp, "deploy");
      // The built manager may not declare version_metadata yet.
      const release = JSON.parse(readFileSync(MANAGER_RELEASE_WRANGLER, "utf8")) as {
        version_metadata?: { binding?: string };
      };
      legacy = typeof release.version_metadata?.binding !== "string";
      const result = await buildDeployRepo({
        artifactDir: releaseDir,
        outDir,
        allowUnsigned: true,
        allowLegacy: legacy,
        expectedVersion: version,
        lockfile: false,
        repository: "someone/appflare-deploy-trial",
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

    it("carries no absolute path from the machine that built it", () => {
      const worker = readFileSync(path.join(outDir, "worker", "index.js"), "utf8");
      expect(worker).not.toContain(REPO_ROOT);
      expect(worker).toContain('filePath: "src/routes/login.tsx"');
    });

    it("deletes a copy that contains a secret and names where it comes from", async () => {
      // A string the Worker is known to contain stands in for a leaked value.
      const leakDir = path.join(tmp, "leak");
      const result = await buildDeployRepo({
        artifactDir: releaseDir,
        outDir: leakDir,
        allowUnsigned: true,
        allowLegacy: legacy,
        lockfile: false,
        secrets: [{ source: "the value of TEST_TOKEN in .env", value: "src/routes/login.tsx" }],
      });
      expect(result.problems).toEqual([
        "worker/index.js contains the value of TEST_TOKEN in .env",
        `${leakDir} was deleted rather than kept with these values in it`,
      ]);
      expect(existsSync(leakDir)).toBe(false);
    });

    it("points the README's button at the repository it was built for", () => {
      const readme = readFileSync(path.join(outDir, "README.md"), "utf8");
      expect(readme).toContain(deployButtonUrl("someone/appflare-deploy-trial"));
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
