import { describe, expect, it } from "vitest";
import { licenseBadgeCopy, licenseKind, NO_LICENSE_TOOLTIP } from "./license-badge";

const plain = (expression: string) => ({ expression, note: null });

describe("licenseBadgeCopy", () => {
  it("shows an open-source id as it is, in a neutral badge", () => {
    expect(licenseBadgeCopy(plain("MIT"))).toEqual({
      kind: "open-source",
      prefix: null,
      label: "MIT",
      variant: "neutral",
      tooltip: "An open-source license: you may use, change and share the app on its terms.",
    });
    expect(licenseBadgeCopy(plain("MIT OR Apache-2.0")).label).toBe("MIT OR Apache-2.0");
  });

  it("puts a muted Source-available before a source-available id", () => {
    const copy = licenseBadgeCopy(plain("BUSL-1.1"));
    expect(copy).toMatchObject({
      kind: "source-available",
      prefix: "Source-available",
      label: "BUSL-1.1",
      variant: "neutral",
    });
    expect(copy.tooltip).toMatch(/restricts some uses/);
  });

  it("shows the note as the tooltip, and a note makes any license source-available", () => {
    const note = "Source-available: production use restricted; see the license";
    expect(licenseBadgeCopy({ expression: "BUSL-1.1", note }).tooltip).toBe(note);
    expect(licenseBadgeCopy({ expression: "MIT", note })).toMatchObject({
      kind: "source-available",
      prefix: "Source-available",
      label: "MIT",
      tooltip: note,
    });
  });

  it("says No license in the warning tone when the repository publishes none", () => {
    const expected = {
      kind: "none",
      prefix: null,
      label: "No license",
      variant: "warning",
      tooltip:
        "This project publishes no license. You may run it, but you have no license to modify or redistribute it.",
    };
    for (const value of ["NONE", "UNLICENSED", "NOASSERTION", "none"]) {
      expect(licenseBadgeCopy(plain(value))).toEqual(expected);
    }
    expect(NO_LICENSE_TOOLTIP).toBe(expected.tooltip);
  });

  it("names a license of the app's own, and shows text it cannot place as it is", () => {
    expect(licenseBadgeCopy(plain("SEE LICENSE IN LICENSE.md"))).toMatchObject({
      kind: "unknown",
      label: "Custom license",
      variant: "neutral",
      tooltip:
        "A license of its own, in LICENSE.md in the app's repository. Read it before you rely on the app.",
    });
    expect(licenseBadgeCopy(plain("LicenseRef-Acme"))).toMatchObject({
      kind: "unknown",
      label: "Custom license",
      variant: "neutral",
    });
    expect(licenseBadgeCopy(plain("MIT License"))).toMatchObject({
      kind: "unknown",
      prefix: null,
      label: "MIT License",
      variant: "neutral",
    });
  });
});

describe("licenseKind", () => {
  it.each([
    ["FSL-1.1-MIT", "source-available"],
    ["FSL-1.1-ALv2", "source-available"],
    ["PolyForm-Noncommercial-1.0.0", "source-available"],
    ["Elastic-2.0", "source-available"],
    ["SSPL-1.0", "source-available"],
    ["MIT AND BUSL-1.1", "source-available"],
    ["BSL-1.0", "open-source"],
    ["AGPL-3.0-only", "open-source"],
    ["GPL-2.0-or-later WITH Classpath-exception-2.0", "open-source"],
  ])("%s is %s", (expression, kind) => {
    expect(licenseKind(plain(expression))).toBe(kind);
  });
});

describe("licenseBadgeCopy for a license of the app's own", () => {
  it("shows Custom license, not the LicenseRef id, and the note as what it allows", () => {
    const copy = licenseBadgeCopy({
      expression: "LicenseRef-Ledger-Source-Available",
      note: "Source-available: free for personal use; see the license",
    });
    expect(copy).toMatchObject({
      kind: "source-available",
      prefix: "Source-available",
      label: "Custom license",
      tooltip: "Source-available: free for personal use; see the license",
    });
    expect(licenseBadgeCopy({ expression: "MIT OR LicenseRef-Acme", note: null }).label).toBe(
      "MIT OR LicenseRef-Acme",
    );
  });
});
