import { describe, expect, it } from "vitest";
import { isRuntimeUpdate } from "./restart";

describe("isRuntimeUpdate", () => {
  it("recognizes the Sandbox SDK's and the runtime's messages for a reset by a new version", () => {
    expect(
      isRuntimeUpdate(
        new Error(
          "Sandbox operation sandbox.exec was interrupted while the platform was updating the sandbox runtime",
        ),
      ),
    ).toBe(true);
    expect(isRuntimeUpdate(new Error("Durable Object reset because its code was updated."))).toBe(
      true,
    );
    // Wrapped, with the platform's error as the cause.
    expect(
      isRuntimeUpdate(
        new Error("exec failed", {
          cause: new Error("Durable Object reset because its code was updated."),
        }),
      ),
    ).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isRuntimeUpdate(new Error("Container is not ready (capacity)"))).toBe(false);
    expect(isRuntimeUpdate("reset")).toBe(false);
    expect(isRuntimeUpdate(null)).toBe(false);
  });
});
