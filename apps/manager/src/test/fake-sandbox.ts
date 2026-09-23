import {
  type BuildOutcome,
  type BuildProgress,
  buildKeys,
  buildRequestSchema,
  type CatalogManifest,
  type IndexApp,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInfo,
  sandboxObjectUrl,
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
}

export interface FakeSandbox extends SandboxBuildsBinding {
  requests: unknown[];
  cleanups: unknown[];
  progressCalls: unknown[];
  /** `METHOD url range` of every fetch. */
  fetches: string[];
}

export function fakeSandbox(fixture: ArtifactFixture, opts: FakeSandboxOptions = {}): FakeSandbox {
  const objects = new Map<string, Uint8Array>();
  const requests: unknown[] = [];
  const cleanups: unknown[] = [];
  const progressCalls: unknown[] = [];
  const fetches: string[] = [];
  let failuresLeft = opts.retryableFailures ?? 0;
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
    async info() {
      return structuredClone(
        opts.info ?? {
          protocol: SANDBOX_PROTOCOL_VERSION,
          sandboxVersion: "0.4.0",
          image: SANDBOX_IMAGE,
        },
      );
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
