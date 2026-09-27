import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { MAX_WORKER_UPLOAD_BYTES } from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactWorkerSize, formatBytes, workerSize, workerSizeLine } from "./worker-size.ts";

const encode = (text: string) => new TextEncoder().encode(text);

describe("workerSize", () => {
  it("adds the modules up, gzips them as one stream as wrangler does, and plans their ranges", () => {
    const modules = [encode("export default {};\n".repeat(50)), encode("const x = 1;\n")];
    const joined = Buffer.concat(modules);
    const [a, b] = modules.map((m) => m.byteLength) as [number, number];
    expect(
      workerSize(modules, [
        { offset: 30, size: a },
        { offset: 30 + a + 40, size: b },
      ]),
    ).toEqual({ size: joined.length, gzipSize: gzipSync(joined).length, ranges: 1 });
    // Modules far apart in the zip take a range each.
    expect(
      workerSize(modules, [
        { offset: 0, size: a },
        { offset: 10 * 1024 * 1024, size: b },
      ]).ranges,
    ).toBe(2);
  });
});

describe("artifactWorkerSize", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "appflare-size-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads each module from its byte range in the zip", () => {
    const a = encode("A".repeat(300));
    const b = encode("B".repeat(40));
    const zip = path.join(dir, "x.zip");
    writeFileSync(zip, Buffer.concat([encode("header"), a, encode("gap"), b, encode("tail")]));
    const layout = [
      { offset: 6, size: a.length },
      { offset: 6 + a.length + 3, size: b.length },
    ];
    expect(artifactWorkerSize(zip, layout)).toEqual(workerSize([a, b], layout));
  });

  it("refuses a range past the end of the zip", () => {
    const zip = path.join(dir, "short.zip");
    writeFileSync(zip, encode("tiny"));
    expect(() => artifactWorkerSize(zip, [{ offset: 2, size: 10 }])).toThrow(
      "ends inside a Worker module",
    );
  });
});

describe("workerSizeLine", () => {
  it("states the modules, their ranges and their size against the upload budget", () => {
    expect(workerSizeLine({ size: 2_526_000, gzipSize: 640_000, ranges: 1 }, 1)).toBe(
      "1 module in 1 range, 2.41 MiB of at most 32.00 MiB (gzip 625.00 KiB, not limited)",
    );
    expect(workerSizeLine({ size: 12_000_000, gzipSize: 3_000_000, ranges: 2 }, 579)).toMatch(
      /^579 modules in 2 ranges, 11\.44 MiB of at most 32\.00 MiB \(gzip 2\.86 MiB, not limited\)$/,
    );
    expect(formatBytes(1023)).toBe("1.00 KiB");
  });

  it("marks what one upload could not carry", () => {
    const line = workerSizeLine({ size: MAX_WORKER_UPLOAD_BYTES + 1, gzipSize: 1, ranges: 42 }, 50);
    expect(line).toMatch(/^50 modules in 42 ranges, .*: too large to upload, too many ranges$/);
    expect(workerSizeLine({ size: 1, gzipSize: 1, ranges: 41 }, 41)).not.toMatch(/too many/);
  });
});
