import { describe, expect, it } from "vitest";
import { reinstallRefusal, reinstallSentence, tierChanged, updateOffer } from "./tier-change";

describe("tierChanged", () => {
  it("is true only across the line between an app's own installer and Appflare's deploys", () => {
    expect(tierChanged("self-deploying", "artifact")).toBe(true);
    expect(tierChanged("self-deploying", "sandbox")).toBe(true);
    expect(tierChanged("artifact", "self-deploying")).toBe(true);
    expect(tierChanged("sandbox", "self-deploying")).toBe(true);
    // A release and a build in the account are both deployed by Appflare.
    expect(tierChanged("artifact", "sandbox")).toBe(false);
    expect(tierChanged("sandbox", "artifact")).toBe(false);
    expect(tierChanged("self-deploying", "self-deploying")).toBe(false);
    expect(tierChanged("self-deploying", null)).toBe(false);
  });
});

describe("updateOffer", () => {
  const installed = { status: "installed", build_kind: "self-deploying", catalog_version: "0.1.9" };

  it("offers a newer version of an entry that changed how it is installed as a reinstall only", () => {
    expect(updateOffer(installed, { version: "0.1.10", tier: "artifact" })).toEqual({
      updateAvailable: false,
      reinstallNeeded: true,
    });
    expect(updateOffer(installed, { version: "0.1.10", tier: "self-deploying" })).toEqual({
      updateAvailable: true,
      reinstallNeeded: false,
    });
  });

  it("offers nothing without a newer version, or while the app is not installed", () => {
    const none = { updateAvailable: false, reinstallNeeded: false };
    expect(updateOffer(installed, { version: "0.1.9", tier: "artifact" })).toEqual(none);
    expect(updateOffer(installed, null)).toEqual(none);
    expect(
      updateOffer({ ...installed, status: "updating" }, { version: "0.1.10", tier: "artifact" }),
    ).toEqual(none);
  });
});

describe("the words", () => {
  it("say what changed and what to do", () => {
    expect(reinstallRefusal("OpenSEO", "self-deploying")).toBe(
      "OpenSEO changed how it is installed (it no longer ships its own installer). Uninstall it and install it again.",
    );
    expect(reinstallSentence("artifact")).toContain("it now ships its own installer");
    expect(reinstallSentence("artifact")).toMatch(/uninstall it and install it again/);
  });
});
