import { z } from "zod";
import { sha256Schema } from "./artifact";
import {
  buildCommandArgv,
  buildCommandList,
  type CatalogBuildCommand,
  catalogInstallSchema,
  gitShaSchema,
  MAX_BUILD_COMMANDS,
  ownerRepoSchema,
  sandboxInstanceTypeSchema,
} from "./catalog";
import { packageManagerSchema } from "./install-dirs";
import {
  namesStage,
  selfDeployingCommandSchema,
  selfDeployingStageSchema,
  selfDeployingToolSchema,
} from "./self-deploying";

/**
 * The contract between the manager and the sandbox Worker (`appflare-sandbox`),
 * the optional, Workers Paid only Worker that builds `sandbox` tier apps inside
 * a Cloudflare Sandbox container in the user's own account.
 *
 * The manager calls the sandbox Worker's `SandboxBuilds` entrypoint over a service binding
 * (RPC). A build clones the pinned commit, installs dependencies with install
 * scripts disabled, packs an unsigned artifact with
 * `@appflare/pack` (which first runs the entry's `install.buildCommand`, if
 * any), and copies it into the sandbox Worker's R2 bucket under
 * `builds/<installId>/<version>/`. The manager then reads that artifact with
 * the same Range reader it uses for release assets, through the sandbox Worker's
 * `fetch` handler (see {@link sandboxObjectUrl}).
 */

/**
 * Version of the RPC protocol below. The manager refuses a sandbox Worker that
 * speaks another one; bump it on every incompatible change.
 */
export const SANDBOX_PROTOCOL_VERSION = 1;

/** The sandbox Worker's script name, one per account. */
export const SANDBOX_WORKER_NAME = "appflare-sandbox";

/** The sandbox Worker's `WorkerEntrypoint` class the manager's service binding names. */
export const SANDBOX_ENTRYPOINT = "SandboxBuilds";

/** The R2 bucket that holds build outputs and build logs. */
export const SANDBOX_BUCKET_NAME = "appflare-builds";

/** The sandbox Worker's R2 binding (to {@link SANDBOX_BUCKET_NAME}). */
export const SANDBOX_BUCKET_BINDING = "BUILDS";

/**
 * The sandbox Worker's version metadata binding: `info()` reports the id of
 * the version that answered, so the manager can tell when a new version (each
 * secret change deploys one) has reached it.
 */
export const SANDBOX_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

/**
 * The container image a sandbox Worker version runs. Tags are immutable: a sandbox Worker
 * version always runs exactly the image built from its release commit.
 * Docker Hub, because Cloudflare Containers pull only from the Cloudflare
 * registry, Docker Hub, Amazon ECR, and Google Artifact Registry.
 */
export const SANDBOX_IMAGE_REPOSITORY = "docker.io/mendylanda/appflare-sandbox";

/** Git tags and GitHub Releases of the sandbox Worker are `sandbox@<version>`. */
export const SANDBOX_RELEASE_TAG_PREFIX = "sandbox@";

export function sandboxImage(version: string): string {
  return `${SANDBOX_IMAGE_REPOSITORY}:${version}`;
}

/**
 * The container classes of the sandbox Worker, each backed by its own
 * container application running the sandbox Worker's image: builds run on
 * `standard-1` (1/2 vCPU, 4 GiB, 8 GB disk), and on `standard-2` when a
 * catalog entry asks for it. At most two builds of the first size and one of
 * the second run at once. The application names are how the manager and the
 * CLI find the applications again, so they never change.
 */
export const SANDBOX_CONTAINERS = [
  {
    name: `${SANDBOX_WORKER_NAME}-standard-1`,
    class_name: "Sandbox",
    instance_type: "standard-1",
    max_instances: 2,
  },
  {
    name: `${SANDBOX_WORKER_NAME}-standard-2`,
    class_name: "LargeSandbox",
    instance_type: "standard-2",
    max_instances: 1,
  },
] as const;

