import {
  type ArtifactManifest,
  artifactManifestSchema,
  type BuildRequest,
  buildCommandArgv,
  buildCommandList,
  buildCommandText,
  buildKeys,
  buildRequestSchema,
  type CatalogManifest,
  catalogManifestSchema,
  catalogRevision,
  catalogRevisionSchema,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  githubRepositorySchema,
  gitRefSchema,
  gitShaSchema,
  type IndexApp,
  type IndexArtifacts,
  type IndexBuild,
  indexAppArtifact,
  indexCatalogManifestSchema,
  repositoryUrl,
  SANDBOX_PROTOCOL_VERSION,
  type SigningKey,
  sandboxInstanceTypeSchema,
  sandboxObjectUrl,
  sha256Schema,
  withRevisedCatalog,
} from "@appflare/schema";
import { z } from "zod";
import { MANIFEST_TTL_SECONDS, manifestCacheKey } from "../../catalog/app-manifest.server";
import {
  recordCatalogRevision,
  recordedRevisionFor,
  verifyRevisedCatalog,
} from "../../catalog/revisions.server";
import type { BuildKind, InstallOrigin } from "../../db/schema";
import { readSettings, SETTING } from "../../db/settings";
import {
  configPatchRefusal,
  d1SeedRefusal,
  installDirsRefusal,
  parseBuildOutcome,
  SandboxProtocolError,
  sandboxBinding,
  sandboxFetch,
  sandboxInfo,
} from "../../sandbox/binding";
import { UPDATE_SANDBOX_HINT } from "../../sandbox/connect-copy";
import {
  verifyBuiltManifest,
  verifyCatalogManifest,
  verifySourceBuildManifest,
} from "../../sandbox/verify";
import type { JobEnv, StepConfig } from "../run-job";
import { awaitSandboxSettledPhase } from "../sandbox-settle";
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

/**
 * A build an admin reviewed before installing or updating: a repository, or
 * a catalog app built from source at another commit, which a `source_build`
 * job built in the sandbox Worker and recorded in `source_builds`. The job
 * payload carries what that job verified; the install or update reads the
 * artifact through the `SANDBOX` binding and checks it again against it.
 */
export const prebuiltBuildParams = z.object({
  /** The `source_builds` row (and its job). */
  buildId: z.string().min(1).max(64),
  origin: z.enum(["repository", "source"]),
  /** `owner/repo` on GitHub. */
  repo: githubRepositorySchema,
  /** The branch, tag or commit it was built from. */
  ref: gitRefSchema,
  commit: gitShaSchema,
  /** The artifact's app: its catalog manifest's slug. */
  app: z.string().min(1).max(64),
  version: z.string().min(1).max(128),
  digest: sha256Schema,
  manifestKey: z.string().min(1),
  artifactKey: z.string().min(1),
  image: z.string().min(1),
  builtAt: z.iso.datetime(),
});
export type PrebuiltBuildParams = z.infer<typeof prebuiltBuildParams>;

/**
 * How the running code was built and where it came from, as `installs` and
 * `snapshots` record it.
 */
export interface Provenance {
  build_kind: BuildKind;
  /** The container image of a sandbox build. */
  sandbox_image: string | null;
  built_at: Date | null;
  origin: InstallOrigin;
  /** Not from the catalog: the repository's URL. */
  source_url: string | null;
  /** Not from the catalog: the branch, tag or commit it was built from. */
  source_ref: string | null;
}

/** From the catalog: none of the fields that describe another source. */
const CATALOG_ORIGIN = { origin: "catalog", source_url: null, source_ref: null } as const;

export const SIGNED_PROVENANCE: Provenance = {
  build_kind: "artifact",
  sandbox_image: null,
  built_at: null,
  ...CATALOG_ORIGIN,
};

