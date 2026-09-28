import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGER_APP, unpackArtifact, type VerifiedArtifact, verifyArtifact } from "@appflare/cli";
import { parseJsonc } from "@appflare/pack";
import { pageUrl, SITE_URL } from "../apps/docs/src/lib/shared.ts";
import { findSecrets, repoSecrets, type Secret } from "./deploy-repo-guard.ts";

/**
 * The public deploy repository (`appflare/deploy`) that the "Deploy to
 * Cloudflare" button deploys from, generated from one signed manager release.
 * Nothing in it is built: the Worker modules and static assets are the
 * release's own files, unpacked and hash-checked, and `wrangler deploy`
 * uploads them as they are.
 *
 * What the button needs from it, and why each file looks the way it does:
 *
 * - The button copies the repository into the visitor's GitHub or GitLab
 *   account and runs Workers Builds on the copy: `npm clean-install`, then
 *   the `deploy` script. Workers Builds picks Bun when there is no lockfile,
 *   so the repository ships `package-lock.json` and `packageManager: npm`,
 *   with wrangler pinned to a published version.
 * - No build step (no `build` script): the Worker is prebuilt.
 * - D1 and KV are declared without ids. The dashboard creates both before the
 *   first build (D1 named after `database_name`, KV after the project) and
 *   writes their ids into the copy.
 * - No `SELF` service binding. It would name the Worker itself, and the
 *   button lets the visitor rename the project; the binding is not rewritten,
 *   so the deploy fails with a Worker-not-found error. The manager's first
 *   self-update adds it by the Worker's real name; until then jobs run their
 *   units in place.
 * - No secrets declared (no `.dev.vars.example`). The button deploys every
 *   declared secret with its example value prefilled, which would publish a
 *   shared `BETTER_AUTH_SECRET`. The manager's setup wizard generates that
 *   secret and writes it to its own Worker with the API token pasted there.
 * - `APPFLARE_INSTALL_SOURCE=deploy-button`, which the manager reads to ask
 *   an admin to disconnect Workers Builds and delete the copy: a push to the
 *   copy would redeploy the old version it holds.
 * - A `version_metadata` binding, which lets the setup wizard prove that the
 *   pasted token belongs to the account this exact Worker runs in.
 * - No D1 migrations in the deploy command: the manager migrates its own
 *   database on its first request.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The public repository the release workflow pushes the generated contents to. */
export const DEPLOY_REPOSITORY = "appflare/deploy";

/** `APPFLARE_INSTALL_SOURCE` of a manager deployed with the button. */
export const DEPLOY_BUTTON_SOURCE = "deploy-button";

/** The default names the button's form starts with. */
export const DEFAULT_WORKER_NAME = "appflare";
export const DEFAULT_DATABASE_NAME = "appflare";

/**
 * The binding the setup wizard reads the running version from. Only
 * `allowLegacy` adds it to a release that lacks one.
 */
export const VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

/**
 * npm as Workers Builds installs it by default
 * (developers.cloudflare.com/workers/ci-cd/builds/build-image/, read 2026-09-24).
 */
export const NPM_VERSION = "10.9.2";

/** Where the release's files go in the repository. */
export const WORKER_DIR = "worker";
export const ASSETS_DIR = "assets";

type ArtifactManifest = VerifiedArtifact["manifest"];
type WorkerBinding = ArtifactManifest["worker"]["bindings"][number];

/** Wrangler module rule types for the artifact's module types. */
const RULE_TYPES: Record<string, string> = {
  esm: "ESModule",
  commonjs: "CommonJS",
  text: "Text",
  data: "Data",
  "compiled-wasm": "CompiledWasm",
  python: "PythonModule",
  "python-requirement": "PythonRequirement",
};

function stringField(binding: WorkerBinding, field: string): string {
  const value = binding[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`binding ${binding.name} (${binding.type}) has no ${field}`);
  }
  return value;
}

/**
 * The deploy repository's wrangler config, from the release's artifact
 * manifest. Throws on a binding the button cannot provision, rather than
 * publishing a repository whose deploy would leave it out, and on a release
 * without a `version_metadata` binding: such a release predates token-first
 * setup, whose account check needs it, and a button deploy has no other way
 * to set the manager up. `allowLegacy` (local experiments only) adds
 * `CF_VERSION_METADATA` to such a release instead.
 */
