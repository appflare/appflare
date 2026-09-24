import {
  type BuildRequest,
  buildCommandArgv,
  buildKeys,
  buildRequestSchema,
  type CatalogManifest,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  gitShaSchema,
  type IndexApp,
  type IndexArtifacts,
  type IndexBuild,
  indexAppArtifact,
  SANDBOX_PROTOCOL_VERSION,
  type SigningKey,
  sandboxInstanceTypeSchema,
  sandboxObjectUrl,
  sha256Schema,
} from "@appflare/schema";
import { z } from "zod";
import { MANIFEST_TTL_SECONDS, manifestCacheKey } from "../../catalog/app-manifest.server";
import type { BuildKind } from "../../db/schema";
import {
  parseBuildOutcome,
  SandboxProtocolError,
  sandboxBinding,
  sandboxFetch,
  sandboxInfo,
} from "../../sandbox/binding";
import { verifyBuiltManifest, verifyCatalogManifest } from "../../sandbox/verify";
import type { JobEnv, StepConfig } from "../run-job";
import { JobError, type JobSteps } from "../steps";
import type { ArtifactHost } from "../units/units";
import { fetchWhole, sha256Hex } from "./artifact";
import { loadVerifiedManifest, verifyManifestPhase } from "./phases";

/**
 * Where a job gets the artifact it installs: a signed catalog release, or a
 * build of the pinned commit in the sandbox Worker (the `sandbox` tier).
 * Either way the job continues with the same artifact flow; only the host the
 * units read the zip from and the provenance recorded on the install differ.
 */

/** A sandbox tier build, as the job payload carries it (from the index's `build`). */
export const sandboxBuildParams = z.object({
  pin: gitShaSchema,
  manifestUrl: z.url(),
  manifestDigest: sha256Schema,
  instanceType: sandboxInstanceTypeSchema.optional(),
  /** The admin confirmed the build's cost on Workers Paid. */
  costConfirmed: z.boolean(),
});
export type SandboxBuildParams = z.infer<typeof sandboxBuildParams>;

/** How the running code was built, as `installs` and `snapshots` record it. */
export interface Provenance {
  build_kind: BuildKind;
  /** The container image of a sandbox build. */
  sandbox_image: string | null;
  built_at: Date | null;
}

export const SIGNED_PROVENANCE: Provenance = {
  build_kind: "artifact",
  sandbox_image: null,
  built_at: null,
};

export interface ArtifactSource {
  /** The zip the units read, by Range. */
  zipUrl: string;
  host: ArtifactHost;
  /** sha256 of `manifest.json`. */
  digest: string;
  /** The verified `manifest.json`, exactly as read. */
  manifestText: string;
  provenance: Provenance;
}

export type ArtifactOrigin =
  | { kind: "release"; artifacts: IndexArtifacts; digest: string }
  | { kind: "sandbox"; build: SandboxBuildParams };

/** A sandbox build as the job payload carries it, from the index entry's `build`. */
export function sandboxBuildOf(build: IndexBuild, costConfirmed: boolean): SandboxBuildParams {
  return {
    pin: build.pin,
    manifestUrl: build.manifest,
    manifestDigest: build.manifestDigest,
    ...(build.instanceType === undefined ? {} : { instanceType: build.instanceType }),
    costConfirmed,
  };
}

/**
 * Where an index entry's artifact comes from: its sandbox build for a
 * `sandbox` tier entry, else its signed release. Throws `JobError` for an
 * entry that has neither (a tier this manager cannot install).
 */
export function artifactOriginOf(app: IndexApp, costConfirmed: boolean): ArtifactOrigin {
  if (app.tier === "sandbox" && app.build !== undefined) {
    return { kind: "sandbox", build: sandboxBuildOf(app.build, costConfirmed) };
  }
  const release = indexAppArtifact(app);
  if (app.tier !== "artifact" || release === null) {
    throw new JobError(`Appflare cannot install ${app.tier} tier apps yet`);
  }
  return { kind: "release", ...release };
}

/**
 * The build step waits on one RPC call for the whole build (typically
 * minutes; the sandbox Worker's own step limits add up to 50). A retry runs
 * the whole build again, and bills it again, so a build runs at most twice:
 * once more after a failure the sandbox Worker marks retryable (the container
 * could not start or went away), a lost connection, or this step's timeout.
 * A failure it marks not retryable (a command failed) ends the job at once.
 * Worst case, two attempts of 55 minutes.
 */
