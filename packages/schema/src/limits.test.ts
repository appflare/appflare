import { describe, expect, it } from "vitest";
import {
  FREE_PLAN_SUBREQUESTS,
  MAX_WORKER_UPLOAD_BYTES,
  MAX_WORKER_UPLOAD_SUBREQUESTS,
  rangeReadCost,
  WORKER_UPLOAD_OVERHEAD_SUBREQUESTS,
  workerUploadCost,
  workerUploadProblem,
} from "./limits";

const KIB = 1024;
const MIB = 1024 * KIB;

/** `count` modules of `size` bytes each, laid out as the packer writes them: one after another, each after a zip header. */
function packedModules(count: number, size: number, header = 60) {
  let offset = 0;
  return Array.from({ length: count }, () => {
    offset += header;
    const module = { offset, size };
    offset += size;
    return module;
  });
}

describe("the upload budget", () => {
  it("leaves the invocation's other subrequests their room", () => {
    expect(MAX_WORKER_UPLOAD_SUBREQUESTS + WORKER_UPLOAD_OVERHEAD_SUBREQUESTS).toBe(
      FREE_PLAN_SUBREQUESTS,
    );
    expect(MAX_WORKER_UPLOAD_SUBREQUESTS).toBe(42);
    expect(MAX_WORKER_UPLOAD_BYTES).toBe(32 * MIB);
  });
});

describe("workerUploadCost", () => {
  it("is the redirect plus one request per range, whatever the module count", () => {
    expect(workerUploadCost([])).toBe(0);
    expect([0, 1, 5].map(rangeReadCost)).toEqual([0, 2, 6]);
    expect(workerUploadCost([{ offset: 0, size: 0 }])).toBe(0);
    expect(workerUploadCost(packedModules(1, 2 * MIB))).toBe(2);
    // Two 3 MiB modules fit one 8 MiB range; five of them take three.
    expect(workerUploadCost(packedModules(5, 3 * MIB))).toBe(4);
  });

  it("plans a 600-module Worker, as a framework's server build emits, within the budget", () => {
    const modules = packedModules(600, 20 * KIB);
    const cost = workerUploadCost(modules);
    expect(cost).toBe(3); // 11.8 MiB: the redirect and two ranges.
    expect(cost).toBeLessThanOrEqual(MAX_WORKER_UPLOAD_SUBREQUESTS);
    expect(workerUploadProblem(modules)).toBeNull();
  });

  it("counts a range for every module that lies far from the others", () => {
    const scattered = Array.from({ length: 50 }, (_, i) => ({ offset: i * MIB, size: 1 * KIB }));
    expect(workerUploadCost(scattered)).toBe(51);
  });
});

describe("workerUploadProblem", () => {
  it("accepts a Worker up to the byte cap", () => {
    expect(workerUploadProblem(packedModules(4, 8 * MIB, 0))).toBeNull();
  });

  it("refuses more module bytes than one upload holds", () => {
    expect(workerUploadProblem(packedModules(1, MAX_WORKER_UPLOAD_BYTES + 1), "The release")).toBe(
      "The release has 32.01 MiB of Worker modules, but Appflare uploads at most 32.00 MiB: the upload holds every module and the request body in memory at once, within the 128 MB a Worker may use. Make the Worker smaller, for example by minifying it or serving large files as static assets.",
    );
  });

  it("refuses modules that take more ranges than the budget allows", () => {
    const scattered = Array.from({ length: 42 }, (_, i) => ({ offset: i * MIB, size: 1 * KIB }));
    expect(workerUploadProblem(scattered.slice(0, 41))).toBeNull();
    expect(workerUploadProblem(scattered)).toBe(
      "The artifact needs 43 subrequests to read its 42 Worker modules (42 Range requests to the release zip and the redirect), but one upload may make at most 42 of the free plan's 50 per invocation. Pack it again with the current packer, which writes a Worker's modules next to each other in the zip.",
    );
  });
});
