import { z } from "zod";
import { sha256Schema } from "./artifact";
import {
  buildCommandArgv,
  catalogInstallSchema,
  gitShaSchema,
  ownerRepoSchema,
  packageManagerSchema,
  sandboxInstanceTypeSchema,
} from "./catalog";

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
 * The container image a sandbox Worker version runs. Tags are immutable: a sandbox Worker
 * version always runs exactly the image built from its release commit.
 * Docker Hub, because Cloudflare Containers pull only from the Cloudflare
 * registry, Docker Hub, Amazon ECR, and Google Artifact Registry.
 */
export const SANDBOX_IMAGE_REPOSITORY = "docker.io/appflare/sandbox";

/** Git tags and GitHub Releases of the sandbox Worker are `sandbox@<version>`. */
export const SANDBOX_RELEASE_TAG_PREFIX = "sandbox@";

export function sandboxImage(version: string): string {
  return `${SANDBOX_IMAGE_REPOSITORY}:${version}`;
}

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
    // environment assignments, at most 256 characters.
    buildCommand: catalogInstallSchema.shape.buildCommand,
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
     * manifest declares none.
     */
    buildCommand: buildCommandArgvSchema.optional(),
    /** Relative to the project; must equal the catalog manifest's `install.wranglerConfig`. */
    wranglerConfigPath: checkoutPathSchema,
    /** The entry's `appflare.jsonc`, parsed; recorded verbatim in the artifact. */
    catalogManifest: buildCatalogManifestSchema,
    instanceType: sandboxInstanceTypeSchema.optional(),
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
    const declared = manifest.install.buildCommand;
    if (request.buildCommand !== undefined) {
      if (declared === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["buildCommand"],
          message:
            "is set, but the catalog manifest declares no install.buildCommand; the build command comes from the manifest only",
        });
      } else if (buildCommandArgv(declared).join(" ") !== request.buildCommand.join(" ")) {
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
 * container; `build` is the entry's `install.buildCommand`, which runs inside
 * the packer, reported separately when it is what failed.
 */
export const buildStageSchema = z.enum([
  "request",
  "checkout",
  "install",
  "build",
  "pack",
  "upload",
  "verify",
]);
export type BuildStage = z.infer<typeof buildStageSchema>;

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

/** A running or finished build, as the manager's job page polls it. */
export const buildProgressSchema = z.object({
  state: z.enum(["running", "succeeded", "failed"]),
  stage: buildStageSchema,
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
