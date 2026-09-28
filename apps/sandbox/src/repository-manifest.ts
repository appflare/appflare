import {
  type BuildCommandChoice,
  type BuildCommandSource,
  buildCommandProblem,
  type CatalogBuildCommand,
  type CatalogCategory,
  type CatalogManifest,
  catalogLicenseProblem,
  type catalogManifestSchema,
  type catalogSecretSchema,
  isCommitSha,
  LICENSE_NOT_STATED,
  lockfilePackageManager,
  MAX_TAGLINE_LENGTH,
  type PackageManager,
  repositoryUrl,
  type SecretsSource,
  taglineSchema,
  WRANGLER_CONFIG_TEMPLATE_SUFFIXES,
  type WranglerFacts,
} from "@appflare/schema";
import type { z } from "zod";

/** A catalog manifest as written, before the schema fills in its defaults. */
export type CatalogManifestDraft = z.input<typeof catalogManifestSchema>;

/** A catalog secret as written, before the schema fills in its defaults. */
export type CatalogSecretDraft = z.input<typeof catalogSecretSchema>;

/**
 * How a repository without a catalog entry is built, worked out from its
 * checkout the way the "Deploy to Cloudflare" button does: the lockfile names
 * the package manager, the wrangler config sits at the root, `package.json`'s
 * `build` script is the build command, and `.dev.vars.example` lists the
 * secrets, with any more the wrangler config requires (`secrets.required`).
 * The result is a catalog manifest the packer takes like any other;
 * the artifact records it. Everything here is pure, so the tests pin it.
 */

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
  const manager = lockfilePackageManager(files);
  if (manager !== null) return manager;
  throw new DetectionError(
    "the repository has no lockfile at its root (pnpm-lock.yaml, package-lock.json, yarn.lock or bun.lock); Appflare installs exactly the locked dependencies, so it cannot build a project without one",
  );
}

/**
 * Wrangler configs kept only as a template to copy (`wrangler.toml.example`),
 * in the order they are looked for when the root has no real config. The
 * packer copies one to its real name before wrangler reads it.
 */
export const WRANGLER_CONFIG_TEMPLATES = WRANGLER_CONFIGS.flatMap((name) =>
  WRANGLER_CONFIG_TEMPLATE_SUFFIXES.map((suffix) => `${name}${suffix}`),
);

/** The wrangler config at the root, else a template of one; throws when there is neither. */
export function detectWranglerConfig(files: ReadonlySet<string>): string {
  const found =
    WRANGLER_CONFIGS.find((name) => files.has(name)) ??
    WRANGLER_CONFIG_TEMPLATES.find((name) => files.has(name));
  if (found === undefined) {
    throw new DetectionError(
      "the repository has no wrangler.json, wrangler.jsonc or wrangler.toml at its root (nor one kept as a .example or .template copy), so it is not a Workers project Appflare can install",
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
): CatalogSecretDraft[] {
  const secrets: CatalogSecretDraft[] = [];
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
        ...(OPTIONAL_NOTE.test(help) ? { optional: true } : {}),
      });
      if (secrets.length >= MAX_SECRETS) break;
    }
    comments = [];
  }
  return secrets;
}

/**
 * The secrets the install asks for: those `.dev.vars.example` lists (see
 * {@link parseSecretsExample}), then each other secret the wrangler config
 * requires (`secrets.required`). A required secret is never optional, even
 * when the example file's comment calls it so: wrangler warns without it.
 */