export interface ArtifactSource {
  /** The zip the units read, by Range. */
  zipUrl: string;
  host: ArtifactHost;
  /** sha256 of `manifest.json`. */
  digest: string;
  /** The verified `manifest.json`, exactly as read. */
  manifestText: string;
  /**
   * The verified revised catalog manifest of a signed release, exactly as
   * published; null when the release's own copy is current. See
   * {@link sourceManifest}.
   */
  revisedCatalogText: string | null;
  provenance: Provenance;
}

/**
 * The revised catalog manifest the index lists for a release (its URL and
 * sha256, and the row's revision), as a job payload carries it.
 */
export const revisedCatalogRef = indexCatalogManifestSchema.extend({
  revision: catalogRevisionSchema,
});
export type RevisedCatalogRef = z.infer<typeof revisedCatalogRef>;

/** The revision an index row lists for its release, or null when the release's copy is current. */
export function revisedCatalogOf(app: IndexApp): RevisedCatalogRef | null {
  return app.catalogManifest === undefined
    ? null
    : { ...app.catalogManifest, revision: catalogRevision(app) };
}

/**
 * The artifact manifest a job installs: the verified `manifest.json`, with
 * the verified revised catalog manifest in place of its own when there is one
 * (the forms, secrets and vars come from the revision; the Worker never does).
 */
export function sourceManifest(
  source: Pick<ArtifactSource, "manifestText" | "revisedCatalogText">,
): ArtifactManifest {
  const manifest = artifactManifestSchema.parse(JSON.parse(source.manifestText));
  if (source.revisedCatalogText === null) return manifest;
  return withRevisedCatalog(
    manifest,
    catalogManifestSchema.parse(JSON.parse(source.revisedCatalogText)),
  );
}

export type ArtifactOrigin =
  | {
      kind: "release";
      artifacts: IndexArtifacts;
      digest: string;
      /** A revision of the release's catalog manifest to install with it. */
      revised?: RevisedCatalogRef;
    }
  | { kind: "sandbox"; build: SandboxBuildParams }
  | { kind: "prebuilt"; build: PrebuiltBuildParams };

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
  const revised = revisedCatalogOf(app);
  return { kind: "release", ...release, ...(revised === null ? {} : { revised }) };
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
 * verifies what it built. Every call is its own step. `keys` are the keys
 * of the catalog the app comes from (`catalogId`; the official catalog's
 * built-in keys when undefined), and nothing else verifies its release.
 */
export async function resolveArtifactPhase(
  steps: JobSteps,
  env: JobEnv,
  keys: readonly SigningKey[] | undefined,
  target: {
    installId: string;
    catalogId?: string;
    slug: string;
    version: string;
    origin: ArtifactOrigin;
  },
): Promise<ArtifactSource> {
  const { origin } = target;
  if (origin.kind === "release") {
    const ref = {
      ...(target.catalogId === undefined ? {} : { catalogId: target.catalogId }),
      slug: target.slug,
      version: target.version,
      artifacts: origin.artifacts,
      digest: origin.digest,
    };
    await verifyManifestPhase(steps, env.KV, ref, keys);
    steps.current = "load artifact manifest";
    const manifestText = await loadVerifiedManifest(env.KV, steps.baseFetch, ref);
    return {
      zipUrl: origin.artifacts.zip,
      host: { kind: "catalog" },
      digest: origin.digest,
      manifestText,
      revisedCatalogText:
        origin.revised === undefined
          ? null
          : await revisedCatalogPhase(steps, keys, origin.revised, {
              digest: origin.digest,
              manifestText,
            }),
      provenance: SIGNED_PROVENANCE,
    };
  }
  if (origin.kind === "prebuilt") {
    return prebuiltArtifactPhase(steps, env, { ...target, build: origin.build });
  }
  return buildInSandboxPhase(steps, env, { ...target, build: origin.build });
}

