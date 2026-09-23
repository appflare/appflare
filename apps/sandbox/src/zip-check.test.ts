import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkZipFiles, type ZipFileRef } from "./zip-check";

const ZIP = new TextEncoder().encode("HEADERalphaGAPbetaEND");
const ref = (path: string, text: string): ZipFileRef => {
  const offset = new TextDecoder().decode(ZIP).indexOf(text);
  return {
    path,
    offset,
    size: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
};

/** The zip as a stream of `size`-byte chunks, so files straddle chunk edges. */
function stream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

describe("checkZipFiles", () => {
  it("accepts files that match, whatever the chunking, in any listed order", async () => {
    const files = [ref("b", "beta"), ref("a", "alpha"), { ...ref("e", ""), offset: 3 }];
    for (const chunk of [1, 3, 7, 100]) {
      expect(await checkZipFiles(stream(ZIP, chunk), ZIP.length, files)).toEqual([]);
    }
  });

  it("names every file whose bytes differ", async () => {
    const wrong = { ...ref("a", "alpha"), sha256: "0".repeat(64) };
    expect(await checkZipFiles(stream(ZIP, 4), ZIP.length, [wrong, ref("b", "beta")])).toEqual([
      "a: sha256 does not match manifest.json",
    ]);
  });

  it("refuses files outside the zip, overlapping files, and a short zip", async () => {
    const alpha = ref("a", "alpha");
    expect(
      await checkZipFiles(stream(ZIP, 4), ZIP.length, [{ ...alpha, offset: ZIP.length }]),
    ).toEqual([`a lies outside the zip (offset ${ZIP.length}, size 5)`]);
    expect(
      await checkZipFiles(stream(ZIP, 4), ZIP.length, [alpha, { ...alpha, path: "again" }]),
    ).toEqual(["again overlaps a"]);
    const problems = await checkZipFiles(stream(ZIP.slice(0, 12), 4), ZIP.length, [
      ref("b", "beta"),
    ]);
    expect(problems).toEqual([
      "b: the zip ended before its bytes",
      `the zip has 12 bytes, expected ${ZIP.length}`,
    ]);
  });
});
