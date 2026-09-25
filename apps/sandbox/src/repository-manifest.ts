import {
  type BuildCommandChoice,
  type BuildCommandSource,
  buildCommandProblem,
  type CatalogManifest,
  type CatalogSecret,
  type CatalogVar,
  isCommitSha,
  type PackageManager,
  repositoryUrl,
  type SecretsSource,
  type WranglerFacts,
} from "@appflare/schema";

/**
 * How a repository without a catalog entry is built, worked out from its
 * checkout the way the "Deploy to Cloudflare" button does: the lockfile names
 * the package manager, the wrangler config sits at the root, `package.json`'s
 * `build` script is the build command, and `.dev.vars.example` lists the
 * secrets. The result is a catalog manifest the packer takes like any other;
 * the artifact records it. Everything here is pure, so the tests pin it.
 */

/** Lockfiles, in the order they are looked for, and the package manager each means. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Wrangler configs, in the order wrangler itself looks for them. */
export const WRANGLER_CONFIGS = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] as const;

/** Files listing the secrets, in the order the Deploy button reads them. */
const SECRET_FILES = [".dev.vars.example", ".env.example"] as const;

/**
 * The files at the root of the checkout the detection reads (besides the
 * listing). The wrangler config is read by `appflare-pack inspect`, with
 * wrangler's own reader, whatever its format.
 */
export const DETECTION_FILES = ["package.json", ...SECRET_FILES] as const;

/** A problem with the checkout: it cannot be built as it is. */
export class DetectionError extends Error {
  override name = "DetectionError";
}

/** The package manager the lockfile names; throws when there is none. */
export function detectPackageManager(files: ReadonlySet<string>): PackageManager {
  for (const [file, manager] of LOCKFILES) {
    if (files.has(file)) return manager;
  }
  throw new DetectionError(
    "the repository has no lockfile at its root (pnpm-lock.yaml, package-lock.json, yarn.lock or bun.lock); Appflare installs exactly the locked dependencies, so it cannot build a project without one",
  );
}

