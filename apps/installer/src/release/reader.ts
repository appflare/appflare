import type { FetchLike } from "@appflare/cf-api";
import { type ArtifactSpan, planSpans } from "@appflare/schema";
import { describeUrl, followGet, ReleaseError, ReleaseFetchError, sha256Hex } from "./fetch";

/**
 * Reading files of the release zip with HTTP Range requests: the zip is
 * stored without compression, so each file is a byte range the signed
 * manifest records with its size and sha256. Adjacent files share one Range
 * request (`planSpans` in @appflare/schema), and the release-asset redirect
 * is followed once per reader, then every range goes to the final URL. Each
 * file is checked against its size and sha256 before its bytes are returned.
 * (The manager reads its own releases the same way: apps/manager/src/jobs/install/artifact.ts.)
 */

export interface ReleaseFileRef {
  path: string;
  offset: number;
  size: number;
  sha256: string;
}

export interface ReleaseReader {
  read<F extends ReleaseFileRef>(files: readonly F[]): Promise<Uint8Array[]>;
  /** Range requests answered so far (redirect hops not counted). */
  readonly ranges: number;
}

function describeSpan(span: ArtifactSpan<ReleaseFileRef>): string {
  const [first] = span.files;
  const more = span.files.length - 1;
  return `${first?.path ?? "the release"}${more > 0 ? ` and ${more} more file(s)` : ""}`;
}

export function releaseReader(fetch: FetchLike, zipUrl: string): ReleaseReader {
  let resolved: string | null = null;
  let ranges = 0;

  async function fetchSpan(span: ArtifactSpan<ReleaseFileRef>): Promise<Uint8Array> {
    const { response, url } = await followGet(fetch, resolved ?? zipUrl, {
      range: `bytes=${span.start}-${span.end - 1}`,
    });
    ranges += 1;
    if (response.status !== 206) {
      await response.body?.cancel();
      if (response.ok) {
        throw new ReleaseFetchError(
          `GET ${describeSpan(span)} -> ${response.status}: the release host ignored the Range request`,
          false,
        );
      }
      throw new ReleaseFetchError(
        `GET ${describeUrl(url)} -> ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    resolved = url;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== span.end - span.start) {
      throw new ReleaseError(
        "files",
        `${describeSpan(span)}: got ${bytes.byteLength} bytes, expected ${span.end - span.start}`,
      );
    }
    return bytes;
  }

  return {
    get ranges() {
      return ranges;
    },
    async read(files) {
      const contents = new Map<ReleaseFileRef, Uint8Array>();
      for (const span of planSpans<ReleaseFileRef>(files)) {
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
          throw new ReleaseError(
            "files",
            `${file.path}: got ${bytes.byteLength} bytes, expected ${file.size}`,
          );
        }
        if ((await sha256Hex(bytes)) !== file.sha256) {
          throw new ReleaseError("files", `${file.path} does not match the signed manifest`);
        }
        out.push(bytes);
      }
      return out;
    },
  };
}

/**
 * Checks every file of the release against its sha256, span by span, keeping
 * only one span in memory at a time. Returns the Range requests it made.
 */
export async function verifyReleaseFiles(
  fetch: FetchLike,
  zipUrl: string,
  files: readonly ReleaseFileRef[],
): Promise<{ ranges: number; files: number }> {
  const reader = releaseReader(fetch, zipUrl);
  for (const span of planSpans(files)) {
    await reader.read(span.files);
  }
  // Empty files need no range; their recorded sha256 is still checked.
  await reader.read(files.filter((f) => f.size === 0));
  return { ranges: reader.ranges, files: files.length };
}
