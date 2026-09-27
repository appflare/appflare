import type { FetchLike } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type ArtifactSpan,
  artifactManifestSchema,
  planSpans,
  type SigningKey,
  signingKeys,
  verifyManifestSignature,
} from "@appflare/schema";
import { fetchCost, isSubrequestLimitError } from "./budget";

/**
 * Reading a signed artifact: the manifest is
 * verified before anything is trusted, and every file is a Range slice of the
 * STORE zip checked against its sha256.
 */

/** A failure that no retry can fix (bad signature, digest mismatch, wrong bytes). */
export class ArtifactError extends Error {
  override name = "ArtifactError";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ExpectedArtifact {
  slug: string;
  version: string;
  /** sha256 hex of `manifest.json` from the catalog index. */
  digest: string;
}

/**
 * Verifies `manifest.json` against `manifest.sig` and the catalog index entry:
 * the Ed25519 signature by `keyId` (unknown ids and `unsigned` are rejected), the
 * schema, `catalog.slug`, `version`, and the sha256 of the exact bytes.
 */
export async function verifyArtifactManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  expected: ExpectedArtifact,
  keys: readonly SigningKey[] = signingKeys,
): Promise<ArtifactManifest> {
  const digest = await sha256Hex(manifestBytes);
  if (digest !== expected.digest) {
    throw new ArtifactError(
      `manifest.json digest ${digest} does not match the catalog index (${expected.digest})`,
    );
  }
  try {
    await verifyManifestSignature(manifestBytes, signatureBase64.trim(), keys);
  } catch (error) {
    throw new ArtifactError(error instanceof Error ? error.message : String(error));
  }
  const parsed = artifactManifestSchema.safeParse(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );
  if (!parsed.success) {
    throw new ArtifactError(
      `manifest.json is not a valid artifact manifest: ${parsed.error.message}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.catalog.slug !== expected.slug || manifest.app !== expected.slug) {
    throw new ArtifactError(
      `the artifact is for "${manifest.catalog.slug}", not "${expected.slug}"`,
    );
  }
  if (manifest.version !== expected.version) {
    throw new ArtifactError(
      `the artifact is version ${manifest.version}, the catalog lists ${expected.version}`,
    );
  }
  return manifest;
}

/** A failed HTTP exchange with an artifact host; 5xx/429 and network errors may be retried. */
export class ArtifactFetchError extends Error {
  override name = "ArtifactFetchError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface FetchedBytes {
  bytes: Uint8Array;
  /** Subrequests the fetch used (redirect hops count). */
  subrequests: number;
}

function describeUrl(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
}

function httpFailure(url: string, status: number): ArtifactFetchError {
  return new ArtifactFetchError(
    `GET ${describeUrl(url)} -> ${status}`,
    status === 429 || status >= 500,
  );
}

/** A whole small file (`manifest.json`, `manifest.sig`). */
export async function fetchWhole(fetchImpl: FetchLike, url: string): Promise<FetchedBytes> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    throw new ArtifactFetchError(
      `GET ${describeUrl(url)} failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw httpFailure(url, response.status);
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), subrequests: fetchCost(response) };
}

export interface ArtifactFileRef {
  path: string;
  offset: number;
  size: number;
  sha256: string;
}

/**
 * One file of the artifact zip: `Range: bytes=offset-(offset+size-1)`, expecting
 * `206` and exactly `size` bytes whose sha256 matches the manifest. A server that
 * ignores Range (`200`) is an error, never a silent full download.
 */