export function deployRepoWranglerConfig(
  manifest: ArtifactManifest,
  options: { allowLegacy?: boolean } = {},
): Record<string, unknown> {
  const { worker } = manifest;
  const d1: Record<string, unknown>[] = [];
  const kv: Record<string, unknown>[] = [];
  const workflows: Record<string, unknown>[] = [];
  const vars: Record<string, unknown> = {};
  let versionMetadata: string | null = null;
  for (const binding of worker.bindings) {
    switch (binding.type) {
      case "d1":
        d1.push({ binding: binding.name, database_name: DEFAULT_DATABASE_NAME });
        break;
      case "kv_namespace":
        kv.push({ binding: binding.name });
        break;
      case "workflow": {
        const scriptName = binding.script_name;
        workflows.push({
          binding: binding.name,
          name: stringField(binding, "workflow_name"),
          class_name: stringField(binding, "class_name"),
          ...(typeof scriptName === "string" ? { script_name: scriptName } : {}),
        });
        break;
      }
      case "plain_text":
        vars[binding.name] = stringField(binding, "text");
        break;
      case "json":
        vars[binding.name] = binding.json;
        break;
      case "version_metadata":
        versionMetadata = binding.name;
        break;
      case "assets":
        break;
      default:
        throw new Error(
          `the manager release has a ${binding.type} binding (${binding.name}) the deploy repository cannot declare`,
        );
    }
  }
  if (d1.length !== 1) {
    throw new Error(
      `the manager release has ${d1.length} D1 bindings; the deploy repository needs one`,
    );
  }
  if (versionMetadata === null) {
    if (!options.allowLegacy) {
      throw new Error(
        `the manager release ${manifest.version} has no version_metadata binding: the release predates token-first setup, so a manager deployed from it could not be set up`,
      );
    }
    versionMetadata = VERSION_METADATA_BINDING;
  }
  vars.APPFLARE_INSTALL_SOURCE = DEPLOY_BUTTON_SOURCE;

  const rules = new Map<string, string[]>();
  for (const module of worker.modules) {
    const type = RULE_TYPES[module.type];
    if (type === undefined) throw new Error(`unknown module type ${module.type}`);
    rules.set(type, [...(rules.get(type) ?? []), module.name]);
  }

  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: DEFAULT_WORKER_NAME,
    main: `${WORKER_DIR}/${worker.mainModule}`,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    no_bundle: true,
    find_additional_modules: true,
    base_dir: WORKER_DIR,
    rules: [...rules].map(([type, globs]) => ({ type, globs })),
    workers_dev: true,
    preview_urls: true,
    keep_vars: true,
    send_metrics: false,
    ...(worker.observability ? { observability: { ...worker.observability } } : {}),
    d1_databases: d1,
    ...(kv.length > 0 ? { kv_namespaces: kv } : {}),
    ...(workflows.length > 0 ? { workflows } : {}),
    assets: {
      ...manifest.assets.config,
      directory: ASSETS_DIR,
      ...(manifest.assets.binding ? { binding: manifest.assets.binding } : {}),
    },
    triggers: { crons: [...worker.crons] },
    version_metadata: { binding: versionMetadata },
    vars,
    ...(worker.migrations.length > 0
      ? { migrations: worker.migrations.map((m) => ({ ...m })) }
      : {}),
    ...(worker.placement ? { placement: { ...worker.placement } } : {}),
    ...(worker.limits ? { limits: { ...worker.limits } } : {}),
  };
}

/** Comments written above top-level keys of the generated wrangler.jsonc. */
const KEY_COMMENTS: Record<string, string[]> = {
  name: [
    "The button's form starts with this name and lets you change it. One Appflare per",
    "account: the Workflow below has a fixed name, and a second deploy would take it over.",
  ],
  no_bundle: ["The Worker is prebuilt: wrangler uploads the release's modules as they are."],
  d1_databases: [
    "Created by the button before the first deploy. Appflare applies its own migrations",
    "on its first request, so the deploy command runs none.",
  ],
  kv_namespaces: ["Created by the button, named after the project."],
  workflows: [
    "Installs, updates, and uninstalls run as this Workflow.",
    "",
    "No SELF service binding here, unlike a manager installed with create-appflare. It",
    "would name this Worker, and a project renamed in the button's form keeps the old",
    "name in the binding, which fails the deploy. Appflare adds SELF by its real name",
    "at its first update; until then its jobs run every step in place.",
  ],
  assets: ["The single-page app. /api/* and server functions always reach the Worker."],
  version_metadata: [
    "Lets the setup wizard check that the API token you paste is for the account this",
    "Worker runs in.",
  ],
  vars: [
    "APPFLARE_INSTALL_SOURCE tells Appflare it was deployed with the button, so it asks",
    "you to disconnect Workers Builds and delete your copy of this repository.",
    "No secrets are declared: the setup wizard generates BETTER_AUTH_SECRET and stores",
    "it, with your API token, as encrypted secrets on this Worker.",
  ],
};

