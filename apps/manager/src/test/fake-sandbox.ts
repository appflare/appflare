import {
  appSecretSecretName,
  appTokenSecretName,
  type BuildOutcome,
  type BuildProgress,
  buildCommandText,
  buildKeys,
  buildRequestSchema,
  type CatalogManifest,
  githubFetchRequestSchema,
  type IndexApp,
  type RepositoryBuildOutcome,
  type RepositoryBuildRequest,
  repositoryBuildRequestSchema,
  SANDBOX_FEATURE_GITHUB_TOKENS,
  SANDBOX_FEATURE_REPOSITORY,
  SANDBOX_FEATURE_SELF_DEPLOYING,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInfo,
  type SelfManagedOutcome,
  type SelfManagedRunRequest,
  sandboxObjectUrl,
  selfManagedRunRequestSchema,
  selfManagedStatusRequestSchema,
} from "@appflare/schema";
import { sha256Hex } from "../jobs/install/artifact";
import type { SandboxBuildsBinding } from "../sandbox/binding";
import type { ArtifactFixture } from "./artifact-fixture";

/**
 * Test-only stand-in for the `SANDBOX` service binding to the sandbox
 * Worker: `info`, `build`, `progress` and `cleanup` as RPC methods (arguments
 * and results structured-cloned, as RPC does), and `fetch` serving the build
 * objects with Range support, the way the sandbox Worker serves its R2
 * bucket. A build "produces" the given artifact fixture: its zip and
 * manifest.json are stored under the keys the request names.
 *
 * Self-deploying runs (`deploySelfManaged`, `destroySelfManaged`,
 * `selfManagedStatus`) answer from `selfManaged`: by default a deploy creates
 * every expected Worker (the first with a workers.dev URL) and a D1 database,
 * and a destroy leaves nothing. The token and secrets the sandbox Worker
 * holds are the names in `selfManaged.held` (the test's fake Cloudflare API
 * adds them when the manager stores them); without it, everything is held.
 */

export const SANDBOX_IMAGE = "docker.io/mendylanda/appflare-sandbox:0.4.0";
export const CATALOG_MANIFEST_URL = "https://appflare.github.io/catalog/apps/cut/appflare.json";

export interface FakeSandboxOptions {
  /** Replaces the build's answer (the default builds the fixture). */
  outcome?: (request: { installId: string; version: string }) => BuildOutcome;
  /** Retryable failures (the container went away) before a build succeeds. */
  retryableFailures?: number;
  /**
   * Replaces the answer of a build from a repository (the default stores
   * the fixture as that build, from the fixture's commit).
   */
  repositoryOutcome?: (request: RepositoryBuildRequest) => RepositoryBuildOutcome;
  /** Bytes served as manifest.json instead of the fixture's (a tampered bucket). */
  manifestBytes?: Uint8Array;
  info?: SandboxInfo;
  /**
   * The version each `info()` call reports as answering (`versionId`), in
   * order; the last one again after that. Absent: no `versionId` (a sandbox
   * Worker without the version metadata binding).
   */
  versionIds?: string[];
  progress?: BuildProgress | null;
  /** Builds already in the bucket (the fixture's bytes), as an earlier install left them. */
  stored?: Array<{ installId: string; version: string; slug: string }>;
  selfManaged?: {
    /** Names of the secrets the sandbox Worker holds; everything when absent. */
    held?: Set<string>;
    deploy?: (request: SelfManagedRunRequest) => SelfManagedOutcome;
    /** Expected Workers a destroy leaves behind. */
    remaining?: string[];
    /** Retryable failures (the container went away) before a run succeeds. */
    retryableFailures?: number;
  };
  /**
   * GitHub as seen with the sandbox Worker's GitHub access tokens: the
   * answer to a `githubFetch` with the named token secret. Absent: 404.
   * Throw to play a token the sandbox Worker does not hold.
   */
  github?: (request: { url: string; tokenSecret: string; headers: Headers }) => Response;
}

export interface FakeSandbox extends SandboxBuildsBinding {
  /** How often `info()` was called. */
  infoCalls: number;
  requests: unknown[];
  cleanups: unknown[];
  progressCalls: unknown[];
  /** `METHOD url range` of every fetch. */
  fetches: string[];
  /** Every self-deploying run request, deploy and destroy. */
  runs: SelfManagedRunRequest[];
  statusCalls: unknown[];
  /** Every `githubFetch` request, as sent (names only: the fake holds no token). */
  githubRequests: unknown[];
}