export type SandboxContainer = (typeof SANDBOX_CONTAINERS)[number];

/** Every object the sandbox Worker writes or serves lives under this prefix. */
export const BUILDS_PREFIX = "builds/";

/**
 * The origin of sandbox build object URLs. The manager fetches them through its
 * service binding, so the host is never resolved; it only has to be a valid
 * URL for `fetch`.
 */
export const SANDBOX_URL_ORIGIN = "https://sandbox";

/** The most build output a result or progress answer quotes: about 200 KiB of text. */
export const BUILD_LOG_TAIL_CHARS = 200 * 1024;

/** An install id as it appears in object keys: ULID-like, no path characters. */
export const buildInstallIdSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/, "must be 1-64 letters, digits, _ or -");

/** An artifact version as it appears in object keys: no slashes, never `..`. */
export const buildVersionSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/, "must be a version without slashes")
  .refine((v) => !v.includes(".."), "must not contain ..");

/** A path inside the checkout: relative, `/`-separated, no `.` or `..` segments. */
export const checkoutPathSchema = z
  .string()
  .max(256)
  .refine(
    (p) =>
      p.length > 0 &&
      p.split("/").every((segment) => /^[0-9A-Za-z.@+_-]+$/.test(segment)) &&
      !p.split("/").some((segment) => segment === "." || segment === ".."),
    "must be a relative path of letters, digits, and . @ + _ - (no leading /, no . or .. segments)",
  );

/**
 * One word of a build command. The sandbox Worker runs the command without a
 * shell's help, so only characters no shell interprets are allowed, and no
 * word may set an environment variable.
 */
export const buildArgvWordSchema = z
  .string()
  .regex(/^[A-Za-z0-9@%+,./:=_-]+$/, "may contain only letters, digits, and @ % + , . / : = _ -");

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A build command as argv: the program first, then its arguments. */
export const buildCommandArgvSchema = z
  .array(buildArgvWordSchema)
  .min(1)
  .max(32)
  .refine((argv) => argv.join(" ").length <= 256, "must be at most 256 characters in total")
  .refine(
    (argv) => !argv.some((word) => ENV_ASSIGNMENT.test(word)),
    "must not set environment variables; the build runs in a fixed environment",
  );

/**
 * A catalog entry's `install.buildCommand` as a request carries it: one argv
 * for a single command (the shape every sandbox Worker version reads), a list
 * of argvs only when the entry lists several commands.
 */
export function buildCommandRequestArgv(command: CatalogBuildCommand): string[] | string[][] {
  const argvs = buildCommandList(command).map(buildCommandArgv);
  const [only] = argvs;
  return argvs.length === 1 && only !== undefined ? only : argvs;
}

/** The argvs of a request's `buildCommand`, in the order they run. */
export function buildCommandArgvList(value: string[] | string[][]): string[][] {
  // Checked by the schema: all words (one argv) or all argvs.
  return typeof value[0] === "string" ? [value as string[]] : (value as string[][]);
}

/**
 * The fields of the catalog manifest the sandbox Worker relies on. The whole
 * manifest passes through unchanged (it is recorded verbatim in the
 * artifact); the packer inside the container validates it in full at the
 * image's version.
 */
export const buildCatalogManifestSchema = z.looseObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a catalog slug"),
  repo: ownerRepoSchema,
  source: z.looseObject({ ref: z.string().min(1), sha: gitShaSchema }),
  install: z.looseObject({
    tier: z.literal("sandbox"),
    packageManager: packageManagerSchema,
    wranglerConfig: z.string().min(1),
    // The same rules as the catalog manifest's: no shell syntax, no
    // environment assignments, at most 256 characters per command.
    buildCommand: catalogInstallSchema.shape.buildCommand,
    // The packer installs these itself, so the sandbox Worker hands it the
    // install instead of running the root install first.
    installDirs: catalogInstallSchema.shape.installDirs,
  }),
});
export type BuildCatalogManifest = z.infer<typeof buildCatalogManifestSchema>;

