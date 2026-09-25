import { describe, expect, it } from "vitest";
import { DISMISS_NOT_SAVED, dismissOptimistically } from "./optimistic-dismiss";

/** Records every step in order, with a save the test settles by hand. */
function harness() {
  const calls: string[] = [];
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const saved = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const outcome = dismissOptimistically({
    hide: () => calls.push("hide"),
    persist: () => {
      calls.push("persist");
      return saved;
    },
    restore: (error) => calls.push(`restore: ${String(error)}`),
  });
  return { calls, settle, outcome };
}

describe("dismissOptimistically", () => {
  it("hides before the save starts, and before it settles", () => {
    const { calls } = harness();
    // Synchronously, with the save still pending.
    expect(calls).toEqual(["hide", "persist"]);
  });

  it("keeps the element hidden when the save succeeds", async () => {
    const { calls, settle, outcome } = harness();
    settle.resolve();
    expect(await outcome).toBe("saved");
    expect(calls).toEqual(["hide", "persist"]);
  });

  it("restores the element when the save fails, and never rejects", async () => {
    const { calls, settle, outcome } = harness();
    settle.reject(new Error("offline"));
    expect(await outcome).toBe("restored");
    expect(calls).toEqual(["hide", "persist", "restore: Error: offline"]);
  });

  it("restores when the save throws before returning a promise", async () => {
    const calls: string[] = [];
    const outcome = await dismissOptimistically({
      hide: () => calls.push("hide"),
      persist: () => {
        throw new Error("no session");
      },
      restore: () => calls.push("restore"),
    });
    expect(outcome).toBe("restored");
    expect(calls).toEqual(["hide", "restore"]);
  });

  it("says the element came back", () => {
    expect(DISMISS_NOT_SAVED).toBe("Could not save; shown again");
  });
});
