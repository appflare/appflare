import { describe, expect, it } from "vitest";
import { APP_ENTRY_FRESH_MS, entryMemo } from "./app-entry-memo";

describe("the signed-in layout's gate answer in the browser", () => {
  it("serves page changes for 30 seconds", () => {
    expect(APP_ENTRY_FRESH_MS).toBe(30_000);
    const memo = entryMemo<string>();
    expect(memo.recall(1000)).toBeNull();
    memo.remember("owner", 1000);
    expect(memo.recall(1000)).toBe("owner");
    expect(memo.recall(1000 + APP_ENTRY_FRESH_MS - 1)).toBe("owner");
    expect(memo.recall(1000 + APP_ENTRY_FRESH_MS)).toBeNull();
    // Stale once means gone: it is not served again.
    expect(memo.recall(1000)).toBeNull();
  });

  it("is dropped on leaving the signed-in pages or after a change to the viewer", () => {
    const memo = entryMemo<string>();
    memo.remember("owner", 1000);
    memo.forget();
    expect(memo.recall(1001)).toBeNull();
  });

  it("does not trust a clock that went backwards", () => {
    const memo = entryMemo<string>();
    memo.remember("owner", 5000);
    expect(memo.recall(4000)).toBeNull();
  });
});