/** Renders the config as JSONC with the comments above; parses back to `config`. */
export function renderWranglerJsonc(config: Record<string, unknown>, version: string): string {
  const lines = [
    "{",
    `  // Appflare ${version}, generated from the release manager@${version} of`,
    "  // github.com/appflare/appflare. Every release replaces this repository's contents;",
    "  // do not edit it. Appflare updates itself from its own settings page.",
  ];
  const entries = Object.entries(config);
  entries.forEach(([key, value], index) => {
    for (const comment of KEY_COMMENTS[key] ?? []) {
      lines.push(comment === "" ? "  //" : `  // ${comment}`);
    }
    const json = JSON.stringify(value, null, 2).replace(/\n/g, "\n  ");
    lines.push(`  ${JSON.stringify(key)}: ${json}${index < entries.length - 1 ? "," : ""}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function deployRepoPackageJson(options: {
  version: string;
  wranglerVersion: string;
}): Record<string, unknown> {
  return {
    name: "appflare-deploy",
    version: options.version,
    private: true,
    description:
      "Deploy Appflare, a self-hosted app manager for Cloudflare, with the Deploy to Cloudflare button.",
    homepage: "https://github.com/appflare/appflare",
    license: "Apache-2.0",
    packageManager: `npm@${NPM_VERSION}`,
    scripts: {
      deploy: "wrangler deploy",
    },
    devDependencies: {
      wrangler: options.wranglerVersion,
    },
  };
}

/**
 * A documentation page's absolute URL, on the site's public address
 * (`SITE_URL`, set once in `@appflare/schema/links`).
 */
export function docsPage(...slugs: string[]): string {
  return `${SITE_URL}${pageUrl(slugs)}`;
}

/** A GitHub repository as `owner/name`, with the characters GitHub allows in each part. */
const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * The GitHub repository the README's button deploys from, checked: `owner/name`.
 * Throws on anything else, so a mistyped `--repo` never reaches a README.
 */
export function parseDeployRepository(value: string): string {
  const repository = value.trim();
  const name = repository.split("/")[1];
  if (!GITHUB_REPOSITORY.test(repository) || name === "." || name === "..") {
    throw new Error(`--repo must be a GitHub repository as owner/name, not "${value}"`);
  }
  return repository;
}

/** The Deploy to Cloudflare button's URL for a GitHub repository. */
export function deployButtonUrl(repository: string = DEPLOY_REPOSITORY): string {
  return `https://deploy.workers.cloudflare.com/?url=https://github.com/${repository}`;
}

export const DEPLOY_BUTTON_URL = deployButtonUrl();

/**
 * The deploy repository's README. `repository` is where the button points,
 * `appflare/deploy` unless a trial copy of the repository lives elsewhere.
 */
export function deployRepoReadme(version: string, options: { repository?: string } = {}): string {
  return `# Deploy Appflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${deployButtonUrl(options.repository)})

[Appflare](https://github.com/appflare/appflare) is a self-hosted app manager for
Cloudflare: one Worker in your own account that installs, updates, and removes
Cloudflare-native apps from a catalog. This repository holds the prebuilt Appflare
${version} for the Deploy to Cloudflare button. Nothing in it is built on deploy.

## Three steps

1. **Deploy.** Select the button, sign in to Cloudflare, and pick the account. Connect
   GitHub or GitLab if you have not yet, and choose a Git account: the button copies
   this repository into it, named after the project, and deploys it with Workers
   Builds. Tick **Create private Git repository**. No repository in that Git account
   may already have the project's name (the form does not warn you). Leave the two
   variables as they are and select **Create and deploy**.
2. **Set up.** When the build finishes, the deploy page shows no address: open
   \`https://<project name>.<your subdomain>.workers.dev\`, or find the Worker under
   Workers & Pages. The setup wizard asks for a Cloudflare API token first, then
   creates your admin account.
3. **Clean up.** Appflare updates itself and needs neither the copy nor Workers
   Builds. Its home page shows a card with links to disconnect Workers Builds from the
   Worker and to delete the copy. Do it: while the copy stays connected, any push to it
   deploys the old version it holds over the one Appflare has updated itself to.

## Before you deploy

- **One Appflare per account.** If the account already runs Appflare, do not deploy it
  again.
- **Cron triggers.** Appflare uses one. A free account has five in total; if all five
  are used, the deploy fails.
- **A \`workers.dev\` subdomain.** Register one in the dashboard (Workers & Pages) first
  if the account has none.

The full guide: [Deploy with the button](${docsPage("start", "deploy-button")}). Other ways
to install are listed in [Install Appflare](${docsPage("start", "install")}).

## About this repository

Generated by Appflare's release workflow from the signed release \`manager@${version}\`
and replaced on every release. Please open issues and pull requests on
[appflare/appflare](https://github.com/appflare/appflare). Appflare is not affiliated
with Cloudflare.

Licensed under the Apache License 2.0; see \`LICENSE\`.
`;
}

export const GITIGNORE = "node_modules\n.wrangler\n.dev.vars\n.env\n";

/** Files the button reads as secret declarations; the deploy repository has none. */
const SECRET_FILES = [".dev.vars.example", ".env.example", ".dev.vars", ".env"];

/**
 * What is wrong with a generated deploy repository (empty = OK): the files
 * the button needs, a wrangler config without any account-specific id,
 * `SELF` binding, or secret, and an npm project that deploys without building.
 */
export function deployRepoProblems(dir: string, options: { lockfile: boolean }): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  const file = (name: string) => path.join(dir, name);

  for (const name of ["wrangler.jsonc", "package.json", "README.md", "LICENSE", ".gitignore"]) {
    expect(existsSync(file(name)), `${name} is missing`);
  }
  if (options.lockfile)
    expect(existsSync(file("package-lock.json")), "package-lock.json is missing");
  for (const name of SECRET_FILES) {
    expect(
      !existsSync(file(name)),
      `${name} must not exist: the button would prompt for its entries`,
    );
  }
  for (const name of ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]) {
    expect(
      !existsSync(file(name)),
      `${name} must not exist: Workers Builds would use another package manager`,
    );
  }
  if (problems.length > 0) return problems;

  const text = readFileSync(file("wrangler.jsonc"), "utf8");
  const config = parseJsonc(text) as Record<string, unknown> & {
    main?: string;
    d1_databases?: Array<Record<string, unknown>>;
    kv_namespaces?: Array<Record<string, unknown>>;
    workflows?: Array<Record<string, unknown>>;
    assets?: { directory?: string };
    vars?: Record<string, unknown>;
    version_metadata?: { binding?: string };
    triggers?: { crons?: string[] };
  };
  expect(config.account_id === undefined, "wrangler.jsonc sets account_id");
  expect(
    config.services === undefined,
    "wrangler.jsonc declares service bindings (SELF must not be declared)",
  );
  expect(config.name === DEFAULT_WORKER_NAME, `name is ${JSON.stringify(config.name)}`);
  expect(
    config.d1_databases?.length === 1 &&
      config.d1_databases[0]?.database_name === DEFAULT_DATABASE_NAME &&
      config.d1_databases[0]?.database_id === undefined &&
      config.d1_databases[0]?.migrations_dir === undefined,
    "d1_databases must be one database named appflare, without an id or migrations_dir",
  );
  expect(
    (config.kv_namespaces ?? []).every((k) => k.id === undefined && k.preview_id === undefined),
    "a KV namespace carries an id",
  );
  expect(
    (config.workflows ?? []).some((w) => w.binding === "JOBS"),
    "the JOBS Workflow is not declared",
  );
  expect(
    config.vars?.APPFLARE_INSTALL_SOURCE === DEPLOY_BUTTON_SOURCE,
    "APPFLARE_INSTALL_SOURCE is not deploy-button",
  );
  expect(typeof config.vars?.APPFLARE_VERSION === "string", "APPFLARE_VERSION is not set");
  expect(typeof config.version_metadata?.binding === "string", "version_metadata is not declared");
  expect((config.triggers?.crons ?? []).length > 0, "no cron trigger");
  expect(
    typeof config.main === "string" && existsSync(file(config.main)),
    `main ${JSON.stringify(config.main)} does not exist`,
  );
  expect(
    config.assets?.directory === ASSETS_DIR &&
      existsSync(file(path.join(ASSETS_DIR, "index.html"))),
    "the assets directory has no index.html",
  );

  const pkg = JSON.parse(readFileSync(file("package.json"), "utf8")) as {
    packageManager?: string;
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: unknown;
  };
  expect(pkg.packageManager?.startsWith("npm@") === true, "packageManager is not npm");
  expect(pkg.scripts?.build === undefined, "package.json has a build script");
  expect(pkg.scripts?.deploy === "wrangler deploy", "the deploy script is not `wrangler deploy`");
  expect(
    /^\d+\.\d+\.\d+$/.test(pkg.devDependencies?.wrangler ?? ""),
    "wrangler is not pinned to an exact version",
  );
  expect(pkg.dependencies === undefined, "package.json has runtime dependencies");
  return problems;
}

/** The exact wrangler version this repository pins, for the deploy repository too. */
export function repoWranglerVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const version = pkg.devDependencies?.wrangler ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`the root package.json pins wrangler as "${version}", not an exact version`);
  }
  return version;
}