/** The wrangler config at the root; throws when there is none. */
export function detectWranglerConfig(files: ReadonlySet<string>): string {
  const found = WRANGLER_CONFIGS.find((name) => files.has(name));
  if (found === undefined) {
    throw new DetectionError(
      "the repository has no wrangler.json, wrangler.jsonc or wrangler.toml at its root, so it is not a Workers project Appflare can install",
    );
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `ADMIN_PASSWORD` -> `Admin password`. */
export function labelOf(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  const text = words.join(" ");
  return text.length === 0 ? name : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Most secrets one repository may ask for. */
const MAX_SECRETS = 32;

/** A comment that calls the value optional ("Optional: ...", "(optional)"). */
const OPTIONAL_NOTE = /\boptional\b/i;

/**
 * The secrets a `.dev.vars.example` (or `.env.example`) lists, as the
 * Deploy button prompts for them: one per `NAME=` line, the comment lines
 * just above it as its help. A secret whose comment calls it optional is
 * optional (the install form leaves it unset unless the admin sets it).
 * Values in the file are examples and never used. Names the wrangler config
 * sets as plain vars are skipped (a Worker cannot have both).
 */
export function parseSecretsExample(
  text: string,
  plainVars: readonly string[] = [],
): CatalogSecret[] {
  const secrets: CatalogSecret[] = [];
  const seen = new Set(plainVars);
  let comments: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      comments.push(line.replace(/^#+\s?/, "").trim());
      continue;
    }
    const match = ENV_LINE.exec(line);
    if (match?.[1] !== undefined && !seen.has(match[1])) {
      seen.add(match[1]);
      const help = comments
        .filter((c) => c.length > 0)
        .join(" ")
        .slice(0, 400);
      secrets.push({
        name: match[1],
        label: labelOf(match[1]),
        ...(help.length > 0 ? { help } : {}),
        generate: false,
        ...(OPTIONAL_NOTE.test(help) ? { optional: true } : {}),
      });
      if (secrets.length >= MAX_SECRETS) break;
    }
    comments = [];
  }
  return secrets;
}

/** A catalog slug from the repository's name: lower case, `[a-z0-9-]`, at most 63. */
export function repositorySlug(repo: string): string {
  const name = repo.split("/")[1] ?? "";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "app";
}

/** A Worker name the manager accepts (`[a-z0-9-]`, at most 54, no dash at either end). */
export function workerNameOf(name: string | null, slug: string): string {
  const cleaned = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 54)
    .replace(/-+$/, "");
  return cleaned.length > 0 ? cleaned : slug.slice(0, 54).replace(/-+$/, "");
}

/** The `package.json` fields the manifest reads. */
export interface PackageFacts {
  description: string | null;
  homepage: string | null;
  license: string | null;
  /** Whether `scripts.build` exists. */
  hasBuildScript: boolean;
}

/** Reads `package.json`; null when there is none, throws when it is not JSON. */
export function readPackageFacts(text: string | null): PackageFacts | null {
  if (text === null) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    throw new DetectionError("package.json is not valid JSON");
  }
  if (!isRecord(pkg)) throw new DetectionError("package.json does not hold an object");
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  return {
    description: str(pkg.description),
    homepage: str(pkg.homepage),
    license: str(pkg.license),
    hasBuildScript: typeof scripts.build === "string" && scripts.build.trim().length > 0,
  };
}

/** The build command the packer runs, and where it came from. */
export function chooseBuildCommand(
  choice: BuildCommandChoice,
  packageManager: PackageManager,
  pkg: PackageFacts | null,
  catalogCommand?: string,
): { command: string | null; from: BuildCommandSource } {
  if (choice.mode === "command") return { command: choice.command, from: "entered" };
  if (choice.mode === "none") return { command: null, from: "none" };
  if (catalogCommand !== undefined) return { command: catalogCommand, from: "catalog" };
  if (pkg?.hasBuildScript) {
    const command = `${packageManager} run build`;
    // Always a plain command; checked anyway, since the packer refuses anything else.
    return buildCommandProblem(command) === null
      ? { command, from: "package.json" }
      : { command: null, from: "none" };
  }
  return { command: null, from: "none" };
}

const SEMVER_TAG =
  /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

/** `YYYYMMDD` in UTC of an ISO 8601 date, or null. */
function dateStamp(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * The artifact's version, the packer's way: the ref without a leading `v`
 * when it is a semver tag, else `0.0.0-<YYYYMMDD of the commit>.<sha7>`. A
 * version in `avoid` (one this install's builds use already, whose objects a
 * build under the same version would replace) gets the commit as build
 * metadata, then a counter.
 */
export function artifactVersion(input: {
  ref: string;
  sha: string;
  committedAt: string | null;
  now: number;
  avoid?: readonly string[];
}): string {
  const sha7 = input.sha.slice(0, 7);
  const tag = isCommitSha(input.ref) ? null : SEMVER_TAG.exec(input.ref)?.[1];
  const base =
    tag ??
    `0.0.0-${dateStamp(input.committedAt) ?? dateStamp(new Date(input.now).toISOString())}.${sha7}`;
  const avoid = new Set(input.avoid ?? []);
  if (!avoid.has(base)) return base;
  const plain = base.split("+")[0] ?? base;
  for (let n = 1; n <= 20; n++) {
    const candidate = `${plain}+${sha7}${n === 1 ? "" : `.${n}`}`;
    if (!avoid.has(candidate)) return candidate;
  }
  return `${plain}+${sha7}.${input.now}`;
}

/** What {@link repositoryManifest} needs besides the repository. */
export interface RepositoryFacts {
  repo: string;
  ref: string;
  sha: string;
  version: string;
  packageManager: PackageManager;
  wranglerConfig: string;
  wrangler: WranglerFacts;
  pkg: PackageFacts | null;
  buildCommand: string | null;
  secrets: CatalogSecret[];
}

function httpsUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The catalog manifest of a repository without a catalog entry: a `sandbox`
 * tier entry on Workers Paid (it is built in a container), named
 * `owner/repo`, with the secrets it lists and one setting per wrangler var.
 */
export function repositoryManifest(facts: RepositoryFacts): CatalogManifest {
  const slug = repositorySlug(facts.repo);
  const vars: CatalogVar[] = facts.wrangler.vars.map((name) => ({
    name,
    label: labelOf(name),
    required: false,
  }));
  return {
    slug,
    // The owner too: two repositories of the same name stay apart in lists and messages.
    name: facts.repo,
    summary: facts.pkg?.description ?? `Built from ${repositoryUrl(facts.repo)}.`,
    homepage: httpsUrl(facts.pkg?.homepage ?? null) ?? repositoryUrl(facts.repo),
    repo: facts.repo,
    license: facts.pkg?.license ?? "NOASSERTION",
    categories: [],
    maintainers: [],
    source: { ref: facts.ref, sha: facts.sha },
    install: {
      tier: "sandbox",
      packageManager: facts.packageManager,
      wranglerConfig: facts.wranglerConfig,
      workerName: workerNameOf(facts.wrangler.name, slug),
      ...(facts.buildCommand === null ? {} : { buildCommand: facts.buildCommand }),
      version: facts.version,
    },
    plan: "paid",
    requires: ["containers"],
    secrets: facts.secrets,
    vars,
    postInstall: [],
    tokenPermissions: [],
  };
}

/**
 * A catalog app's manifest for a build from source at another commit:
 * everything as the catalog has it, but the source, a `sandbox` tier (it is
 * built in this account, unsigned), the version, and the build command the
 * admin chose.
 */
export function sourceBuildManifest(
  baseline: CatalogManifest,
  facts: { ref: string; sha: string; version: string; buildCommand: string | null },
): CatalogManifest {
  const { buildCommand: _catalogCommand, version: _catalogVersion, ...install } = baseline.install;
  return {
    ...baseline,
    source: { ref: facts.ref, sha: facts.sha },
    install: {
      ...install,
      tier: "sandbox",
      ...(facts.buildCommand === null ? {} : { buildCommand: facts.buildCommand }),
      version: facts.version,
    },
  };
}

/** Where the secrets come from, for the result. */
export function secretsSource(file: string | null, baseline: boolean): SecretsSource {
  if (baseline) return "catalog";
  if (file === ".dev.vars.example" || file === ".env.example") return file;
  return "none";
}

/** The first of {@link SECRET_FILES} the checkout has, or null. */
export function secretsFile(files: ReadonlySet<string>): string | null {
  return SECRET_FILES.find((f) => files.has(f)) ?? null;
}