/** `SandboxBuilds.build()` input. */
export const buildRequestSchema = z
  .object({
    protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
    /** The install being built; names the object prefix. */
    installId: buildInstallIdSchema,
    /** The artifact version the pack must produce (the catalog version). */
    version: buildVersionSchema,
    /** GitHub `owner/repo`; must equal the catalog manifest's `repo`. */
    repo: ownerRepoSchema.refine(
      (r) => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r) && !r.endsWith("/.."),
      "must be a GitHub owner/repo",
    ),
    /** The pin; must equal the catalog manifest's `source.sha`. */
    sha: gitShaSchema,
    /** Where the wrangler project sits inside the repository, when not at its root. */
    subdirectory: checkoutPathSchema.optional(),
    /**
     * The entry's build command as argv, for the caller's own records. The
     * catalog manifest's `install.buildCommand` is the only source of the
     * build command: the packer runs it (after the install, before bundling)
     * and the artifact records it. So this field may only repeat it: it must
     * equal the manifest's command word for word, and it is refused when the
     * manifest declares none or several.
     */
    buildCommand: buildCommandArgvSchema.optional(),
    /** Relative to the project; must equal the catalog manifest's `install.wranglerConfig`. */
    wranglerConfigPath: checkoutPathSchema,
    /** The entry's `appflare.jsonc`, parsed; recorded verbatim in the artifact. */
    catalogManifest: buildCatalogManifestSchema,
    instanceType: sandboxInstanceTypeSchema.optional(),
    /**
     * The caller's attempt at this run, from 1. A later attempt runs in a
     * container of its own: the one before may still be busy (or be restarting)
     * after the run was cut off, and must not be wiped under it.
     */
    attempt: z.int().min(1).max(20).optional(),
  })
  .superRefine((request, ctx) => {
    const manifest = request.catalogManifest;
    if (request.repo !== manifest.repo) {
      ctx.addIssue({
        code: "custom",
        path: ["repo"],
        message: `is ${request.repo}, but the catalog manifest says ${manifest.repo}`,
      });
    }
    if (request.sha !== manifest.source.sha) {
      ctx.addIssue({
        code: "custom",
        path: ["sha"],
        message: "is not the catalog manifest's source.sha",
      });
    }
    if (request.wranglerConfigPath !== manifest.install.wranglerConfig) {
      ctx.addIssue({
        code: "custom",
        path: ["wranglerConfigPath"],
        message: `is ${request.wranglerConfigPath}, but the catalog manifest says ${manifest.install.wranglerConfig}`,
      });
    }
    const declared = buildCommandList(manifest.install.buildCommand);
    if (request.buildCommand !== undefined) {
      const only = declared.length === 1 ? declared[0] : undefined;
      if (declared.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["buildCommand"],
          message:
            "is set, but the catalog manifest declares no install.buildCommand; the build command comes from the manifest only",
        });
      } else if (only === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["buildCommand"],
          message:
            "is set, but the catalog manifest declares several build commands; leave it out, the packer runs them all",
        });
      } else if (buildCommandArgv(only).join(" ") !== request.buildCommand.join(" ")) {
        ctx.addIssue({
          code: "custom",
          path: ["buildCommand"],
          message: "differs from the catalog manifest's install.buildCommand",
        });
      }
    }
  });
export type BuildRequest = z.infer<typeof buildRequestSchema>;

/**
 * The steps of a build, in order. A failure names the step it happened in.
 * `request` is a request the sandbox Worker refused before starting a
 * container; `detect` (builds from a repository only) reads the checkout to
 * work out how to build it; `build` is the build command, which runs inside
 * the packer, reported separately when it is what failed.
 */
export const buildStageSchema = z.enum([
  "request",
  "checkout",
  "detect",
  "install",
  "build",
  "pack",
  "upload",
  "verify",
]);
export type BuildStage = z.infer<typeof buildStageSchema>;