export interface BuildDeployRepoOptions {
  /** A downloaded manager release: `manifest.json`, `manifest.sig`, `appflare-<version>.zip`. */
  artifactDir: string;
  /** Where to write the repository's contents; must not exist or be empty. */
  outDir: string;
  /** Accept a release without `manifest.sig` (local builds only). */
  allowUnsigned?: boolean;
  /**
   * Accept a release without a `version_metadata` binding and add one (local
   * experiments only; see `deployRepoWranglerConfig`).
   */
  allowLegacy?: boolean;
  /** When set, the release's version must equal it. */
  expectedVersion?: string;
  /** Run `npm install --package-lock-only` to write package-lock.json (needs the npm registry). */
  lockfile?: boolean;
  /**
   * The GitHub repository (`owner/name`) the README's button deploys from,
   * when the contents are pushed somewhere other than `appflare/deploy` for a
   * trial run. Checked with `parseDeployRepository`.
   */
  repository?: string;
  /**
   * Values no file in the repository may contain. Defaults to `repoSecrets`
   * of this repository: its pinned account ids and its `.env` values.
   */
  secrets?: readonly Secret[];
}

/**
 * Verifies and unpacks the release, writes the repository, and checks it.
 * When a file contains one of the secrets, the written copy is deleted and
 * the problems name the files and where each value comes from.
 */
