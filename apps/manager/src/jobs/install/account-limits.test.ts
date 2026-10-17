import { CloudflareApiError } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { JobError } from "../errors";
import { accountLimitRefusal, explainLimitRefusal, freeLimitsApply } from "./account-limits";

describe("freeLimitsApply", () => {
  it("applies Workers Free's limits unless the account is known to be on Workers Paid", () => {
    expect(freeLimitsApply({ paid: true, knownFree: false, paidConfirmed: false })).toBe(false);
    expect(freeLimitsApply({ paid: false, knownFree: false, paidConfirmed: false })).toBe(true);
  });

  it("takes the admin's Workers Paid only while the plan is not known", () => {
    expect(freeLimitsApply({ paid: false, knownFree: false, paidConfirmed: true })).toBe(false);
    expect(freeLimitsApply({ paid: false, knownFree: true, paidConfirmed: true })).toBe(true);
    // A step output recorded before the plan's source was: as before.
    expect(freeLimitsApply({ paid: false, knownFree: undefined, paidConfirmed: true })).toBe(false);
  });
});

describe("accountLimitRefusal", () => {
  it("lets resources that fit through", () => {
    expect(
      accountLimitRefusal({ kind: "d1", existing: 8, wanted: 2, freeLimits: true }),
    ).toBeNull();
    expect(
      accountLimitRefusal({ kind: "vectorize", existing: 99, wanted: 1, freeLimits: true }),
    ).toBeNull();
  });

  it("names Workers Paid's limit only where an install could meet it", () => {
    expect(
      accountLimitRefusal({ kind: "d1", existing: 10_000, wanted: 1, freeLimits: false }),
    ).toBeNull();
    expect(
      accountLimitRefusal({ kind: "hyperdrive", existing: 25, wanted: 1, freeLimits: false }),
    ).toBe(
      "this app needs a new Hyperdrive configuration and the account already has 25; Workers Paid allows 25 per account, so this would make 26. Delete Hyperdrive configurations the account no longer uses (for example by uninstalling an app that connects to a database). Then try again.",
    );
  });

  it("takes an account past Workers Free's limit as on Workers Paid while the plan is not known", () => {
    // Only an account on Workers Paid can have 12 D1 databases: it installed
    // D1 apps before, and is not refused another.
    expect(
      accountLimitRefusal({ kind: "d1", existing: 12, wanted: 1, freeLimits: true }),
    ).toBeNull();
    expect(
      accountLimitRefusal({ kind: "vectorize", existing: 150, wanted: 1, freeLimits: true }),
    ).toBeNull();
    // Hyperdrive: then held to Workers Paid's 25.
    expect(
      accountLimitRefusal({ kind: "hyperdrive", existing: 11, wanted: 1, freeLimits: true }),
    ).toBeNull();
    expect(
      accountLimitRefusal({ kind: "hyperdrive", existing: 25, wanted: 1, freeLimits: true }),
    ).toMatch(
      /^this app needs a new Hyperdrive configuration and the account already has 25; Workers Paid allows 25 per account/,
    );
    // At Workers Free's limit exactly, the account may be on either plan.
    expect(accountLimitRefusal({ kind: "d1", existing: 10, wanted: 1, freeLimits: true })).toMatch(
      /^this app needs a new D1 database and the account already has 10; Workers Free allows 10 per account/,
    );
  });

  it("takes an account past Workers Paid's limit as one whose limit was raised", () => {
    for (const freeLimits of [true, false]) {
      expect(
        accountLimitRefusal({ kind: "hyperdrive", existing: 30, wanted: 1, freeLimits }),
      ).toBeNull();
    }
  });

  it("counts several new ones", () => {
    expect(
      accountLimitRefusal({ kind: "vectorize", existing: 99, wanted: 2, freeLimits: true }),
    ).toMatch(
      /^this app needs 2 new Vectorize indexes and the account already has 99; Workers Free allows 100 per account, so this would make 101\. .* or upgrade the account to Workers Paid \(50,000 per account\)\./,
    );
  });
});

describe("explainLimitRefusal", () => {
  const refusal = (code: number, message: string) =>
    new CloudflareApiError({
      status: 403,
      method: "POST",
      path: "/accounts/a/d1/database",
      errors: [{ code, message }],
    });

  it("says which limit Cloudflare refused at", async () => {
    await expect(
      explainLimitRefusal("d1", async () => {
        throw refusal(7406, "System limit reached: databases per account (10)");
      }),
    ).rejects.toThrow(JobError);
  });

  it("passes any other error on as it is", async () => {
    const other = refusal(10000, "Authentication error");
    await expect(
      explainLimitRefusal("d1", async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});
