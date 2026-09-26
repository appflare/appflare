import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { MAX_WORKER_MODULES } from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactWorkerSize,
  formatBytes,
  MAX_WORKER_SIZE_BYTES,
  workerSize,
  workerSizeLine,
  workerTooLargeMessage,
} from "./worker-size.ts";

const encode = (text: string) => new TextEncoder().encode(text);

describe("workerSize", () => {
  it("adds the modules up and gzips them as one stream, as wrangler does", () => {
    const modules = [encode("export default {};\n".repeat(50)), encode("const x = 1;\n")];
    const joined = Buffer.concat(modules);
    expect(workerSize(modules)).toEqual({
      size: joined.length,
      gzipSize: gzipSync(joined).length,
    });
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
    const size = artifactWorkerSize(zip, [
      { offset: 6, size: a.length },
      { offset: 6 + a.length + 3, size: b.length },
    ]);
    expect(size).toEqual(workerSize([a, b]));
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
  it("states the size and module count against their limits", () => {
    expect(workerSizeLine({ size: 2_526_000, gzipSize: 640_000 }, 1)).toBe(
      `1 module of at most ${MAX_WORKER_MODULES}, 2.41 MiB of at most 64.00 MiB (gzip 625.00 KiB, not limited)`,
    );
    expect(formatBytes(1023)).toBe("1.00 KiB");
  });

  it("marks what is over", () => {
    const line = workerSizeLine({ size: MAX_WORKER_SIZE_BYTES + 1, gzipSize: 1 }, 22);
    expect(line).toMatch(/^22 modules of at most 21, .*: too many modules, too large$/);
    expect(
      workerTooLargeMessage({ size: MAX_WORKER_SIZE_BYTES + 1, gzipSize: 1 }, "sink@0.3.0"),
    ).toBe(
      "sink@0.3.0 is 64.00 MiB uncompressed; Cloudflare accepts at most 64.00 MiB on every plan.",
    );
    expect(workerTooLargeMessage({ size: MAX_WORKER_SIZE_BYTES, gzipSize: 1 })).toBeNull();
  });
});
