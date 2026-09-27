/*
 * Reading many files of an artifact zip with few subrequests.
 *
 * The zip is STORE-only, so files the packer wrote next to each other are
 * adjacent byte ranges. Adjacent files (with small gaps between them, such as
 * zip headers or files Cloudflare already stores) are read with ONE Range
 * request covering all of them, then sliced apart and checked one by one.
 *
 * The manager reads artifacts with these ranges, and the packer and the
 * manager both plan them to decide whether a Worker fits one upload, so the
 * planned range count is exactly what an upload fetches.
 */

/** Where a file lies in the artifact zip. */
export interface SpanFile {
  /** First byte of the file's data. */
  offset: number;
  size: number;
}

/** A contiguous byte range of the zip that covers one or more files. */
export interface ArtifactSpan<F extends SpanFile = SpanFile> {
  /** First byte of the range. */
  start: number;
  /** One past the last byte of the range. */
  end: number;
  files: F[];
}

export interface SpanLimits {
  /** Largest range one request reads. A single larger file still gets its own range. */
  maxBytes: number;
  /** Largest run of unneeded bytes a range may carry between two files. */
  maxGap: number;
}

/**
 * 8 MiB ranges keep a step's memory small next to the 128 MB isolate limit
 * (the bytes, their base64 copy, and the upload body are all held at once);
 * downloading a 256 KiB gap is far cheaper than a second subrequest.
 */
export const SPAN_LIMITS: SpanLimits = { maxBytes: 8 * 1024 * 1024, maxGap: 256 * 1024 };

/**
 * Grows ranges one file at a time, in offset order. The asset upload plans its
 * steps with the same span logic the reader uses, so a step's planned range
 * count is exactly what it fetches.
 */
export class SpanBuilder<F extends SpanFile = SpanFile> {
  readonly spans: ArtifactSpan<F>[] = [];
  /** Bytes the ranges cover, gaps included. */
  bytes = 0;

  constructor(private readonly limits: SpanLimits = SPAN_LIMITS) {}

  /** What adding `file` would cost: whether it opens a new range, and the bytes it adds. */
  preview(file: F): { newSpan: boolean; addedBytes: number } {
    if (file.size === 0) return { newSpan: false, addedBytes: 0 };
    const last = this.spans.at(-1);
    const end = file.offset + file.size;
    if (
      last !== undefined &&
      file.offset >= last.start &&
      file.offset - last.end <= this.limits.maxGap &&
      Math.max(end, last.end) - last.start <= this.limits.maxBytes
    ) {
      return { newSpan: false, addedBytes: Math.max(0, end - last.end) };
    }
    return { newSpan: true, addedBytes: file.size };
  }

  /** Adds `file`; files must come in ascending offset order. Empty files need no range. */
  add(file: F): void {
    if (file.size === 0) return;
    const { newSpan, addedBytes } = this.preview(file);
    const last = this.spans.at(-1);
    if (newSpan || last === undefined) {
      this.spans.push({ start: file.offset, end: file.offset + file.size, files: [file] });
    } else {
      last.end = Math.max(last.end, file.offset + file.size);
      last.files.push(file);
    }
    this.bytes += addedBytes;
  }
}

/** Files in the order a {@link SpanBuilder} needs them: ascending offset. */
export function byOffset<F extends SpanFile>(files: readonly F[]): F[] {
  return [...files].sort((a, b) => a.offset - b.offset || a.size - b.size);
}

/** The ranges that cover `files` (empty files need none). */
export function planSpans<F extends SpanFile>(
  files: readonly F[],
  limits: SpanLimits = SPAN_LIMITS,
): ArtifactSpan<F>[] {
  const builder = new SpanBuilder<F>(limits);
  for (const file of byOffset(files)) builder.add(file);
  return builder.spans;
}
