import { describe, expect, it } from "vitest";
import { appPitch } from "./pitch";

describe("appPitch", () => {
  it("is the tagline, whatever the summary says", () => {
    const app = { tagline: "Short links on your own domain", summary: "Cut. A shortener." };
    expect(appPitch(app)).toBe("Short links on your own domain");
  });
});