/**
 * Step "verify revised catalog manifest": the revision the index lists for a
 * signed release, or the higher one this manager already recorded for it.
 * A listed revision is fetched and verified against the index (sha256,
 * revision, the signature with the release's key id) and against the
 * verified `manifest.json` (same app, only the form and copy changed), then
 * recorded for the release so the install's Settings, and later jobs, read the
 * same form. An unreachable or refused revision fails the job. Returns the
 * revision's exact text.
 */
async function revisedCatalogPhase(
  steps: JobSteps,
  keys: readonly SigningKey[] | undefined,
  ref: RevisedCatalogRef,
  release: { digest: string; manifestText: string },
): Promise<string> {
  const { catalogText } = await steps.run(
    "verify revised catalog manifest",
    async ({ log, fetch, orm }) => {
      const artifact = artifactManifestSchema.parse(JSON.parse(release.manifestText));
      const recorded = await recordedRevisionFor(orm, artifact, release.digest);
      if (recorded !== null && recorded.revision >= ref.revision) {
        log.info(
          `Using revision ${recorded.revision} of the catalog manifest for ${artifact.app} ${artifact.version}, verified earlier; the Worker comes from the signed release.`,
        );
        return { catalogText: recorded.text };
      }
      const file = await fetchWhole(fetch, ref.url);
      const catalog = await verifyRevisedCatalog(file.bytes, {
        file: ref,
        artifact,
        revision: ref.revision,
        ...(keys === undefined ? {} : { keys }),
      });
      const text = new TextDecoder().decode(file.bytes);
      await recordCatalogRevision(
        orm,
        release.digest,
        { text, file: ref, catalog },
        new Date(steps.now()),
      );
      log.info(
        `Verified revision ${ref.revision} of the catalog manifest for ${artifact.app} ${artifact.version} (signed with key "${ref.keyId}"): the settings form comes from it, the Worker from the signed release.`,
      );
      return { catalogText: text };
    },
  );
  return catalogText;
}

/**
 * A reviewed build from a repository (or from source): nothing is built
 * again. Its `manifest.json` is read through the `SANDBOX` binding and must
 * still be exactly what the build job verified (same sha256), under this
 * install's object prefix; the units then read the zip the same way.
 */
async function prebuiltArtifactPhase(
  steps: JobSteps,
  env: JobEnv,
  target: { installId: string; version: string; build: PrebuiltBuildParams },
): Promise<ArtifactSource> {
  const { build } = target;
  const readThroughSandbox = sandboxFetch(env);
  const manifestUrl = sandboxObjectUrl(build.manifestKey);
  await steps.run("verify built manifest", async ({ log }) => {
    if (sandboxBinding(env) === undefined) {
      throw new JobError(
        "this app was built in the account's sandbox Worker, and Appflare is not connected to it any more; enable sandbox builds (Settings, Sandbox builds) and try again",
      );
    }
    if (build.version !== target.version) {
      throw new JobError(`the build is version ${build.version}, not ${target.version}`);
    }
    const expected = buildKeys(target.installId, build.version, build.app);
    if (build.manifestKey !== expected.manifest || build.artifactKey !== expected.artifact) {
      throw new JobError("the build is stored under another install's keys");
    }
    let file: Awaited<ReturnType<typeof fetchWhole>>;
    try {
      file = await fetchWhole(readThroughSandbox, manifestUrl);
    } catch (error) {
      throw new JobError(
        `the build's manifest.json could not be read from the sandbox Worker's bucket (${error instanceof Error ? error.message : String(error)}); build it again`,
      );
    }
    const manifest = await verifySourceBuildManifest(file.bytes, {
      repo: build.repo,
      commit: build.commit,
      version: build.version,
      digest: build.digest,
      slug: build.app,
    });
    const key = manifestCacheKey(build.digest);
    if (env.KV !== undefined && (await env.KV.get(key)) === null) {
      await env.KV.put(key, new TextDecoder().decode(file.bytes), {
        expirationTtl: MANIFEST_TTL_SECONDS,
      });
    }
    log.info(
      `Verified the reviewed build of ${manifest.app} ${manifest.version}: unsigned, from ${build.repo} at ${build.commit.slice(0, 12)}, digest unchanged since the build.`,
    );
    return {};
  });
  steps.current = "load built manifest";
  const cached = await env.KV?.get(manifestCacheKey(build.digest));
  let manifestText: string;
  if (cached != null && (await sha256Hex(new TextEncoder().encode(cached))) === build.digest) {
    manifestText = cached;
  } else {
    const fetched = await fetchWhole(readThroughSandbox, manifestUrl);
    if ((await sha256Hex(fetched.bytes)) !== build.digest) {
      throw new JobError("the built manifest.json changed since it was verified");
    }
    manifestText = new TextDecoder().decode(fetched.bytes);
  }
  return {
    zipUrl: sandboxObjectUrl(build.artifactKey),
    host: { kind: "sandbox" },
    digest: build.digest,
    manifestText,
    revisedCatalogText: null,
    provenance: {
      build_kind: "sandbox",
      sandbox_image: build.image,
      built_at: new Date(build.builtAt),
      origin: build.origin,
      source_url: repositoryUrl(build.repo),
      source_ref: build.ref,
    },
  };
}