/**
 * The steps of a self-deploying run (the app's own installer; see the end of
 * this file), in order. `token` is reading the app's token and secrets the
 * sandbox Worker holds for the install; `deploy` and `destroy` run the
 * installer's command; `discover` reads back what the deploy created.
 */
export const selfManagedStepSchema = z.enum([
  "request",
  "token",
  "checkout",
  "install",
  "build",
  "deploy",
  "discover",
  "destroy",
]);
export type SelfManagedStep = z.infer<typeof selfManagedStepSchema>;

/** A step of either kind of run, as its progress log records it. */
export const runStepSchema = z.union([buildStageSchema, selfManagedStepSchema]);
export type RunStep = z.infer<typeof runStepSchema>;

const outcomeBase = {
  protocol: z.int(),
  /** The sandbox Worker's Appflare version, which is also its image tag. */
  sandboxVersion: z.string().min(1),
  /** Wall-clock minutes the build took, one decimal. */
  minutes: z.number().min(0),
  /** The object the build log is kept in, or null when the request was refused. */
  logKey: z.string().nullable(),
  /** The end of the build output (at most {@link BUILD_LOG_TAIL_CHARS} characters). */
  log: z.string(),
};

/** The fields every build outcome carries, a build from a repository's too. */
export const buildOutcomeFields = outcomeBase;

/** A finished build. */
export const buildResultSchema = z.object({
  ok: z.literal(true),
  ...outcomeBase,
  /** The container image that ran the build. */
  image: z.string().min(1),
  installId: buildInstallIdSchema,
  version: buildVersionSchema,
  /** sha256 of `manifest.json` as stored; the manager checks what it reads against it. */
  digest: sha256Schema,
  /** Size of the zip in bytes. */
  size: z.int().min(0),
  manifestKey: z.string().min(1),
  artifactKey: z.string().min(1),
});
export type BuildResult = z.infer<typeof buildResultSchema>;

/** A build that did not finish. */
export const buildFailureSchema = z.object({
  ok: z.literal(false),
  ...outcomeBase,
  stage: buildStageSchema,
  message: z.string().min(1),
  /**
   * True when running the same build again may succeed: the container
   * could not start or went away. A failing command is never retryable.
   */
  retryable: z.boolean(),
  /** Exit code of the command that failed, when one did. */
  exitCode: z.int().nullable(),
});
export type BuildFailure = z.infer<typeof buildFailureSchema>;

export const buildOutcomeSchema = z.discriminatedUnion("ok", [
  buildResultSchema,
  buildFailureSchema,
]);
export type BuildOutcome = z.infer<typeof buildOutcomeSchema>;

/** `SandboxBuilds.progress()` input. */
export const buildProgressRequestSchema = z.object({
  installId: buildInstallIdSchema,
  version: buildVersionSchema,
});
export type BuildProgressRequest = z.infer<typeof buildProgressRequestSchema>;

/**
 * A running or finished build (or self-deploying run, whose log lives under
 * the run id in place of the version), as the manager's job page polls it.
 */
export const buildProgressSchema = z.object({
  state: z.enum(["running", "succeeded", "failed"]),
  stage: runStepSchema,
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  log: z.string(),
});
export type BuildProgress = z.infer<typeof buildProgressSchema>;

/** `SandboxBuilds.cleanup()` input: delete an install's builds except these versions. */
export const buildCleanupRequestSchema = z.object({
  installId: buildInstallIdSchema,
  keepVersions: z.array(buildVersionSchema).max(16),
});
export type BuildCleanupRequest = z.infer<typeof buildCleanupRequestSchema>;

