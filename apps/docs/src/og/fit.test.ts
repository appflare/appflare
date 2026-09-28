import { describe, expect, it } from "vitest";
import { fitText, lineCount, textWidth } from "./fit.ts";

describe("textWidth", () => {
  it("grows with the text and the size, and bold is wider", () => {
    expect(textWidth("Appflare", 40)).toBeGreaterThan(textWidth("Appf", 40));
    expect(textWidth("Appflare", 80)).toBeCloseTo(2 * textWidth("Appflare", 40));
    expect(textWidth("Appflare", 40, true)).toBeGreaterThan(textWidth("Appflare", 40));
  });
});

describe("lineCount", () => {
  it("wraps at spaces, never inside a word", () => {
    expect(lineCount("", 500, 40)).toBe(0);
    expect(lineCount("Install", 10, 40)).toBe(1);
    expect(lineCount("Install from a repository", 10_000, 40)).toBe(1);
    expect(lineCount("Install from a repository", 10, 40)).toBe(4);
  });
});

describe("fitText", () => {
  const options = { width: 960, lines: 2, max: 84, min: 54, bold: true };

  it("draws a short title at the largest size", () => {
    expect(fitText("FAQ", options)).toBe(84);
  });

  it("shrinks a long title until it fits its lines", () => {
    const title = "Install an app from any GitHub repository with a wrangler config";
    const size = fitText(title, options);
    expect(size).toBeLessThan(84);
    expect(size).toBeGreaterThanOrEqual(54);
    expect(lineCount(title, 960 * 0.95, size, true)).toBeLessThanOrEqual(2);
  });

  it("stops at the smallest size when nothing fits, leaving the card to clamp", () => {
    expect(fitText("word ".repeat(80), options)).toBe(54);
  });
});