/** `fixture` is what a build produces; null for a fake that only runs installers. */
export function fakeSandbox(
  fixture: ArtifactFixture | null,
  opts: FakeSandboxOptions = {},
): FakeSandbox {
  const objects = new Map<string, Uint8Array>();
  for (const build of opts.stored ?? []) {
    if (fixture === null) throw new Error("a stored build needs a fixture");
    const keys = buildKeys(build.installId, build.version, build.slug);
    objects.set(keys.manifest, fixture.manifestBytes);
    objects.set(keys.artifact, fixture.zip);
  }
  const requests: unknown[] = [];
  const cleanups: unknown[] = [];
  const progressCalls: unknown[] = [];
  const fetches: string[] = [];
  let failuresLeft = opts.retryableFailures ?? 0;
  let runFailuresLeft = opts.selfManaged?.retryableFailures ?? 0;
  const runs: SelfManagedRunRequest[] = [];
  const statusCalls: unknown[] = [];
  const githubRequests: unknown[] = [];

  function selfManagedRun(action: "deploy" | "destroy", input: unknown): SelfManagedOutcome {
    const request = selfManagedRunRequestSchema.parse(structuredClone(input));
    runs.push(request);
    const common = {
      protocol: SANDBOX_PROTOCOL_VERSION,
      sandboxVersion: "0.4.0",
      minutes: 6.5,
      logKey: `builds/${request.installId}/${request.runId}/log.txt`,
      log: `Running the installer\n$ ${request.command.join(" ")} ${request.stageArg} ${request.stage}\n`,
    };
    if (runFailuresLeft > 0) {
      runFailuresLeft -= 1;
      return {
        ok: false,
        action,
        ...common,
        step: "checkout",
        message: "the container could not start",
        retryable: true,
        exitCode: null,
      };
    }
    if (action === "deploy") {
      if (opts.selfManaged?.deploy !== undefined) {
        return structuredClone(opts.selfManaged.deploy(request));
      }
      const [main, ...others] = request.expectedWorkers;
      return {
        ok: true,
        action,
        ...common,
        image: SANDBOX_IMAGE,
        installId: request.installId,
        workers: [
          ...(main === undefined ? [] : [{ name: main, url: `https://${main}.acme.workers.dev` }]),
          ...others.map((name) => ({ name, url: null })),
        ],
        resources: [
          ...request.expectedWorkers.map((name) => ({
            kind: "worker" as const,
            name,
            cfId: name,
            worker: name,
            binding: null,
          })),
          {
            kind: "d1" as const,
            name: `db-${request.stage}`,
            cfId: `d1-${request.stage}`,
            worker: main ?? "",
            binding: "DB",
          },
        ],
      };
    }
    return {
      ok: true,
      action,
      ...common,
      image: SANDBOX_IMAGE,
      installId: request.installId,
      remaining: opts.selfManaged?.remaining ?? [],
    };
  }
  const base = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    sandboxVersion: "0.4.0",
    minutes: 3.2,
    logKey: null,
    log: "Cloning\nInstalling\nPacking\n",
  };

  const fake: FakeSandbox = {
    infoCalls: 0,
    requests,
    cleanups,
    progressCalls,
    fetches,
    runs,
    statusCalls,
    githubRequests,
    async info() {
      fake.infoCalls += 1;
      const versions = opts.versionIds ?? [];
      const versionId = versions[Math.min(fake.infoCalls, versions.length) - 1];
      return structuredClone({
        ...(opts.info ?? {
          protocol: SANDBOX_PROTOCOL_VERSION,
          sandboxVersion: "0.4.0",
          image: SANDBOX_IMAGE,
          features: [
            SANDBOX_FEATURE_SELF_DEPLOYING,
            SANDBOX_FEATURE_REPOSITORY,
            SANDBOX_FEATURE_GITHUB_TOKENS,
          ],
        }),
        ...(versionId === undefined ? {} : { versionId }),
      });
    },
    async githubFetch(input) {
      githubRequests.push(structuredClone(input));
      const request = githubFetchRequestSchema.parse(structuredClone(input));
      if (opts.github === undefined) return new Response("Not Found", { status: 404 });
      return opts.github({
        url: request.url,
        tokenSecret: request.tokenSecret,
        headers: new Headers(request.headers),
      });
    },
    async deploySelfManaged(input) {
      return selfManagedRun("deploy", input);
    },
    async destroySelfManaged(input) {
      return selfManagedRun("destroy", input);
    },
    async selfManagedStatus(input) {
      statusCalls.push(structuredClone(input));
      const request = selfManagedStatusRequestSchema.parse(structuredClone(input));
      const held = opts.selfManaged?.held;
      const has = (name: string) => held === undefined || held.has(name);
      const tokenPresent = has(appTokenSecretName(request.installId));
      return {
        protocol: SANDBOX_PROTOCOL_VERSION,
        sandboxVersion: "0.4.0",
        tokenPresent,
        secretsPresent: request.secretNames.every((n) =>
          has(appSecretSecretName(request.installId, n)),
        ),
        workers: tokenPresent ? [] : null,
        problem: tokenPresent ? null : "no token",
      };
    },
    async build(input) {
      requests.push(structuredClone(input));
      const request = buildRequestSchema.parse(structuredClone(input));
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return {
          ok: false,
          ...base,
          stage: "checkout",
          message: "the container could not start",
          retryable: true,
          exitCode: null,
        } satisfies BuildOutcome;
      }
      if (opts.outcome !== undefined) return structuredClone(opts.outcome(request));
      if (fixture === null) throw new Error("this fake sandbox Worker has nothing to build");
      const keys = buildKeys(request.installId, request.version, request.catalogManifest.slug);
      objects.set(keys.manifest, opts.manifestBytes ?? fixture.manifestBytes);
      objects.set(keys.artifact, fixture.zip);
      return {
        ok: true,
        ...base,
        logKey: keys.log,
        image: SANDBOX_IMAGE,
        installId: request.installId,
        version: request.version,
        digest: fixture.digest,
        size: fixture.zip.byteLength,
        manifestKey: keys.manifest,
        artifactKey: keys.artifact,
      } satisfies BuildOutcome;
    },
    async buildRepository(input) {
      requests.push(structuredClone(input));
      const request = repositoryBuildRequestSchema.parse(structuredClone(input));
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return {
          ok: false,
          ...base,
          stage: "checkout",
          message: "the container could not start",
          retryable: true,
          exitCode: null,
        } satisfies RepositoryBuildOutcome;
      }
      if (opts.repositoryOutcome !== undefined) {
        return structuredClone(opts.repositoryOutcome(request));
      }
      if (fixture === null) throw new Error("this fake sandbox Worker has nothing to build");
      const { version, app } = fixture.manifest;
      const keys = buildKeys(request.installId, version, app);
      objects.set(keys.manifest, opts.manifestBytes ?? fixture.manifestBytes);
      objects.set(keys.artifact, fixture.zip);
      return {
        ok: true,
        ...base,
        logKey: `builds/${request.installId}/${request.runId}/log.txt`,
        image: SANDBOX_IMAGE,
        installId: request.installId,
        version,
        digest: fixture.digest,
        size: fixture.zip.byteLength,
        manifestKey: keys.manifest,
        artifactKey: keys.artifact,
        commit: fixture.manifest.source.sha,
        ref: request.ref ?? "main",
        committedAt: "2026-09-20T10:00:00+00:00",
        detected: {
          packageManager: fixture.manifest.catalog.install.packageManager,
          wranglerConfig: fixture.manifest.catalog.install.wranglerConfig,
          buildCommand:
            fixture.manifest.catalog.install.buildCommand === undefined
              ? null
              : buildCommandText(fixture.manifest.catalog.install.buildCommand),
          buildCommandFrom: "package.json",
          secretsFrom: ".dev.vars.example",
          unsupported: [],
        },
      } satisfies RepositoryBuildOutcome;
    },
    async progress(input) {
      progressCalls.push(structuredClone(input));
      return structuredClone(opts.progress ?? null);
    },
    async cleanup(input) {
      cleanups.push(structuredClone(input));
      return { deleted: objects.size };
    },
    async fetch(input, init) {
      const range = new Headers(init?.headers).get("range");
      fetches.push(`${init?.method ?? "GET"} ${input}${range === null ? "" : ` ${range}`}`);
      const key = input.slice(sandboxObjectUrl("").length);
      const bytes = objects.get(key);
      if (bytes === undefined) return new Response("Not found\n", { status: 404 });
      const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
      if (m === null) return new Response(new Uint8Array(bytes));
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.byteLength - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.byteLength}` },
      });
    },
  };
  return fake;
}

/** The catalog manifest as the catalog publishes it for a sandbox entry, and its digest. */
export async function publishedCatalog(
  catalog: CatalogManifest,
): Promise<{ bytes: Uint8Array; digest: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(catalog, null, 2));
  return { bytes, digest: await sha256Hex(bytes) };
}

/** A sandbox tier index entry for the fixture's app (no artifacts, a build block). */
export async function sandboxIndexApp(
  fixture: ArtifactFixture,
  over: Partial<NonNullable<IndexApp["build"]>> = {},
): Promise<IndexApp> {
  const { artifacts: _artifacts, digest: _digest, ...rest } = fixture.index;
  const published = await publishedCatalog(fixture.manifest.catalog);
  return {
    ...rest,
    tier: "sandbox",
    build: {
      pin: fixture.manifest.catalog.source.sha,
      manifest: CATALOG_MANIFEST_URL,
      manifestDigest: published.digest,
      expectedMinutes: 5,
      ...over,
    },
  };
}