/** `SandboxBuilds.info()`: what the manager checks before it trusts a sandbox Worker. */
export const sandboxInfoSchema = z.object({
  protocol: z.int(),
  sandboxVersion: z.string().min(1),
  image: z.string().min(1),
  /**
   * What this sandbox Worker can do beyond builds, such as
   * {@link SANDBOX_FEATURE_SELF_DEPLOYING}. Absent from sandbox Workers that
   * only build.
   */
  features: z.array(z.string().min(1)).max(32).optional(),
  /**
   * The id of the Worker version that answered (its
   * {@link SANDBOX_VERSION_METADATA_BINDING}). Absent from sandbox Workers
   * deployed without that binding.
   */
  versionId: z.string().min(1).max(64).optional(),
});
export type SandboxInfo = z.infer<typeof sandboxInfoSchema>;

/** Object keys of one build. */
export interface BuildKeys {
  /** `builds/<installId>/<version>/` */
  prefix: string;
  manifest: string;
  /** `<slug>-<version>.zip`, the name the packer gives the zip. */
  artifact: string;
  log: string;
}

export function buildKeys(installId: string, version: string, slug: string): BuildKeys {
  const prefix = `${BUILDS_PREFIX}${installId}/${version}/`;
  return {
    prefix,
    manifest: `${prefix}manifest.json`,
    artifact: `${prefix}${slug}-${version}.zip`,
    log: `${prefix}log.txt`,
  };
}

/** Every build of one install: `builds/<installId>/`. */
export function installBuildsPrefix(installId: string): string {
  return `${BUILDS_PREFIX}${installId}/`;
}

/**
 * Whether `key` names an object the sandbox Worker may serve: under `builds/`,
 * with non-empty segments of safe characters and no `.` or `..` segment.
 */
export function isBuildObjectKey(key: string): boolean {
  if (!key.startsWith(BUILDS_PREFIX) || key.length > 512) return false;
  const segments = key.slice(BUILDS_PREFIX.length).split("/");
  return segments.every((s) => /^[0-9A-Za-z@+_-][0-9A-Za-z.@+_-]*$/.test(s));
}

/** The URL the manager fetches a build object at, through its sandbox binding. */
export function sandboxObjectUrl(key: string): string {
  return `${SANDBOX_URL_ORIGIN}/${key}`;
}

// ---------------------------------------------------------------------------
// Self-deploying tier: running an app's own installer.
//
// A self-deploying app (catalog `install.selfDeploying`) ships its own
// installer, for example an Alchemy stack. The sandbox Worker checks the
// pinned commit out in a container, installs its dependencies with install
// scripts disabled, runs the entry's build command without credentials, then
// runs the installer's deploy or destroy command with the app's Cloudflare API
// token in its environment, and reads back what the deploy created.
//
// Custody of the app's token: the manager stores it as a secret ON THE
// SANDBOX WORKER, named by `appTokenSecretName(installId)`, through the
// Cloudflare API, and each of the app's secret values the same way
// (`appSecretSecretName`). Requests name only the install and the secrets;
// the sandbox Worker reads the values from its own environment, so none ever
// crosses RPC or lands in the manager's D1. The manager's own API token never reaches the sandbox
// Worker, and the sandbox Worker calls the Cloudflare API only with the app's
// token.
// ---------------------------------------------------------------------------

/** The `info().features` entry of a sandbox Worker that runs app installers. */
export const SANDBOX_FEATURE_SELF_DEPLOYING = "self-deploying";

/**
 * An install id as a self-deploying request carries it: letters and digits
 * only, because it is part of the names of the secrets that hold the app's
 * token and secrets.
 */
export const selfManagedInstallIdSchema = z
  .string()
  .regex(/^[0-9A-Za-z]{1,64}$/, "must be 1-64 letters or digits");

/** The sandbox Worker secret that holds an install's app token. */
export function appTokenSecretName(installId: string): string {
  return `APP_TOKEN_${installId}`;
}

/**
 * The sandbox Worker secret that holds the value of one of an install's app
 * secrets (catalog `secrets[].name`), one secret each, so an update that
 * introduces a secret adds just that one. The install id has letters and
 * digits only, so the first `_` after it ends it.
 */
export function appSecretSecretName(installId: string, name: string): string {
  return `APP_SECRET_${installId}_${name}`;
}

