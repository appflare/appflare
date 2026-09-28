import { z } from "zod";
import { sha256Schema } from "./artifact";
import {
  buildCommandProblem,
  catalogManifestSchema,
  gitShaSchema,
  MAX_BUILD_COMMAND_LENGTH,
  MAX_BUILD_COMMANDS,
  sandboxInstanceTypeSchema,
} from "./catalog";
import { githubTokenSecretNameSchema } from "./github-tokens";
import {
  installLockfileSchema,
  MAX_INSTALL_DIR_LENGTH,
  MAX_INSTALL_DIRS,
  packageManagerSchema,
} from "./install-dirs";
import {
  GIT_REF_CHARACTERS,
  isCommitSha,
  isGithubRepository,
  isGitRefShape,
  MAX_GIT_REF_LENGTH,
} from "./links";
import {
  buildFailureSchema,
  buildInstallIdSchema,
  buildOutcomeFields,
  buildVersionSchema,
  SANDBOX_PROTOCOL_VERSION,
} from "./sandbox";

/**
 * Builds from a repository: the sandbox Worker clones a GitHub repository
 * (public, or private with a GitHub access token) at a branch, tag or commit the admin chose, works out how to
 * build it (package manager from the lockfile, wrangler config, build command
 * from `package.json` or the admin, secrets from `.dev.vars.example`), packs
 * an unsigned artifact with the same packer a catalog build uses, and stores
 * it where a sandbox tier build goes (`builds/<installId>/<version>/`).
 *
 * The same request builds a catalog app from source at another commit: it
 * then carries the catalog manifest (`baseline`), which decides everything
 * but the commit.
 *
 * A repository build has no catalog review behind it. The manager says so
 * wherever the install shows ("Not from the catalog, not checked") and never
 * updates it on its own.
 */

// The plain checks live with the other names that go into addresses, which
// a browser bundle can import without Zod; the schemas here wrap them.
export {
  isCommitSha,
  isGithubRepository,
  isGitRef,
  parseRepositoryInput,
  type RepositoryInput,
  repositoryUrl,
} from "./links";

/** A public GitHub repository as `owner/repo`. */
export const githubRepositorySchema = z
  .string()
  .refine(isGithubRepository, 'must be a GitHub repository as "owner/repo"');

/**
 * A branch, tag or full commit SHA, as git accepts it on the command line and
 * in a URL: letters, digits and `. _ / + -`, no `..`, `//` or `@{`, not
 * starting with `-` or `/`, not ending with `/`, `.` or `.lock`.
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(MAX_GIT_REF_LENGTH)
  .regex(GIT_REF_CHARACTERS, "may contain only letters, digits, and . _ / + -")
  .refine(isGitRefShape, "is not a valid branch, tag or commit");

/** The `info().features` entry of a sandbox Worker that builds from a repository. */
export const SANDBOX_FEATURE_REPOSITORY = "repository-builds";

/**
 * How the build command is chosen: `detect` runs `<package manager> run
 * build` when `package.json` has a `build` script (a catalog app's own
 * `install.buildCommand` wins); `none` runs no build command (the wrangler
 * config's own `build.command` still runs); `command` runs the one given.
 */
export const buildCommandChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("detect") }),
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("command"),
    command: z
      .string()
      .min(1)
      .max(MAX_BUILD_COMMAND_LENGTH)
      .superRefine((command, ctx) => {
        const problem = buildCommandProblem(command);
        if (problem !== null)
          ctx.addIssue({ code: "custom", message: `The build command ${problem}` });
      }),
  }),
]);
export type BuildCommandChoice = z.infer<typeof buildCommandChoiceSchema>;

/** `SandboxBuilds.buildRepository()` input. */
export const repositoryBuildRequestSchema = z
  .object({
    protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
    /** The install the build is for (a new one, or one being updated); names the object prefix. */
    installId: buildInstallIdSchema,
    /**
     * Names the build's log, `builds/<installId>/<runId>/log.txt`, which
     * `progress({ installId, version: runId })` reads while it runs: the
     * artifact's version is known only once the checkout is read.
     */
    runId: buildVersionSchema,
    repo: githubRepositorySchema,
    /** A branch, tag or commit; absent means the repository's default branch. */
    ref: gitRefSchema.optional(),
    /**
     * The commit to build, when the caller resolved the ref already (a
     * rebuild checks for changes first). The checkout must end up exactly
     * there, even if the ref has moved on since.
     */
    commit: gitShaSchema.optional(),
    buildCommand: buildCommandChoiceSchema.optional(),
    /**
     * A catalog app built from source: its catalog manifest, which decides
     * the package manager, wrangler config, build command, secrets and
     * settings. The build replaces only its `source` (and the version and
     * tier the artifact is recorded with).
     */
    baseline: catalogManifestSchema.optional(),
    /**
     * Versions the artifact must not get, because builds of this install
     * already use them (the version the install runs, and the one a rollback
     * returns to): a build under the same version would replace them.
     */
    avoidVersions: z.array(buildVersionSchema).max(16).optional(),
    instanceType: sandboxInstanceTypeSchema.optional(),
    /**
     * The caller's attempt at this run, from 1. A later attempt runs in a
     * container of its own: the one before may still be busy.
     */
    attempt: z.int().min(1).max(20).optional(),
    /**
     * A private repository: the sandbox Worker secret holding the GitHub
     * access token to clone it with (`githubTokenSecretName`). The request
     * names the secret only; the sandbox Worker reads the value itself.
     * Sandbox Workers whose `info().features` lists `github-tokens` take it.
     */
    tokenSecret: githubTokenSecretNameSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.baseline !== undefined && request.baseline.repo !== request.repo) {
      ctx.addIssue({
        code: "custom",
        path: ["baseline", "repo"],
        message: `is ${request.baseline.repo}, but the request builds ${request.repo}`,
      });
    }
    if (request.commit !== undefined && request.ref !== undefined && isCommitSha(request.ref)) {
      if (request.ref !== request.commit) {
        ctx.addIssue({
          code: "custom",
          path: ["commit"],
          message: "differs from the commit named as the ref",
        });
      }
    }
  });