export async function fetchArtifactFile(
  fetchImpl: FetchLike,
  zipUrl: string,
  file: ArtifactFileRef,
): Promise<FetchedBytes> {
  let bytes: Uint8Array;
  let subrequests = 0;
  if (file.size === 0) {
    bytes = new Uint8Array(0);
  } else {
    let response: Response;
    try {
      response = await fetchImpl(zipUrl, {
        redirect: "follow",
        headers: { Range: `bytes=${file.offset}-${file.offset + file.size - 1}` },
      });
    } catch (error) {
      throw new ArtifactFetchError(
        `GET ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`,
        !isSubrequestLimitError(error),
      );
    }
    subrequests = fetchCost(response);
    if (response.status !== 206) {
      await response.body?.cancel();
      if (response.ok) {
        throw new ArtifactFetchError(
          `GET ${file.path} -> ${response.status}: the artifact host ignored the Range request`,
          false,
        );
      }
      throw httpFailure(zipUrl, response.status);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.byteLength !== file.size) {
    throw new ArtifactError(`${file.path}: got ${bytes.byteLength} bytes, expected ${file.size}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== file.sha256) {
    throw new ArtifactError(`${file.path}: sha256 ${actual} does not match the manifest`);
  }
  return { bytes, subrequests };
}

/*
 * Reading many files of the artifact zip with few subrequests: files that lie
 * next to each other share one Range request (`planSpans` in
 * @appflare/schema). The release-asset redirect (GitHub answers every Range
 * request with a 302 to a signed storage URL) is followed once per reader;
 * later requests go straight to the final URL, so each further range costs
 * one subrequest, not two.
 */

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Redirect hops followed before giving up (GitHub uses one). */
const MAX_REDIRECTS = 5;

export interface ArtifactReader {
  /**
   * The bytes of every file, in the order given, each checked against its
   * size and sha256. Adjacent files share one Range request.
   */
  read(files: readonly ArtifactFileRef[]): Promise<Uint8Array[]>;
  /** Range requests answered so far (redirect hops not included). */
  readonly ranges: number;
}

function describeSpan(span: ArtifactSpan<ArtifactFileRef>): string {
  const [first] = span.files;
  const more = span.files.length - 1;
  return `${first?.path ?? "the artifact"}${more > 0 ? ` and ${more} more file(s)` : ""}`;
}

/**
 * A reader over the artifact zip at `zipUrl`. It follows redirects itself,
 * one hop per `fetchImpl` call (so a counting fetch counts every hop), keeps
 * the `Range` header on each hop, and remembers the final URL for the next
 * range. Use one reader per step: a release asset's signed URL expires, and a
 * retried step resolves it afresh.
 */
export function artifactReader(fetchImpl: FetchLike, zipUrl: string): ArtifactReader {
  let resolved: string | null = null;
  let ranges = 0;

  async function fetchSpan(span: ArtifactSpan<ArtifactFileRef>): Promise<Uint8Array> {
    const range = `bytes=${span.start}-${span.end - 1}`;
    let url = resolved ?? zipUrl;
    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await fetchImpl(url, { redirect: "manual", headers: { Range: range } });
      } catch (error) {
        throw new ArtifactFetchError(
          `GET ${describeSpan(span)} failed: ${error instanceof Error ? error.message : String(error)}`,
          !isSubrequestLimitError(error),
        );
      }
      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        await response.body?.cancel();
        const next = new URL(location, url);
        if (hop >= MAX_REDIRECTS || next.protocol !== "https:") {
          throw new ArtifactFetchError(
            `GET ${describeUrl(zipUrl)}: ${hop >= MAX_REDIRECTS ? `more than ${MAX_REDIRECTS} redirects` : "redirected to a URL that is not HTTPS"}`,
            false,
          );
        }
        url = next.toString();
        continue;
      }
      ranges += 1;
      if (response.status !== 206) {
        await response.body?.cancel();
        if (response.ok) {
          throw new ArtifactFetchError(
            `GET ${describeSpan(span)} -> ${response.status}: the artifact host ignored the Range request`,
            false,
          );
        }
        throw httpFailure(url, response.status);
      }
      // A fetch wrapper that follows redirects itself (the release feed's)
      // hands back the final response; its `url` is where the bytes live.
      resolved = response.url.length > 0 ? response.url : url;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== span.end - span.start) {
        throw new ArtifactError(
          `GET ${describeSpan(span)}: got ${bytes.byteLength} bytes, expected ${span.end - span.start}`,
        );
      }
      return bytes;
    }
  }

  return {
    get ranges() {
      return ranges;
    },
    async read(files) {
      const contents = new Map<ArtifactFileRef, Uint8Array>();
      for (const span of planSpans(files)) {
        const bytes = await fetchSpan(span);
        for (const file of span.files) {
          const at = file.offset - span.start;
          contents.set(file, bytes.subarray(at, at + file.size));
        }
      }
      const out: Uint8Array[] = [];
      for (const file of files) {
        const bytes = contents.get(file) ?? new Uint8Array(0);
        if (bytes.byteLength !== file.size) {
          throw new ArtifactError(
            `${file.path}: got ${bytes.byteLength} bytes, expected ${file.size}`,
          );
        }
        const actual = await sha256Hex(bytes);
        if (actual !== file.sha256) {
          throw new ArtifactError(`${file.path}: sha256 ${actual} does not match the manifest`);
        }
        out.push(bytes);
      }
      return out;
    },
  };
}
