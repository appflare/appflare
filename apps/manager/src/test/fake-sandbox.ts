import {
  appSecretSecretName,
  appTokenSecretName,
  type BuildOutcome,
  type BuildProgress,
  buildKeys,
  buildRequestSchema,
  type CatalogManifest,
  type IndexApp,
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

export const SANDBOX_IMAGE = "docker.io/appflare/sandbox:0.4.0";
export const CATALOG_MANIFEST_URL = "https://appflare.github.io/catalog/apps/cut/appflare.json";

export interface FakeSandboxOptions {
  /** Replaces the build's answer (the default builds the fixture). */
  outcome?: (request: { installId: string; version: string }) => BuildOutcome;
  /** Retryable failures (the container went away) before a build succeeds. */
  retryableFailures?: number;
  /** Bytes served as manifest.json instead of the fixture's (a tampered bucket). */
  manifestBytes?: Uint8Array;
  info?: SandboxInfo;
  progress?: BuildProgress | null;
  selfManaged?: {
    /** Names of the secrets the sandbox Worker holds; everything when absent. */
    held?: Set<string>;
    deploy?: (request: SelfManagedRunRequest) => SelfManagedOutcome;
    /** Expected Workers a destroy leaves behind. */
    remaining?: string[];
    /** Retryable failures (the container went away) before a run succeeds. */
    retryableFailures?: number;
  };
}

export interface FakeSandbox extends SandboxBuildsBinding {
  requests: unknown[];
  cleanups: unknown[];
  progressCalls: unknown[];
  /** `METHOD url range` of every fetch. */
  fetches: string[];
  /** Every self-deploying run request, deploy and destroy. */
  runs: SelfManagedRunRequest[];
  statusCalls: unknown[];
}

/** `fixture` is what a build produces; null for a fake that only runs installers. */
export function fakeSandbox(
  fixture: ArtifactFixture | null,
  opts: FakeSandboxOptions = {},
): FakeSandbox {
  const objects = new Map<string, Uint8Array>();
  const requests: unknown[] = [];
  const cleanups: unknown[] = [];
  const progressCalls: unknown[] = [];
  const fetches: string[] = [];
  let failuresLeft = opts.retryableFailures ?? 0;
  let runFailuresLeft = opts.selfManaged?.retryableFailures ?? 0;
  const runs: SelfManagedRunRequest[] = [];
  const statusCalls: unknown[] = [];

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

  return {
    requests,
    cleanups,
    progressCalls,
    fetches,
    runs,
    statusCalls,
    async info() {
      return structuredClone(
        opts.info ?? {
          protocol: SANDBOX_PROTOCOL_VERSION,
          sandboxVersion: "0.4.0",
          image: SANDBOX_IMAGE,
          features: [SANDBOX_FEATURE_SELF_DEPLOYING],
        },
      );
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
