import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameInput,
  displayNameProblem,
  displayNameSchema,
  installLabel,
} from "./display-name";

describe("installLabel", () => {
  it("is the display name when set, else the Worker name", () => {
    expect(installLabel({ displayName: "Team link shortener", workerName: "cut-2" })).toBe(
      "Team link shortener",
    );
    expect(installLabel({ displayName: null, workerName: "cut-2" })).toBe("cut-2");
  });
});

describe("displayNameSchema", () => {
  it("trims and accepts 1 to 60 characters, including letters beyond ASCII", () => {
    expect(displayNameSchema.parse("  Liens d'équipe  ")).toBe("Liens d'équipe");
    expect(displayNameSchema.parse("x".repeat(DISPLAY_NAME_MAX_LENGTH))).toHaveLength(60);
  });

  it("refuses empty, too long, and control characters", () => {
    for (const bad of ["", "   ", "x".repeat(61), "a\nb", "a\rb", "a\tb", "a\u0007b", "a\u009bb"]) {
      expect(displayNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("displayNameInput", () => {
  it("turns empty or blank into null, which restores the Worker name", () => {
    expect(displayNameInput.parse("")).toBeNull();
    expect(displayNameInput.parse("  ")).toBeNull();
    expect(displayNameInput.parse(" Links ")).toBe("Links");
  });

  it("refuses what the stored schema refuses", () => {
    expect(displayNameInput.safeParse("x".repeat(61)).success).toBe(false);
    expect(displayNameInput.safeParse("a\nb").success).toBe(false);
  });
});

describe("displayNameProblem", () => {
  it("is null for a valid or empty name and says why otherwise", () => {
    expect(displayNameProblem("")).toBeNull();
    expect(displayNameProblem("Links")).toBeNull();
    expect(displayNameProblem("x".repeat(61))).toBe("Use at most 60 characters.");
    expect(displayNameProblem("a\tb")).toBe("The name cannot hold line breaks or tabs.");
  });
});
