import { describe, expect, it } from "vitest";
import { compareVersions, isUpdateAvailable } from "./versions";

describe("isUpdateAvailable", () => {
  it("is false when the catalog lists the installed version or nothing", () => {
    expect(isUpdateAvailable("1.2.3", "1.2.3")).toBe(false);
    expect(isUpdateAvailable("1.2.3", null)).toBe(false);
    expect(isUpdateAvailable("1.2.3", undefined)).toBe(false);
  });

  it("follows semver precedence", () => {
    expect(isUpdateAvailable("1.2.3", "1.2.4")).toBe(true);
    expect(isUpdateAvailable("1.2.3", "1.10.0")).toBe(true);
    expect(isUpdateAvailable("1.2.3", "1.2.2")).toBe(false);
    expect(isUpdateAvailable("1.0.0-beta.2", "1.0.0")).toBe(true);
  });

  it("orders untagged pins (0.0.0-<date>.<sha7>) by date", () => {
    expect(isUpdateAvailable("0.0.0-20260826.6056400", "0.0.0-20260901.abcdef1")).toBe(true);
    expect(isUpdateAvailable("0.0.0-20260901.abcdef1", "0.0.0-20260826.6056400")).toBe(false);
    expect(isUpdateAvailable("0.0.0-20260826.6056400", "0.1.0")).toBe(true);
  });

  it("treats any difference as an update when a version is not semver", () => {
    expect(isUpdateAvailable("latest", "2026-09")).toBe(true);
    expect(compareVersions("latest", "1.0.0")).toBeNull();
  });
});
