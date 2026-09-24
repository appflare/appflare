import { describe, expect, it } from "vitest";
import {
  rollbackDialogCopy,
  rollbackFinishMessage,
  rollbackStartMessage,
  snapshotHasSameCode,
} from "./rollback-copy";

const at = "2026-09-24T12:05:00.000Z";

describe("snapshotHasSameCode", () => {
  it("needs the same version and the same artifact", () => {
    const install = { catalogVersion: "1.0.0", artifactDigest: "a".repeat(64) };
    expect(snapshotHasSameCode({ ...install }, install)).toBe(true);
    expect(snapshotHasSameCode({ ...install, catalogVersion: "0.9.0" }, install)).toBe(false);
    expect(snapshotHasSameCode({ ...install, artifactDigest: "b".repeat(64) }, install)).toBe(
      false,
    );
    expect(snapshotHasSameCode({ catalogVersion: null, artifactDigest: null }, install)).toBe(
      false,
    );
  });
});

describe("rollbackDialogCopy", () => {
  const base = { takenAt: at, fromCatalogVersion: "1.0.0", fromVersionId: "9ec954d1-aaaa" };

  it("undoes a settings change of the installed code, with no database warning", () => {
    const copy = rollbackDialogCopy({ ...base, jobKind: "reconfigure", sameCode: true }, "cut");
    expect(copy.title).toMatch(/^Undo the settings change of Sep 24, 2026/);
    expect(copy.title).not.toContain("1.0.0");
    expect(copy.button).toBe("Undo");
    expect(copy.action).toBe("Undo the settings change");
    expect(copy.lead).toContain("The code stays the same.");
    expect(copy.warnData).toBe(false);
  });

  it("rolls back to other code by version, warning that databases stay", () => {
    const copy = rollbackDialogCopy({ ...base, jobKind: "update", sameCode: false }, "cut");
    expect(copy.title).toBe("Roll back cut to 1.0.0");
    expect(copy.action).toBe("Roll back");
    expect(copy.lead).toContain("before the update of Sep 24, 2026");
    expect(copy.warnData).toBe(true);
  });

  it("an update already rolled back is a rollback to the code installed now, without a data warning", () => {
    const copy = rollbackDialogCopy({ ...base, jobKind: "update", sameCode: true }, "cut");
    expect(copy.button).toBe("Roll back");
    expect(copy.title).toMatch(/^Roll back cut to before the update of Sep 24, 2026/);
    expect(copy.warnData).toBe(false);
  });

  it("a settings change of older code is a rollback to that code", () => {
    const copy = rollbackDialogCopy({ ...base, jobKind: "reconfigure", sameCode: false }, "cut");
    expect(copy.title).toBe("Roll back cut to 1.0.0");
    expect(copy.lead).toContain("before the settings change of");
    expect(copy.warnData).toBe(true);
  });
});

describe("rollbackStartMessage", () => {
  it("does not claim a move from a version to itself", () => {
    const same = rollbackStartMessage({
      workerName: "cut",
      fromVersion: "1.0.0",
      toVersion: "1.0.0",
      versionId: "v1",
      sameCode: true,
    });
    expect(same).not.toContain("from 1.0.0 to 1.0.0");
    expect(same).not.toContain("D1");
    expect(same).toContain("The code stays at 1.0.0.");
    expect(
      rollbackStartMessage({
        workerName: "cut",
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
        versionId: "v1",
        sameCode: false,
      }),
    ).toBe(
      'Rolling back Worker "cut" from 1.1.0 to 1.0.0 (version v1). D1 databases are not changed.',
    );
  });
});

describe("rollbackFinishMessage", () => {
  const base = {
    fromVersion: "1.0.0",
    toVersion: "1.0.0",
    versionId: "v1",
    url: "https://cut.example.workers.dev/",
    health: "verified (HTTP 200)",
  };

  it("says settings were put back when the code is the same", () => {
    expect(rollbackFinishMessage({ ...base, sameCode: true })).toBe(
      "Put back the earlier settings and secrets at https://cut.example.workers.dev/ (health: verified (HTTP 200)).",
    );
  });

  it("names both versions of a rollback to other code", () => {
    expect(rollbackFinishMessage({ ...base, fromVersion: "1.1.0", sameCode: false })).toBe(
      "Rolled back from 1.1.0 to 1.0.0 at https://cut.example.workers.dev/ (health: verified (HTTP 200)).",
    );
  });
});