/** An environment variable the installer gets. */
export const installerEnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "must be an environment variable name");

/**
 * Names a request may not set: what the container itself relies on, what
 * the build environment fixes, and prefixes that reconfigure the tools that
 * run the installer.
 */
export const RESERVED_INSTALLER_ENV = [
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "TMPDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "CI",
  "BASH_ENV",
  "ENV",
  "COREPACK_ENABLE_STRICT",
  "WRANGLER_SEND_METRICS",
  "WRANGLER_SEND_ERROR_REPORTS",
  "NO_UPDATE_NOTIFIER",
  "YARN_ENABLE_SCRIPTS",
] as const;
const RESERVED_INSTALLER_ENV_PREFIXES = [
  "npm_config_",
  "NPM_CONFIG_",
  "PNPM_",
  "COREPACK_",
  "GIT_",
];

/**
 * Prefixes an app's own settings and secrets may not use: the installer's
 * credentials and configuration live there (`CLOUDFLARE_API_TOKEN`,
 * `ALCHEMY_PROFILE`, ...), and only the sandbox Worker sets those.
 */
const RESERVED_APP_ENV_PREFIXES = ["CLOUDFLARE_", "ALCHEMY_"];

/**
 * Why `name` may not be set for the installer, or null when it may. `fromApp`
 * for the app's settings and secrets, which also may not use the prefixes of
 * the installer's own credentials and configuration.
 */
export function reservedInstallerEnvProblem(name: string, fromApp = true): string | null {
  if ((RESERVED_INSTALLER_ENV as readonly string[]).includes(name)) {
    return `${name} is set by the sandbox Worker`;
  }
  const prefix = RESERVED_INSTALLER_ENV_PREFIXES.find((p) => name.startsWith(p));
  if (prefix !== undefined) return `${name} would reconfigure the tools (${prefix}*)`;
  const own = fromApp ? RESERVED_APP_ENV_PREFIXES.find((p) => name.startsWith(p)) : undefined;
  return own === undefined
    ? null
    : `${name} is reserved for the installer's credentials and configuration (${own}*)`;
}

/** A Worker name as the installer creates it. */
export const selfManagedWorkerNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "must be a Worker name");

const selfManagedRepoSchema = ownerRepoSchema.refine(
  (r) => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r) && !r.endsWith("/.."),
  "must be a GitHub owner/repo",
);

/**
 * `SandboxBuilds.deploySelfManaged()` and `destroySelfManaged()` input: one
 * run of the app's installer for one install.
 */
