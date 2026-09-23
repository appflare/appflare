import { describe, expect, it } from "vitest";
import { WORKER_NAME_PATTERN } from "./install-input";
import { suggestWorkerName } from "./instance-names";

describe("suggestWorkerName", () => {
  it("keeps the catalog name while it is free", () => {
    expect(suggestWorkerName("cut", [])).toBe("cut");
    expect(suggestWorkerName("cut", ["cut-2", "other"])).toBe("cut");
  });

  it("numbers the next free instance from 2", () => {
    expect(suggestWorkerName("cut", ["cut"])).toBe("cut-2");
    expect(suggestWorkerName("cut", ["cut", "cut-2", "cut-3"])).toBe("cut-4");
    expect(suggestWorkerName("cut", ["cut", "cut-3"])).toBe("cut-2");
  });

  it("shortens a long name so the suffix still fits", () => {
    const long = "a".repeat(54);
    const next = suggestWorkerName(long, [long]);
    expect(next).toBe(`${"a".repeat(52)}-2`);
    expect(WORKER_NAME_PATTERN.test(next)).toBe(true);
    const dashed = `${"a".repeat(51)}-bc`;
    expect(suggestWorkerName(dashed, [dashed])).toBe(`${"a".repeat(51)}-2`);
  });

  it("turns a catalog name the form would reject into a valid one", () => {
    expect(suggestWorkerName("My_App", [])).toBe("my-app");
    expect(suggestWorkerName("--", [])).toBe("app");
    expect(WORKER_NAME_PATTERN.test(suggestWorkerName("Cut!!", ["cut"]))).toBe(true);
  });
});
