import { describe, expect, it } from "vitest";
import { fakeStep } from "../test/fake-step";
import { boundedStepName, MAX_STEP_NAME_LENGTH, withBoundedStepNames } from "./step-names";

describe("step names", () => {
  it("keeps a name the engine takes as it is", () => {
    const name = `upload the stand-ins of Workers ${"a".repeat(MAX_STEP_NAME_LENGTH - 32)}`;
    expect(name).toHaveLength(MAX_STEP_NAME_LENGTH);
    expect(boundedStepName(name)).toBe(name);
  });

  it("cuts a longer one to 256 characters, the same way every time", () => {
    const workers = Array.from({ length: 10 }, (_, i) => `cloudflare-os-gatekeeper-${i}`);
    const name = `upload the stand-ins of Workers ${workers.join(", ")}`;
    const bounded = boundedStepName(name);
    expect(bounded).toHaveLength(MAX_STEP_NAME_LENGTH);
    expect(bounded).toMatch(
      /^upload the stand-ins of Workers cloudflare-os-gatekeeper-0, .* … [0-9a-f]{8}$/,
    );
    expect(boundedStepName(name)).toBe(bounded);
    expect(boundedStepName(bounded)).toBe(bounded);
  });

  it("never cuts an emoji in half", () => {
    const suffixLength = " … 00000000".length;
    for (const offset of [0, 1]) {
      // An emoji whose two halves straddle the cut, or end just at it.
      const name = `${"w".repeat(MAX_STEP_NAME_LENGTH - suffixLength - 1 - offset)}${"🚀".repeat(20)}`;
      const bounded = boundedStepName(name);
      expect(bounded.length).toBeLessThanOrEqual(MAX_STEP_NAME_LENGTH);
      // No lone half of a pair: encodeURIComponent throws on one.
      expect(() => encodeURIComponent(bounded), `offset ${offset}`).not.toThrow();
      expect(bounded).toMatch(/ … [0-9a-f]{8}$/);
    }
  });

  it("keeps two long names that start alike apart", () => {
    const start = "x".repeat(300);
    expect(boundedStepName(`${start}a`)).not.toBe(boundedStepName(`${start}b`));
  });

  it("bounds every step and sleep a job makes", async () => {
    const step = fakeStep();
    const bounded = withBoundedStepNames(step);
    const long = "y".repeat(400);
    expect(await bounded.do(long, async () => ({ ran: true }))).toEqual({ ran: true });
    expect(
      await bounded.do(long, { retries: { limit: 0, delay: 0 } }, async () => ({ again: true })),
    ).toEqual({ again: true });
    await bounded.sleep(long, "1 second");
    expect(step.names).toEqual([boundedStepName(long), boundedStepName(long)]);
    expect(step.sleeps).toEqual([boundedStepName(long)]);
  });

  it("is what the engine refuses past 256 characters", async () => {
    await expect(fakeStep().do("z".repeat(257), async () => ({}))).rejects.toThrow(
      "exceeds max length (256 chars)",
    );
  });
});
