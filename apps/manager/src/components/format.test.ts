import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatExactDateTime, jobKindLabel } from "./format";

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

describe("jobKindLabel", () => {
  it("names a job by its kind, and the restore and kept-data deletion by their flags", () => {
    expect(jobKindLabel({ kind: "uninstall" })).toBe("Uninstall");
    expect(jobKindLabel({ kind: "reconfigure" })).toBe("Settings change");
    expect(jobKindLabel({ kind: "reconfigure", accessChange: true })).toBe(
      "Cloudflare Access change",
    );
    expect(jobKindLabel({ kind: "uninstall", deleteRetained: true })).toBe("Delete retained data");
    expect(jobKindLabel({ kind: "rollback", restore: true })).toBe("Database restore");
    expect(jobKindLabel({ kind: "self_update" })).toBe("Appflare update");
  });
});
