import { describe, expect, it } from "vitest";
import { appPitch, pitchFromSummary } from "./pitch";

describe("pitchFromSummary", () => {
  it("keeps the first clause of a summary, without its closing punctuation", () => {
    expect(pitchFromSummary("A Memos-compatible notes app. Runs on D1 and R2.")).toBe(
      "A Memos-compatible notes app",
    );
    expect(pitchFromSummary("Disposable inboxes: receive mail at any address.")).toBe(
      "Disposable inboxes",
    );
    expect(pitchFromSummary("Feedback boards for products, built on Workers and D1.")).toBe(
      "Feedback boards for products",
    );
    expect(pitchFromSummary("Uptime checks — with a status page")).toBe("Uptime checks");
  });

  it("keeps the whole summary when the first clause would be too short, or there is none", () => {
    expect(pitchFromSummary("Self-hosted link shortener on Workers + KV.")).toBe(
      "Self-hosted link shortener on Workers + KV",
    );
    expect(pitchFromSummary("Menus. For cafés.")).toBe("Menus. For cafés");
    expect(pitchFromSummary("  Notes  ")).toBe("Notes");
  });
});

describe("appPitch", () => {
  it("prefers the tagline, and falls back to the summary", () => {
    expect(
      appPitch({ tagline: "Short links on your own domain", summary: "Cut. A shortener." }),
    ).toBe("Short links on your own domain");
    expect(appPitch({ summary: "A Memos-compatible notes app. Runs on D1." })).toBe(
      "A Memos-compatible notes app",
    );
    expect(appPitch({ tagline: "  ", summary: "A Memos-compatible notes app." })).toBe(
      "A Memos-compatible notes app",
    );
  });
});
