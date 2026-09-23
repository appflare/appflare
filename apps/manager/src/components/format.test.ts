import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("uses decimal units with at most one decimal", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(12_288)).toBe("12.3 KB");
    expect(formatBytes(450_000)).toBe("450 KB");
    expect(formatBytes(5_000_000_000)).toBe("5.0 GB");
  });
});