export async function buildDeployRepo(
  options: BuildDeployRepoOptions,
): Promise<{ version: string; problems: string[] }> {
  const outDir = path.resolve(options.outDir);
  const repository =
    options.repository === undefined
      ? DEPLOY_REPOSITORY
      : parseDeployRepository(options.repository);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} exists and is not empty`);
  }
  const { manifest, zipPath } = await verifyArtifact({
    dir: options.artifactDir,
    app: MANAGER_APP,
    ...(options.allowUnsigned ? { allowUnsigned: true } : {}),
    ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}),
  });
  // Refuses a release it cannot deploy before anything is written.
  const config = deployRepoWranglerConfig(manifest, {
    ...(options.allowLegacy ? { allowLegacy: true } : {}),
  });
  mkdirSync(outDir, { recursive: true });
  // Checks every file's sha256 against the manifest before writing any.
  const unpacked = await unpackArtifact(manifest, zipPath, outDir);
  if (
    path.basename(unpacked.workerDir) !== WORKER_DIR ||
    path.basename(unpacked.assetsDir) !== ASSETS_DIR
  ) {
    throw new Error("the release unpacked into unexpected directories");
  }

  writeFileSync(path.join(outDir, "wrangler.jsonc"), renderWranglerJsonc(config, manifest.version));
  writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(deployRepoPackageJson({ version: manifest.version, wranglerVersion: repoWranglerVersion() }), null, 2)}\n`,
  );
  writeFileSync(path.join(outDir, "README.md"), deployRepoReadme(manifest.version, { repository }));
  writeFileSync(path.join(outDir, ".gitignore"), GITIGNORE);
  copyFileSync(path.join(REPO_ROOT, "LICENSE"), path.join(outDir, "LICENSE"));

  if (options.lockfile !== false) {
    writeLockfile(outDir);
  }
  const leaks = findSecrets(outDir, options.secrets ?? repoSecrets(REPO_ROOT));
  if (leaks.length > 0) {
    rmSync(outDir, { recursive: true, force: true });
    return {
      version: manifest.version,
      problems: [...leaks, `${outDir} was deleted rather than kept with these values in it`],
    };
  }
  return {
    version: manifest.version,
    problems: deployRepoProblems(outDir, { lockfile: options.lockfile !== false }),
  };
}

/**
 * package-lock.json for the pinned wrangler, resolved from the npm registry
 * without installing anything or running any package's scripts. The deploy
 * repository is an npm project (Workers Builds installs it with npm), so this
 * one step uses npm rather than pnpm.
 */
function writeLockfile(dir: string): void {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CLOUDFLARE_|CF_API_)/.test(name) || name === "APPFLARE_SIGNING_KEY") continue;
    env[name] = value;
  }
  const res = spawnSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: dir, env, stdio: "inherit" },
  );
  if (res.error) throw new Error(`failed to run npm: ${res.error.message}`);
  if (res.status !== 0)
    throw new Error(`npm install --package-lock-only exited with ${res.status}`);
}
