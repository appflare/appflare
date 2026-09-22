import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { crc32, ZipStore } from "./zip.ts";

const hasUnzip = spawnSync("unzip", ["-v"]).error === undefined;

describe("crc32", () => {
  it("matches the canonical check value for '123456789'", () => {
    // The standard CRC-32 (IEEE) check value.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("is 0 for the empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("ZipStore", () => {
  it("records the byte offset of each entry's data and stores it verbatim", () => {
    const zip = new ZipStore();
    const a = Buffer.from("hello world", "utf8");
    const b = Buffer.from("second entry payload", "utf8");
    const offA = zip.addFile("worker/index.js", a).dataOffset;
    const offB = zip.addFile("assets/index.html", b).dataOffset;
    const bytes = zip.finish();

    // Offset = local-header (30) + filename length, for the first entry from 0.
    expect(offA).toBe(30 + Buffer.byteLength("worker/index.js"));
    // The bytes at each recorded offset are exactly the stored file (STORE).
    expect(bytes.subarray(offA, offA + a.length).equals(a)).toBe(true);
    expect(bytes.subarray(offB, offB + b.length).equals(b)).toBe(true);
    // Second data offset lands past the first entry's local header + data.
    expect(offB).toBe(offA + a.length + 30 + Buffer.byteLength("assets/index.html"));
  });

  it("throws rather than emit an invalid archive on unsupported inputs", () => {
    const zip = new ZipStore();
    // Fabricate a >4GiB entry by faking the length without allocating.
    const huge = { length: 0x1_0000_0001 } as unknown as Uint8Array;
    expect(() => zip.addFile("big.bin", huge)).toThrow(/32-bit/);
  });

  const tmp = hasUnzip ? mkdtempSync(path.join(tmpdir(), "appflare-zip-test-")) : "";
  afterAll(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasUnzip)("produces an archive that unzip -t accepts", () => {
    const zip = new ZipStore();
    zip.addFile("worker/index.js", Buffer.from("export default {};\n"));
    zip.addFile("assets/nested/deep/info.txt", Buffer.from("nested asset\n"));
    zip.addFile("manifest.json", Buffer.from('{"format":1}\n'));
    const zipPath = path.join(tmp, "test.zip");
    writeFileSync(zipPath, zip.finish());

    const res = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("No errors detected");
  });
});
