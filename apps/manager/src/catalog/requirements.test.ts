import { type InstallTier, installTierSchema, requirementSchema } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  REQUIREMENTS,
  requirementLabel,
  requirementSentence,
  requirementsToConfirm,
} from "./requirements";

const TIERS: readonly InstallTier[] = installTierSchema.options;

describe("an entry that needs Cloudflare Access only while protected", () => {
  it("says Access is needed only if the admin protects the app", () => {
    const sentence = requirementSentence("access", { tier: "artifact", accessIfProtected: true });
    expect(sentence).toMatch(/^Only if you protect the app with Cloudflare Access/);
    expect(sentence).toContain("Without protection the app installs on any account.");
    expect(requirementSentence("access", { tier: "artifact" })).toBe(REQUIREMENTS.access.sentence);
    // Other requirements are not affected.
    expect(requirementSentence("r2", { tier: "artifact", accessIfProtected: true })).toBe(
      REQUIREMENTS.r2.sentence,
    );
  });

  it("asks for no confirmation of it, unless protection is required", () => {
    expect(requirementsToConfirm({ requires: ["access", "r2"] })).toEqual(["r2"]);
    expect(
      requirementsToConfirm({ requires: ["access"], access: { mode: "recommended" } }),
    ).toEqual([]);
    expect(requirementsToConfirm({ requires: ["access"], access: { mode: "required" } })).toEqual([
      "access",
    ]);
    expect(requirementsToConfirm({ requires: ["zone"] })).toEqual(["zone"]);
  });
});

describe("requirementSentence", () => {
  it("keeps every artifact tier sentence as the requirement's own", () => {
    for (const requirement of requirementSchema.options) {
      expect(requirementSentence(requirement, { tier: "artifact" })).toBe(
        REQUIREMENTS[requirement].sentence,
      );
    }
    expect(requirementSentence("containers", { tier: "artifact" })).toBe(
      "The app runs Containers, which need the Workers Paid plan on the account.",
    );
  });

  it("says a sandbox tier app is built in a container, not that it runs Containers", () => {
    expect(requirementSentence("containers", { tier: "sandbox" })).toBe(
      "The app is built in a container in this account, which needs the Workers Paid plan.",
    );
  });

  it("says a self-deploying app's installer runs in a container", () => {
    expect(requirementSentence("containers", { tier: "self-deploying" })).toBe(
      "The app's installer runs in a container in this account, which needs the Workers Paid plan.",
    );
  });

  it("keeps the sentences that hold for every tier", () => {
    const shared = ["r2", "zone", "workers-ai", "browser-rendering"] as const;
    for (const tier of TIERS) {
      for (const requirement of shared) {
        expect(requirementSentence(requirement, { tier })).toBe(REQUIREMENTS[requirement].sentence);
      }
    }
    expect(requirementSentence("email-routing", { tier: "sandbox" })).toBe(
      REQUIREMENTS["email-routing"].sentence,
    );
  });

  it("says Appflare sets Email Routing up for the apps it deploys", () => {
    for (const tier of ["artifact", "sandbox"] as const) {
      expect(
        requirementSentence("email-routing", { tier, provisionsEmailRouting: true }),
      ).toContain("Appflare turns Email Routing on");
    }
  });

  it("does not promise Email Routing setup for a self-deploying app", () => {
    for (const provisionsEmailRouting of [false, true]) {
      const sentence = requirementSentence("email-routing", {
        tier: "self-deploying",
        provisionsEmailRouting,
      });
      expect(sentence).toContain("must be enabled");
      expect(sentence).toContain("does not set Email Routing up");
      expect(sentence).not.toContain("the app's Worker");
    }
  });

  it("has no sentence for a requirement this manager does not know, in any tier", () => {
    for (const tier of TIERS) {
      expect(requirementSentence("quantum", { tier })).toBeNull();
    }
    expect(requirementLabel("quantum")).toBe("quantum");
  });
});