export const SANDBOX_BUILD_MAX_ATTEMPTS = 2;
export const SANDBOX_BUILD_STEP: StepConfig = {
  retries: { limit: SANDBOX_BUILD_MAX_ATTEMPTS - 1, delay: "30 seconds", backoff: "constant" },
  timeout: "55 minutes",
};

/** Lines of build output copied into the job log when the build step ends. */
export const BUILD_LOG_LINES = 40;

function tailLines(text: string, lines: number): string[] {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
  return all.slice(-lines);
}

/**
 * Resolves the artifact of `slug` `version` for `installId`: verifies the
 * signed release, or builds the pinned commit in the sandbox Worker and
 * verifies what it built. Every call is its own step.
 */
export async function resolveArtifactPhase(
  steps: JobSteps,
  env: JobEnv,
  keys: readonly SigningKey[] | undefined,
  target: { installId: string; slug: string; version: string; origin: ArtifactOrigin },
): Promise<ArtifactSource> {
  const { origin } = target;
  if (origin.kind === "release") {
    const ref = {
      slug: target.slug,
      version: target.version,
      artifacts: origin.artifacts,
      digest: origin.digest,
    };
    await verifyManifestPhase(steps, env.KV, ref, keys);
    steps.current = "load artifact manifest";
    return {
      zipUrl: origin.artifacts.zip,
      host: { kind: "catalog" },
      digest: origin.digest,
      manifestText: await loadVerifiedManifest(env.KV, steps.baseFetch, ref),
      provenance: SIGNED_PROVENANCE,
    };
  }
  return buildInSandboxPhase(steps, env, { ...target, build: origin.build });
}