async function buildInSandboxPhase(
  steps: JobSteps,
  env: JobEnv,
  target: { installId: string; slug: string; version: string; build: SandboxBuildParams },
): Promise<ArtifactSource> {
  const { build } = target;
  const checked = await steps.run("check sandbox Worker", async ({ log, orm }) => {
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
    // The wait before the build reads the sandbox Worker's deployment, so the
    // account is needed before the job's own preflight reads it.
    const settings = await readSettings(orm, [SETTING.accountId]);
    if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
    log.info(`The sandbox Worker ${info.sandboxVersion} builds with ${info.image}.`);
    return {
      image: info.image,
      accountId: settings.account_id,
      // What the sandbox Worker can build, checked against the catalog manifest below.
      sandbox: { sandboxVersion: info.sandboxVersion, features: info.features ?? [] },
    };
  });
  steps.setAccountId(checked.accountId);

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
  // A job resumed from before this check recorded no features: nothing to refuse then.
  if (checked.sandbox !== undefined) {
    const refused =
      installDirsRefusal(checked.sandbox, catalog, UPDATE_SANDBOX_HINT) ??
      configPatchRefusal(checked.sandbox, catalog, UPDATE_SANDBOX_HINT) ??
      d1SeedRefusal(checked.sandbox, catalog, UPDATE_SANDBOX_HINT);
    if (refused !== null) throw new JobError(refused);
  }
  const parsedRequest = buildRequestSchema.safeParse({
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: target.installId,
    version: target.version,
    repo: catalog.repo,
    sha: build.pin,
    wranglerConfigPath: catalog.install.wranglerConfig,
    ...(catalog.install.buildCommand === undefined
      ? {}
      : buildCommandList(catalog.install.buildCommand).length === 1
        ? // Only a single command is repeated; the packer runs a list from the manifest.
          { buildCommand: buildCommandArgv(buildCommandText(catalog.install.buildCommand)) }
        : {}),
    catalogManifest: catalog,
    instanceType: build.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE,
  });
  if (!parsedRequest.success) {
    throw new JobError(
      `the catalog entry cannot be built in the sandbox Worker: ${z.prettifyError(parsedRequest.error).replace(/\s+/g, " ")}`,
    );
  }
  const request: BuildRequest = parsedRequest.data;

  // A build writes no secrets, but a secret change made on the sandbox Worker
  // just before this job may still be rolling out and would reset the build's
  // container as it starts.
  await awaitSandboxSettledPhase(steps, checked.accountId);
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
    revisedCatalogText: null,
    provenance: {
      build_kind: "sandbox",
      sandbox_image: built.image,
      built_at: new Date(built.builtAt),
      ...CATALOG_ORIGIN,
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
