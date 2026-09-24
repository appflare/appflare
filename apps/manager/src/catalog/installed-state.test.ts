import { describe, expect, it } from "vitest";
import { installedState } from "./installed-state";

const at = (status: string, instanceName = "cut") => ({ status, instanceName });

describe("installedState", () => {
  it("is nothing when the app is not installed", () => {
    expect(installedState([])).toBeNull();
  });

  it("shows one install's own status", () => {
    expect(installedState([at("installed")])).toEqual({
      label: "Installed",
      tone: "success",
      details: ["cut: Installed"],
    });
    expect(installedState([at("updating")])).toMatchObject({ label: "Updating", tone: "neutral" });
    expect(installedState([at("failed")])).toMatchObject({ label: "Failed", tone: "error" });
  });

  it("counts several installs with the worst state's dot and lists each", () => {
    expect(installedState([at("installed", "cut"), at("installed", "cut-2")])).toEqual({
      label: "Installed ×2",
      tone: "success",
      details: ["cut: Installed", "cut-2: Installed"],
    });
    expect(installedState([at("installed"), at("failed", "b"), at("updating", "c")])).toMatchObject(
      { label: "Installed ×3", tone: "error" },
    );
    expect(installedState([at("installed"), at("installing", "b")])).toMatchObject({
      tone: "neutral",
    });
  });
});