export function withRequiredSecrets(
  listed: readonly CatalogSecretDraft[],
  required: readonly string[],
): CatalogSecretDraft[] {
  const names = new Set(required);
  const secrets = listed.map((s) => {
    if (!names.has(s.name) || s.optional !== true) return s;
    const { optional: _optional, ...rest } = s;
    return rest;
  });
  const seen = new Set(secrets.map((s) => s.name));
  for (const name of required) {
    if (secrets.length >= MAX_SECRETS) break;
    if (seen.has(name)) continue;
    seen.add(name);
    secrets.push({ name, label: labelOf(name) });
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
  catalogCommand?: CatalogBuildCommand,
): { command: CatalogBuildCommand | null; from: BuildCommandSource } {
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
  buildCommand: CatalogBuildCommand | null;
  secrets: CatalogSecretDraft[];
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
 * The license a repository build records: `package.json`'s `license` when it
 * is one a repository build may carry (an SPDX expression of current ids, a
 * `LicenseRef-<name>`, `NONE`, `NOASSERTION` or `SEE LICENSE IN <file>`),
 * else `NOASSERTION`, SPDX's "not stated". npm's `UNLICENSED` and free text
 * such as `MIT License` say nothing the catalog can show as a license.
 */
export function repositoryLicense(pkg: PackageFacts | null): string {
  const license = pkg?.license ?? null;
  if (license === null) return LICENSE_NOT_STATED;
  return catalogLicenseProblem(license, { repositoryBuild: true }) === null
    ? license
    : LICENSE_NOT_STATED;
}

/**
 * The tagline of a repository build: the first line of `package.json`'s
 * description when it makes one (at most {@link MAX_TAGLINE_LENGTH}
 * characters, its trailing period dropped), else where it was built from.
 */
export function repositoryTagline(repo: string, description: string | null): string {
  const line = (description ?? "")
    .split(/\r?\n/)[0]
    ?.trim()
    .replace(/[.\s]+$/, "");
  if (line !== undefined && taglineSchema.safeParse(line).success) return line;
  const built = `Built from ${repo}`;
  return taglineSchema.safeParse(built).success ? built : "Built from a GitHub repository";
}

/**
 * The one category a repository build is listed under. It has no catalog
 * entry to say what the app does, and every catalog manifest names at least
 * one category.
 */
export const REPOSITORY_CATEGORY: CatalogCategory = "utilities";

/**
 * The catalog manifest of a repository without a catalog entry: a `sandbox`
 * tier entry on Workers Paid (it is built in a container), named
 * `owner/repo`, with the secrets it lists and one optional setting per
 * wrangler var. Returned as written; the schema fills in the defaults.
 */
export function repositoryManifest(facts: RepositoryFacts): CatalogManifestDraft {
  const slug = repositorySlug(facts.repo);
  return {
    slug,
    // The owner too: two repositories of the same name stay apart in lists and messages.
    name: facts.repo,
    summary: facts.pkg?.description ?? `Built from ${repositoryUrl(facts.repo)}.`,
    tagline: repositoryTagline(facts.repo, facts.pkg?.description ?? null),
    homepage: httpsUrl(facts.pkg?.homepage ?? null) ?? repositoryUrl(facts.repo),
    repo: facts.repo,
    license: repositoryLicense(facts.pkg),
    categories: [REPOSITORY_CATEGORY],
    maintainers: [],
    source: { ref: facts.ref, sha: facts.sha, version: facts.version },
    install: {
      tier: "sandbox",
      packageManager: facts.packageManager,
      wranglerConfig: facts.wranglerConfig,
      workerName: workerNameOf(facts.wrangler.name, slug),
      ...(facts.buildCommand === null ? {} : { buildCommand: facts.buildCommand }),
    },
    plan: "paid",
    requires: ["containers"],
    secrets: facts.secrets,
    vars: facts.wrangler.vars.map((name) => ({ name, label: labelOf(name), optional: true })),
    postInstall: [],
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
  facts: { ref: string; sha: string; version: string; buildCommand: CatalogBuildCommand | null },
): CatalogManifest {
  const { buildCommand: _catalogCommand, ...install } = baseline.install;
  return {
    ...baseline,
    source: { ref: facts.ref, sha: facts.sha, version: facts.version },
    install: {
      ...install,
      tier: "sandbox",
      ...(facts.buildCommand === null ? {} : { buildCommand: facts.buildCommand }),
    },
  };
}

/** Where the secrets come from, for the result. */
export function secretsSource(file: string | null, baseline: boolean): SecretsSource {
  if (baseline) return "catalog";
  if (file === ".dev.vars.example" || file === ".env.example") return file;
  return "none";
}

/**
 * Where the secrets came from, as the build log says it after their names
 * (` (from .dev.vars.example and the wrangler config's secrets.required)`);
 * empty when from nowhere.
 */
export function secretsNote(source: SecretsSource, required: readonly string[]): string {
  const from = [
    ...(source === "none" ? [] : [source]),
    ...(required.length > 0 ? ["the wrangler config's secrets.required"] : []),
  ];
  return from.length === 0 ? "" : ` (from ${from.join(" and ")})`;
}

/** The first of {@link SECRET_FILES} the checkout has, or null. */
export function secretsFile(files: ReadonlySet<string>): string | null {
  return SECRET_FILES.find((f) => files.has(f)) ?? null;
}