export type RepositoryBuildRequest = z.infer<typeof repositoryBuildRequestSchema>;

/** Where the build command came from. */
export const buildCommandSourceSchema = z.enum(["entered", "catalog", "package.json", "none"]);
export type BuildCommandSource = z.infer<typeof buildCommandSourceSchema>;

/** Where the secrets the install asks for came from. */
export const secretsSourceSchema = z.enum([".dev.vars.example", ".env.example", "catalog", "none"]);
export type SecretsSource = z.infer<typeof secretsSourceSchema>;

/** What the sandbox Worker worked out from the checkout. */
export const repositoryDetectionSchema = z.object({
  packageManager: packageManagerSchema,
  /** The wrangler config, relative to the repository root. */
  wranglerConfig: z.string().min(1).max(256),
  /**
   * The build command the packer ran, or null when none. A catalog app's
   * list of commands is shown joined with ` && ` (`buildCommandText`).
   */
  buildCommand: z
    .string()
    .max(MAX_BUILD_COMMANDS * (MAX_BUILD_COMMAND_LENGTH + 4))
    .nullable(),
  buildCommandFrom: buildCommandSourceSchema,
  /**
   * The directories the packer installed, in order, when the catalog app
   * lists them (`install.installDirs`); omitted when it installs the root
   * alone, and from sandbox Workers that predate the field. `lockfile` is
   * `"none"` for a directory upstream ships without a lockfile, whose
   * dependencies the install resolved.
   */
  installDirs: z
    .array(
      z.object({
        path: z.string().min(1).max(MAX_INSTALL_DIR_LENGTH),
        lockfile: installLockfileSchema,
      }),
    )
    .max(MAX_INSTALL_DIRS)
    .optional(),
  secretsFrom: secretsSourceSchema,
  /**
   * Sections of the wrangler config the packer does not carry into the
   * artifact, so the app would be deployed without them (`containers`,
   * `dispatch_namespaces`, ...). The manager refuses to install such a
   * build. Read from the config wrangler resolves (`appflare-pack inspect`),
   * whatever its format.
   */
  unsupported: z.array(z.string().min(1).max(64)).max(32),
});
export type RepositoryDetection = z.infer<typeof repositoryDetectionSchema>;

/**
 * What `appflare-pack inspect` reads from a project's wrangler config, as
 * wrangler resolves it (JSON, JSONC or TOML): the Worker's `name`, the
 * names of its plain `vars`, the {@link UNSUPPORTED_WRANGLER_SECTIONS} it
 * uses, and the names of the secrets it requires. The command prints it as JSON on one line after
 * {@link INSPECT_OUTPUT_PREFIX}.
 */
export const wranglerFactsSchema = z.object({
  name: z.string().min(1).max(256).nullable(),
  vars: z.array(z.string().min(1).max(256)).max(128),
  unsupported: z.array(z.string().min(1).max(64)).max(32),
  /**
   * The secrets the config requires (wrangler's `secrets.required`).
   * Defaults to none, as a packer from before the field printed it.
   */
  secrets: z.array(z.string().min(1).max(256)).max(128).default([]),
});
export type WranglerFacts = z.infer<typeof wranglerFactsSchema>;

/** The line prefix `appflare-pack inspect` prints its answer after. */
export const INSPECT_OUTPUT_PREFIX = "appflare-pack-inspect: ";

/** The answer of `appflare-pack inspect` in its output, or null when there is none. */
export function parseInspectOutput(output: string): WranglerFacts | null {
  const line = output
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(INSPECT_OUTPUT_PREFIX));
  if (line === undefined) return null;
  try {
    const parsed = wranglerFactsSchema.safeParse(
      JSON.parse(line.slice(INSPECT_OUTPUT_PREFIX.length)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A finished build from a repository. */
export const repositoryBuildResultSchema = z.object({
  ok: z.literal(true),
  ...buildOutcomeFields,
  image: z.string().min(1),
  installId: buildInstallIdSchema,
  /** The artifact's version (`builds/<installId>/<version>/`). */
  version: buildVersionSchema,
  /** sha256 of `manifest.json` as stored; the manager checks what it reads against it. */
  digest: sha256Schema,
  size: z.int().min(0),
  manifestKey: z.string().min(1),
  artifactKey: z.string().min(1),
  /** The commit that was built. */
  commit: gitShaSchema,
  /** The branch or tag it was built from (the default branch's name when none was asked for), or the commit itself. */
  ref: gitRefSchema,
  /** The commit's date, ISO 8601; null when git did not say. */
  committedAt: z.iso.datetime({ offset: true }).nullable(),
  detected: repositoryDetectionSchema,
});
export type RepositoryBuildResult = z.infer<typeof repositoryBuildResultSchema>;

export const repositoryBuildOutcomeSchema = z.discriminatedUnion("ok", [
  repositoryBuildResultSchema,
  buildFailureSchema,
]);
export type RepositoryBuildOutcome = z.infer<typeof repositoryBuildOutcomeSchema>;
