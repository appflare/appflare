import { describe, expect, it } from "vitest";
import { monogram } from "./monogram";

describe("monogram", () => {
  it("takes the first letters of the first two words", () => {
    expect(monogram("UniFi DDNS")).toBe("UD");
    expect(monogram("ChatGPT Telegram Bot")).toBe("CT");
    expect(monogram("OpenAI Gemini")).toBe("OG");
    expect(monogram("r2-explorer")).toBe("RE");
    expect(monogram("second_brain")).toBe("SB");
  });

  it("uses the next capital of a single camel-case word, else its second letter", () => {
    expect(monogram("FlareMo")).toBe("FM");
    expect(monogram("OpenSEO")).toBe("OS");
    expect(monogram("Mailflare")).toBe("MA");
    expect(monogram("cut")).toBe("CU");
  });

  it("copes with one letter, punctuation, other scripts and nothing at all", () => {
    expect(monogram("X")).toBe("X");
    expect(monogram("  (Cut)  ")).toBe("CU");
    expect(monogram("Émile Zola")).toBe("ÉZ");
    expect(monogram("日本 語")).toBe("日語");
    expect(monogram("")).toBe("?");
    expect(monogram("!!")).toBe("?");
  });
});
