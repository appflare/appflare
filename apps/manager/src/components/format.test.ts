import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatExactDateTime } from "./format";

describe("formatBytes", () => {
  it("uses decimal units with at most one decimal", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(12_288)).toBe("12.3 KB");
    expect(formatBytes(450_000)).toBe("450 KB");
    expect(formatBytes(5_000_000_000)).toBe("5.0 GB");
  });
});

describe("formatDate and formatExactDateTime", () => {
  // Tests run in UTC; midday keeps the day stable if they ever do not.
  const iso = "2026-09-23T12:34:56.000Z";

  it("shows the day only", () => {
    expect(formatDate(iso)).toBe("Sep 23, 2026");
  });

  it("shows the exact time down to the second, with the time zone", () => {
    const exact = formatExactDateTime(iso);
    expect(exact).toContain("September 23, 2026");
    expect(exact).toMatch(/12:34:56\sPM UTC/);
  });
});