async function buildInSandboxPhase(
  steps: JobSteps,
  env: JobEnv,
  target: { installId: string; slug: string; version: string; build: SandboxBuildParams },
): Promise<ArtifactSource> {
  const { build } = target;
  await steps.run("check sandbox Worker", async ({ log }) => {
    if (!build.costConfirmed) {
      throw new JobError(
        "this app is built in the account's sandbox Worker on Workers Paid; confirm the build's cost to install it",
      );
    }
    const binding = sandboxBinding(env);
    if (binding === undefined) {
      throw new JobError(
        "this app is built in the account's sandbox Worker, and Appflare is not connected to one; enable sandbox builds (Settings, Sandbox builds) and try again",
      );
    }
    let info: Awaited<ReturnType<typeof sandboxInfo>>;
    try {
      info = await sandboxInfo(binding);
    } catch (error) {
      if (error instanceof SandboxProtocolError) throw new JobError(error.message);
      throw error;
    }
    log.info(`The sandbox Worker ${info.sandboxVersion} builds with ${info.image}.`);
    return { image: info.image };
  });

  const catalogText = await steps.run("load catalog manifest", async ({ log, fetch }) => {
    const file = await fetchWhole(fetch, build.manifestUrl);
    await verifyCatalogManifest(file.bytes, {
      slug: target.slug,
      pin: build.pin,
      digest: build.manifestDigest,
    });
    log.info(
      `Loaded the catalog manifest of ${target.slug} (digest matches the catalog, pinned to ${build.pin.slice(0, 12)}).`,
    );
    return { text: new TextDecoder().decode(file.bytes) };
  });
  steps.current = "load catalog manifest";
  const catalog: CatalogManifest = await verifyCatalogManifest(
    new TextEncoder().encode(catalogText.text),
    { slug: target.slug, pin: build.pin, digest: build.manifestDigest },
  );

  steps.current = "prepare build request";
  const parsedRequest = buildRequestSchema.safeParse({
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: target.installId,
    version: target.version,
    repo: catalog.repo,
    sha: build.pin,
    wranglerConfigPath: catalog.install.wranglerConfig,
    ...(catalog.install.buildCommand === undefined
      ? {}
      : { buildCommand: buildCommandArgv(catalog.install.buildCommand) }),
    catalogManifest: catalog,
    instanceType: build.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE,
  });
  if (!parsedRequest.success) {
    throw new JobError(
      `the catalog entry cannot be built in the sandbox Worker: ${z.prettifyError(parsedRequest.error).replace(/\s+/g, " ")}`,
    );
  }
  const request: BuildRequest = parsedRequest.data;

  const built = await steps.run(
    "build in sandbox",
    async ({ log, attempt }) => {
      const binding = sandboxBinding(env);
      if (binding === undefined) throw new JobError("the SANDBOX binding went away");
      let outcome: ReturnType<typeof parseBuildOutcome>;
      try {
        // A retry builds in a container of its own (see the request's `attempt`).
        outcome = parseBuildOutcome(await binding.build({ ...request, attempt }));
      } catch (error) {
        if (error instanceof SandboxProtocolError) throw new JobError(error.message);
        throw error;
      }
      for (const line of tailLines(outcome.log, BUILD_LOG_LINES)) log.log("debug", line);
      if (!outcome.ok) {
        const message = `the build failed in its ${outcome.stage} step${outcome.exitCode === null ? "" : ` (exit code ${outcome.exitCode})`}: ${outcome.message}`;
        // Only a container that could not start or went away is worth another run.
        if (outcome.retryable) throw new Error(message);
        throw new JobError(message);
      }
      if (outcome.installId !== target.installId || outcome.version !== target.version) {
        throw new JobError(
          `the sandbox Worker built ${outcome.installId} ${outcome.version}, not ${target.installId} ${target.version}`,
        );
      }
      const expected = buildKeys(target.installId, target.version, target.slug);
      if (outcome.manifestKey !== expected.manifest || outcome.artifactKey !== expected.artifact) {
        throw new JobError("the sandbox Worker stored the build under unexpected keys");
      }
      log.info(
        `Built ${target.slug} ${target.version} from ${build.pin.slice(0, 12)} in ${outcome.minutes} minute(s) with ${outcome.image} (${outcome.size} bytes, unsigned).`,
      );
      return {
        digest: outcome.digest,
        manifestKey: outcome.manifestKey,
        artifactKey: outcome.artifactKey,
        image: outcome.image,
        builtAt: new Date(steps.now()).toISOString(),
      };
    },
    SANDBOX_BUILD_STEP,
  );

  const manifestUrl = sandboxObjectUrl(built.manifestKey);
  const readThroughSandbox = sandboxFetch(env);
  await steps.run("verify built manifest", async ({ log }) => {
    const file = await fetchWhole(readThroughSandbox, manifestUrl);
    const manifest = await verifyBuiltManifest(file.bytes, {
      slug: target.slug,
      version: target.version,
      pin: build.pin,
      digest: built.digest,
      catalog,
    });
    const key = manifestCacheKey(built.digest);
    if (env.KV !== undefined && (await env.KV.get(key)) === null) {
      await env.KV.put(key, new TextDecoder().decode(file.bytes), {
        expirationTtl: MANIFEST_TTL_SECONDS,
      });
    }
    log.info(
      `Verified the built manifest.json of ${manifest.app} ${manifest.version}: unsigned, from the pinned commit, digest matches the build.`,
    );
    return {};
  });
  steps.current = "load built manifest";
  const cached = await env.KV?.get(manifestCacheKey(built.digest));
  let manifestText: string;
  if (cached != null && (await sha256Hex(new TextEncoder().encode(cached))) === built.digest) {
    manifestText = cached;
  } else {
    const fetched = await fetchWhole(readThroughSandbox, manifestUrl);
    if ((await sha256Hex(fetched.bytes)) !== built.digest) {
      throw new JobError("the built manifest.json changed since it was verified");
    }
    manifestText = new TextDecoder().decode(fetched.bytes);
  }
  return {
    zipUrl: sandboxObjectUrl(built.artifactKey),
    host: { kind: "sandbox" },
    digest: built.digest,
    manifestText,
    provenance: {
      build_kind: "sandbox",
      sandbox_image: built.image,
      built_at: new Date(built.builtAt),
    },
  };
}

/**
 * Deletes an install's sandbox builds except `keepVersions`. Housekeeping:
 * a failure is logged and never fails the job.
 */
export async function cleanupSandboxBuildsPhase(
  steps: JobSteps,
  env: JobEnv,
  installId: string,
  keepVersions: string[],
): Promise<void> {
  await steps.run("clean up sandbox builds", async ({ log }) => {
    const binding = sandboxBinding(env);
    if (binding === undefined) {
      log.warn(
        "Appflare is not connected to the sandbox Worker, so this install's builds stay in its bucket (appflare-builds).",
      );
      return {};
    }
    try {
      const result = await binding.cleanup({ installId, keepVersions });
      const deleted =
        typeof result === "object" && result !== null && "deleted" in result
          ? Number(result.deleted)
          : 0;
      log.info(
        keepVersions.length === 0
          ? `Deleted this install's sandbox builds (${deleted} object(s)).`
          : `Deleted sandbox builds other than ${keepVersions.join(" and ")} (${deleted} object(s)).`,
      );
    } catch (error) {
      log.warn(
        `Could not delete old sandbox builds: ${error instanceof Error ? error.message : String(error)}. They stay in the bucket appflare-builds.`,
      );
    }
    return {};
  });
}
