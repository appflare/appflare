import { describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.ts";

describe("parseJsonc", () => {
  it("strips line and block comments", () => {
    const text = `{
      // a line comment
      "a": 1, /* inline block */ "b": 2
      /* multi
         line */
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas in objects and arrays", () => {
    const text = `{
      "list": [1, 2, 3,],
      "obj": { "x": true, },
    }`;
    expect(parseJsonc(text)).toEqual({ list: [1, 2, 3], obj: { x: true } });
  });

  it("does not touch comment-like or comma sequences inside strings", () => {
    const text = `{ "url": "https://x/y", "note": "a, b,]", "path": "// not a comment" }`;
    expect(parseJsonc(text)).toEqual({
      url: "https://x/y",
      note: "a, b,]",
      path: "// not a comment",
    });
  });

  it("handles escaped quotes inside strings", () => {
    const text = `{ "q": "she said \\"hi\\" // ok", }`;
    expect(parseJsonc(text)).toEqual({ q: 'she said "hi" // ok' });
  });
});
