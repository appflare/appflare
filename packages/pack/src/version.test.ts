import { describe, expect, it } from "vitest";
import { deriveVersion, formatBuildDate, semverFromRef } from "./version.ts";

describe("semverFromRef", () => {
  it("accepts plain and v-prefixed semver and strips the v", () => {
    expect(semverFromRef("1.2.3")).toBe("1.2.3");
    expect(semverFromRef("v1.2.3")).toBe("1.2.3");
    expect(semverFromRef("v0.1.0-beta.2")).toBe("0.1.0-beta.2");
    expect(semverFromRef("2.0.0+build.5")).toBe("2.0.0+build.5");
  });

  it("rejects non-semver refs", () => {
    expect(semverFromRef("main")).toBeNull();
    expect(semverFromRef("release-2024")).toBeNull();
    expect(semverFromRef("v1.2")).toBeNull();
  });
});

describe("formatBuildDate", () => {
  it("formats as YYYYMMDD in UTC", () => {
    expect(formatBuildDate(new Date("2026-09-22T23:59:59Z"))).toBe("20260922");
    expect(formatBuildDate(new Date("2024-01-05T00:00:00Z"))).toBe("20240105");
  });
});

describe("deriveVersion", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("uses the semver tag without a leading v", () => {
    expect(
      deriveVersion({ ref: "v1.4.0", sha, commitDate: "20260101", buildDate: "20260922" }),
    ).toBe("1.4.0");
  });

  it("falls back to a date+sha version for untagged refs, preferring the commit date", () => {
    expect(deriveVersion({ ref: "main", sha, commitDate: "20260101", buildDate: "20260922" })).toBe(
      "0.0.0-20260101.0123456",
    );
  });

  it("uses the build date when there is no commit date", () => {
    expect(deriveVersion({ ref: "main", sha, commitDate: null, buildDate: "20260922" })).toBe(
      "0.0.0-20260922.0123456",
    );
  });
});