export const selfManagedRunRequestSchema = z
  .object({
    protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
    installId: selfManagedInstallIdSchema,
    /**
     * Names the run's log, `builds/<installId>/<runId>/log.txt`, which
     * `progress({ installId, version: runId })` reads while it runs.
     */
    runId: buildVersionSchema,
    /** The account the installer deploys to (the app token must be for it). */
    accountId: z.string().regex(/^[0-9a-f]{32}$/, "must be a Cloudflare account id"),
    tool: selfDeployingToolSchema,
    repo: selfManagedRepoSchema,
    /** The pin: the run checks out exactly this commit. */
    sha: gitShaSchema,
    /** The pin's branch or tag, tried first for a shallow clone. */
    ref: z.string().min(1).max(256),
    /** Where the installer's project sits inside the repository, when not at its root. */
    subdirectory: checkoutPathSchema.optional(),
    packageManager: packageManagerSchema,
    /**
     * The entry's `install.buildCommand`, run without credentials before the
     * installer: one argv, or for an entry that lists several commands, their
     * argvs in the order they run.
     */
    buildCommand: z
      .union([
        buildCommandArgvSchema,
        z.array(buildCommandArgvSchema).min(1).max(MAX_BUILD_COMMANDS),
      ])
      .optional(),
    /** The installer's deploy or destroy command (the method says which). */
    command: selfDeployingCommandSchema,
    /** The install's stage, appended to the command after `stageArg`. */
    stage: selfDeployingStageSchema,
    stageArg: z.string().regex(/^--?[a-z][a-z0-9-]*$/, "must be an option such as --stage"),
    /** Environment variables the app token is exposed under (for Alchemy, `CLOUDFLARE_API_TOKEN`). */
    tokenEnv: z.array(installerEnvNameSchema).min(1).max(4),
    /** Environment variables the account id is exposed under (for Alchemy, `CLOUDFLARE_ACCOUNT_ID`). */
    accountIdEnv: z.array(installerEnvNameSchema).max(4),
    /** The app's settings (not secret), as environment variables. */
    vars: z.record(installerEnvNameSchema, z.string().max(4096)),
    /**
     * Names of the app's secrets to expose, each read from
     * `appSecretSecretName(installId, name)` on the sandbox Worker; every one must be there.
     */
    secretNames: z.array(installerEnvNameSchema).max(32),
    /** The Workers the installer creates (deploy) or deletes (destroy), stage filled in. */
    expectedWorkers: z.array(selfManagedWorkerNameSchema).min(1).max(8),
    instanceType: sandboxInstanceTypeSchema.optional(),
    /**
     * The caller's attempt at this run, from 1. A later attempt runs in a
     * container of its own: the one before may still be busy (or be restarting)
     * after the run was cut off, and must not be wiped under it.
     */
    attempt: z.int().min(1).max(20).optional(),
  })
  .superRefine((request, ctx) => {
    const seen = new Map<string, string>();
    const claim = (name: string, what: string, path: (string | number)[], fromApp = true) => {
      const reserved = reservedInstallerEnvProblem(name, fromApp);
      if (reserved !== null) {
        ctx.addIssue({ code: "custom", path, message: reserved });
        return;
      }
      const other = seen.get(name);
      if (other !== undefined) {
        ctx.addIssue({ code: "custom", path, message: `${name} is both ${other} and ${what}` });
        return;
      }
      seen.set(name, what);
    };
    request.tokenEnv.forEach((n, i) => {
      claim(n, "the app token", ["tokenEnv", i], false);
    });
    request.accountIdEnv.forEach((n, i) => {
      claim(n, "the account id", ["accountIdEnv", i], false);
    });
    request.secretNames.forEach((n, i) => {
      claim(n, "an app secret", ["secretNames", i]);
    });
    for (const n of Object.keys(request.vars)) claim(n, "an app setting", ["vars", n]);
    if (namesStage(request.command, request.stageArg)) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: `must not name the stage itself; the sandbox Worker appends ${request.stageArg} <stage>`,
      });
    }
  });
export type SelfManagedRunRequest = z.infer<typeof selfManagedRunRequestSchema>;

/** Kinds of resources a deploy reports, as the manager records them. */
export const selfManagedResourceKindSchema = z.enum([
  "worker",
  "d1",
  "kv",
  "r2",
  "queue",
  "vectorize",
  "durable_object",
  "workflow",
]);
export type SelfManagedResourceKind = z.infer<typeof selfManagedResourceKindSchema>;

/**
 * One resource the installer created, found by reading the expected Workers
 * and their bindings in the account with the app's token after the run.
 */
export const selfManagedResourceSchema = z.object({
  kind: selfManagedResourceKindSchema,
  /** Worker name, database name, namespace title, bucket name, class name, ... */
  name: z.string().min(1).max(256),
  /** Cloudflare's id (database uuid, namespace id, ...), when it has one apart from the name. */
  cfId: z.string().min(1).max(256).nullable(),
  /** The Worker that is this resource or binds it. */
  worker: selfManagedWorkerNameSchema,
  /** The binding name on that Worker; null for a Worker itself. */
  binding: z.string().min(1).max(256).nullable(),
});
export type SelfManagedResource = z.infer<typeof selfManagedResourceSchema>;

