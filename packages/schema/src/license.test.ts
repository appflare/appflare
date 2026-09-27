import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogManifestSchema } from "./catalog";
import { indexAppSchema } from "./catalog-index";
import {
  isLicense,
  licenseFile,
  licenseIds,
  licenseNoteSchema,
  licenseProblem,
  licenseSchema,
  licenseWarning,
} from "./license";

describe("licenseProblem", () => {
  it.each([
    "MIT",
    "Apache-2.0",
    "AGPL-3.0",
    "AGPL-3.0-only",
    "GPL-2.0+",
    "0BSD",
    "BUSL-1.1",
    "FSL-1.1-MIT",
    "PolyForm-Noncommercial-1.0.0",
    "Elastic-2.0",
    "SSPL-1.0",
    "LicenseRef-Acme-Community",
    "DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2",
    "MIT OR Apache-2.0",
    "(MIT OR Apache-2.0) AND BSD-3-Clause",
    "GPL-2.0-or-later WITH Classpath-exception-2.0",
    "mit or apache-2.0",
    "NONE",
    "NOASSERTION",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.md",
    "SEE LICENSE IN docs/license terms.txt",
  ])("takes %s", (value) => {
    expect(licenseProblem(value)).toBeNull();
    expect(licenseWarning(value)).toBeNull();
  });

  it.each([
    ["", "must not be empty"],
    [" MIT", "must not start or end with a space"],
    ["none", 'must be written "NONE", in capitals'],
    ["MIT OR NONE", "uses NONE, which stands alone in capitals, not inside an expression"],
    ["MIT License", 'has "License" where AND, OR or WITH belongs'],
    ["MIT, Apache-2.0", 'has "MIT,", which is not an SPDX license id'],
    ["MIT OR", "ends where a license id belongs"],
    ["OR MIT", 'has "OR" where a license id belongs'],
    ["(MIT OR Apache-2.0", "has a parenthesis that is never closed"],
    ["MIT)", "closes a parenthesis that was never opened"],
    ["MIT Or Apache-2.0", 'has "Or" where AND, OR or WITH belongs'],
    ["GPL-2.0 WITH", "needs an exception id after WITH"],
    ["SEE LICENSE IN", 'must name the file: "SEE LICENSE IN <file>"'],
    ["SEE LICENSE IN ../LICENSE", "must name a file inside the repository"],
    ["SEE LICENSE IN /etc/LICENSE", "must name a file inside the repository"],
  ])("finds %j wrong: %s", (value, problem) => {
    expect(licenseProblem(value)).toBe(problem);
    expect(isLicense(value)).toBe(false);
  });

  it("words the packer's warning", () => {
    expect(licenseWarning("MIT License")).toBe(
      'license is not an SPDX expression: it has "License" where AND, OR or WITH belongs',
    );
  });
});

describe("licenseSchema", () => {
  it("takes any non-empty text, so manifests stored before the check keep parsing", () => {
    for (const value of ["MIT", "NONE", "MIT License", "Commercial, all rights reserved", "none"]) {
      expect(licenseSchema.safeParse(value).success).toBe(true);
    }
    expect(licenseSchema.safeParse("").success).toBe(false);
  });

  it("describes the forms to use in the JSON Schema", () => {
    const json = z.toJSONSchema(licenseSchema) as { description?: string };
    expect(json.description).toMatch(/SPDX license expression/);
    expect(json.description).toMatch(/never decides whether an app is listed/);
  });
});

describe("licenseIds", () => {
  it("lists the license ids of an expression without its exceptions", () => {
    expect(licenseIds("(MIT OR Apache-2.0) AND BUSL-1.1")).toEqual([
      "MIT",
      "Apache-2.0",
      "BUSL-1.1",
    ]);
    expect(licenseIds("GPL-2.0-or-later WITH Classpath-exception-2.0")).toEqual([
      "GPL-2.0-or-later",
    ]);
  });

  it("lists none for the values that are not expressions", () => {
    expect(licenseIds("NONE")).toEqual([]);
    expect(licenseIds("NOASSERTION")).toEqual([]);
    expect(licenseIds("SEE LICENSE IN LICENSE.md")).toEqual([]);
  });
});

describe("licenseFile", () => {
  it("is the file of a SEE LICENSE IN value", () => {
    expect(licenseFile("SEE LICENSE IN docs/LICENSE.md")).toBe("docs/LICENSE.md");
    expect(licenseFile("MIT")).toBeNull();
  });
});

describe("licenseNoteSchema", () => {
  it("takes one short line", () => {
    expect(
      licenseNoteSchema.safeParse("Source-available: production use restricted; see the license")
        .success,
    ).toBe(true);
    expect(licenseNoteSchema.safeParse("").success).toBe(false);
    expect(licenseNoteSchema.safeParse("Two\nlines").success).toBe(false);
    expect(licenseNoteSchema.safeParse(" padded").success).toBe(false);
    expect(licenseNoteSchema.safeParse("x".repeat(161)).success).toBe(false);
  });
});

describe("the manifest's license fields", () => {
  const license = { license: "BUSL-1.1", licenseNote: "Production use restricted." };

  it("are taken by the catalog manifest", () => {
    const shape = catalogManifestSchema.shape;
    expect(shape.license.safeParse(license.license).success).toBe(true);
    expect(shape.licenseNote.safeParse(license.licenseNote).success).toBe(true);
    expect(shape.licenseNote.safeParse(undefined).success).toBe(true);
    expect(shape.license.safeParse("MIT License").success).toBe(true);
  });

  it("are optional in an index row and read the same way", () => {
    const shape = indexAppSchema.shape;
    expect(shape.license.safeParse(undefined).success).toBe(true);
    expect(shape.license.safeParse("NONE").success).toBe(true);
    expect(shape.license.safeParse("MIT License").success).toBe(true);
    expect(shape.licenseNote.safeParse(undefined).success).toBe(true);
  });
});
