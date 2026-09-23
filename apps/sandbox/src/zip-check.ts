/**
 * Checks a stored artifact zip against its manifest: every file the manifest
 * lists (Worker modules, assets, D1 migrations) must be exactly the bytes at
 * its offset, with its size and sha256. That is what the manager reads later,
 * one Range request per file, so a zip that fails here would fail there.
 *
 * The zip is read once, as a stream, and each file is hashed as soon as its
 * bytes have passed, so memory holds one file at a time.
 */

export interface ZipFileRef {
  path: string;
  offset: number;
  size: number;
  sha256: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every problem found (empty when the zip matches). */
export async function checkZipFiles(
  zip: ReadableStream<Uint8Array>,
  zipSize: number,
  listed: readonly ZipFileRef[],
): Promise<string[]> {
  const problems: string[] = [];
  const files = [...listed].sort((a, b) => a.offset - b.offset || a.size - b.size);
  for (let i = 1; i < files.length; i++) {
    const previous = files[i - 1] as ZipFileRef;
    const file = files[i] as ZipFileRef;
    if (file.offset < previous.offset + previous.size) {
      problems.push(`${file.path} overlaps ${previous.path}`);
    }
  }
  for (const file of files) {
    if (file.offset < 0 || file.size < 0 || file.offset + file.size > zipSize) {
      problems.push(`${file.path} lies outside the zip (offset ${file.offset}, size ${file.size})`);
    }
  }
  if (problems.length > 0) {
    await zip.cancel();
    return problems;
  }

  const check = async (file: ZipFileRef, bytes: Uint8Array) => {
    if ((await sha256Hex(bytes)) !== file.sha256) {
      problems.push(`${file.path}: sha256 does not match manifest.json`);
    }
  };

  let index = 0;
  let current: Uint8Array | null = null;
  let position = 0;
  const reader = zip.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkStart = position;
    const chunkEnd = position + value.byteLength;
    position = chunkEnd;
    while (index < files.length) {
      const file = files[index] as ZipFileRef;
      if (file.size === 0) {
        await check(file, new Uint8Array(0));
        index++;
        continue;
      }
      if (file.offset >= chunkEnd) break;
      current ??= new Uint8Array(file.size);
      const from = Math.max(chunkStart, file.offset);
      const to = Math.min(chunkEnd, file.offset + file.size);
      current.set(value.subarray(from - chunkStart, to - chunkStart), from - file.offset);
      if (file.offset + file.size > chunkEnd) break;
      await check(file, current);
      current = null;
      index++;
    }
  }
  for (const file of files.slice(index)) {
    if (file.size === 0) await check(file, new Uint8Array(0));
    else problems.push(`${file.path}: the zip ended before its bytes`);
  }
  if (position !== zipSize) {
    problems.push(`the zip has ${position} bytes, expected ${zipSize}`);
  }
  return problems;
}