/** One expected Worker as the account has it after the run. */
export const selfManagedWorkerSchema = z.object({
  name: selfManagedWorkerNameSchema,
  /** Its workers.dev URL when that route is on, else null. */
  url: z.url().nullable(),
});
export type SelfManagedWorker = z.infer<typeof selfManagedWorkerSchema>;

const runOutcomeBase = {
  protocol: z.int(),
  sandboxVersion: z.string().min(1),
  /** Wall-clock minutes the run took, one decimal. */
  minutes: z.number().min(0),
  /** The object the run's log is kept in, or null when the request was refused. */
  logKey: z.string().nullable(),
  /** The end of the output (at most {@link BUILD_LOG_TAIL_CHARS} characters). */
  log: z.string(),
};

/** A finished deploy: what the account holds now. */
export const selfManagedDeployResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal("deploy"),
  ...runOutcomeBase,
  image: z.string().min(1),
  installId: selfManagedInstallIdSchema,
  /** Every expected Worker, in the request's order; all exist. */
  workers: z.array(selfManagedWorkerSchema),
  /** The Workers, and what they bind that belongs to them (not other Workers' classes). */
  resources: z.array(selfManagedResourceSchema).max(200),
});
export type SelfManagedDeployResult = z.infer<typeof selfManagedDeployResultSchema>;

/** A finished destroy. */
export const selfManagedDestroyResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal("destroy"),
  ...runOutcomeBase,
  image: z.string().min(1),
  installId: selfManagedInstallIdSchema,
  /** Expected Workers that still exist after the destroy command succeeded. */
  remaining: z.array(selfManagedWorkerNameSchema),
});
export type SelfManagedDestroyResult = z.infer<typeof selfManagedDestroyResultSchema>;

/** A run that did not finish. */
export const selfManagedFailureSchema = z.object({
  ok: z.literal(false),
  action: z.enum(["deploy", "destroy"]),
  ...runOutcomeBase,
  step: selfManagedStepSchema,
  message: z.string().min(1),
  /**
   * True when running it again may succeed: the container could not start
   * or went away, or the account did not answer. A failing command is never
   * retryable, nor is a missing token.
   */
  retryable: z.boolean(),
  exitCode: z.int().nullable(),
});
export type SelfManagedFailure = z.infer<typeof selfManagedFailureSchema>;

export const selfManagedOutcomeSchema = z.union([
  selfManagedDeployResultSchema,
  selfManagedDestroyResultSchema,
  selfManagedFailureSchema,
]);
export type SelfManagedOutcome = z.infer<typeof selfManagedOutcomeSchema>;

/**
 * `SandboxBuilds.selfManagedStatus()` input: what the sandbox Worker holds
 * for an install, and which of its Workers the account has now.
 */
export const selfManagedStatusRequestSchema = z.object({
  protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
  installId: selfManagedInstallIdSchema,
  accountId: z.string().regex(/^[0-9a-f]{32}$/, "must be a Cloudflare account id"),
  /** The app secrets the install needs; the answer says whether all are held. */
  secretNames: z.array(installerEnvNameSchema).max(32),
  expectedWorkers: z.array(selfManagedWorkerNameSchema).min(1).max(8),
});
export type SelfManagedStatusRequest = z.infer<typeof selfManagedStatusRequestSchema>;

/** `SandboxBuilds.selfManagedStatus()` result. */
export const selfManagedStatusSchema = z.object({
  protocol: z.int(),
  sandboxVersion: z.string().min(1),
  /** The sandbox Worker holds the install's app token. */
  tokenPresent: z.boolean(),
  /** It holds every secret named in the request (true when none were named). */
  secretsPresent: z.boolean(),
  /**
   * The expected Workers that exist in the account, read with the app token;
   * null when there is no token to read with or the account did not answer.
   */
  workers: z.array(selfManagedWorkerSchema).nullable(),
  /** Why `workers` is null, when it is. */
  problem: z.string().nullable(),
});
export type SelfManagedStatus = z.infer<typeof selfManagedStatusSchema>;
