import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameInput,
  displayNameProblem,
  displayNameSchema,
  distinctLabels,
  installLabel,
  renameChange,
  renameStartValue,
} from "./display-name";

describe("installLabel", () => {
  it("is the display name when set, else the app's name", () => {
    expect(installLabel({ displayName: "Team link shortener", name: "Cut" })).toBe(
      "Team link shortener",
    );
    expect(installLabel({ displayName: null, name: "Cut" })).toBe("Cut");
  });
});

describe("distinctLabels", () => {
  const install = (id: string, name: string, displayName: string | null = null) => ({
    id,
    name,
    displayName,
    workerName: id,
  });

  it("adds the Worker name only to installs that would read the same", () => {
    const labels = distinctLabels([
      install("sink", "Sink"),
      install("sink-2", "Sink"),
      install("cut", "Cut"),
      install("sink-3", "Sink", "Team inbox"),
    ]);
    expect(Object.fromEntries(labels)).toEqual({
      sink: "Sink (sink)",
      "sink-2": "Sink (sink-2)",
      cut: "Cut",
      "sink-3": "Team inbox",
    });
  });

  it("counts a display name that reads like another install's app name, ignoring case", () => {
    const labels = distinctLabels([install("cut", "Cut"), install("links", "Links", "CUT")]);
    expect(labels.get("cut")).toBe("Cut (cut)");
    expect(labels.get("links")).toBe("CUT (links)");
  });

  it("counts an install listed twice once", () => {
    const labels = distinctLabels([install("sink", "Sink"), install("sink", "Sink")]);
    expect(labels.get("sink")).toBe("Sink");
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
  it("turns empty or blank into null, which goes back to the app's name", () => {
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

describe("renaming from the app's page", () => {
  const unnamed = { displayName: null, name: "Sink" };
  const named = { displayName: "Team links", name: "Sink" };

  it("starts from the name the page shows", () => {
    expect(renameStartValue(unnamed)).toBe("Sink");
    expect(renameStartValue(named)).toBe("Team links");
  });

  it("changes nothing when the field is saved as it opened", () => {
    expect(renameChange(unnamed, "Sink")).toBeNull();
    expect(renameChange(unnamed, " Sink ")).toBeNull();
    expect(renameChange(unnamed, "")).toBeNull();
    expect(renameChange(named, "Team links")).toBeNull();
  });

  it("sends a new name, or an empty one that clears the display name", () => {
    expect(renameChange(unnamed, "Short links")).toBe("Short links");
    expect(renameChange(named, " Links ")).toBe("Links");
    expect(renameChange(named, "")).toBe("");
    // The app's own name is what the page shows without a display name.
    expect(renameChange(named, "Sink")).toBe("");
  });
});
