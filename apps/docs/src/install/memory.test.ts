import { describe, expect, it } from "vitest";
import {
  blockedMemory,
  INTENT_KEY,
  INTENT_LIFETIME_MS,
  type KeyValueStore,
  MANAGER_KEY,
  openMemory,
} from "./memory.ts";
import { fakeStore } from "./test-store.ts";

const now = new Date("2026-09-28T12:00:00Z");
const origin = "https://appflare.example.com";

describe("openMemory", () => {
  it("remembers and forgets an address", () => {
    const store = fakeStore();
    const memory = openMemory(() => store);
    expect(memory.available).toBe(true);
    expect(memory.manager()).toBeNull();
    expect(memory.rememberManager(origin)).toBe(true);
    expect(store.data.get(MANAGER_KEY)).toBe(origin);
    expect(memory.manager()).toBe(origin);
    memory.forgetManager();
    expect(memory.manager()).toBeNull();
  });

  it("stores origins only, and removes anything else it finds", () => {
    const memory = openMemory(() => fakeStore({ [MANAGER_KEY]: "javascript:alert(1)" }));
    expect(memory.manager()).toBeNull();
    expect(memory.rememberManager("https://appflare.example.com/path")).toBe(false);
    expect(memory.rememberManager("http://evil.example")).toBe(false);
    for (const value of [`${origin}/`, "http://evil.example", "//evil.example", "javascript:x"]) {
      const store = fakeStore({ [MANAGER_KEY]: value });
      expect(openMemory(() => store).manager(), value).toBeNull();
      expect(store.data.has(MANAGER_KEY), value).toBe(false);
    }
  });

  it("keeps the app a visitor was about to install for 7 days", () => {
    const store = fakeStore();
    const memory = openMemory(() => store);
    expect(memory.saveIntent({ kind: "app", slug: "2fa" }, now)).toBe(true);
    expect(JSON.parse(store.data.get(INTENT_KEY) ?? "")).toEqual({
      kind: "app",
      slug: "2fa",
      savedAt: now.toISOString(),
    });
    expect(memory.intent(new Date(now.getTime() + INTENT_LIFETIME_MS))).toEqual({
      kind: "app",
      slug: "2fa",
      savedAt: now.toISOString(),
    });
    expect(memory.intent(new Date(now.getTime() + INTENT_LIFETIME_MS + 1))).toBeNull();
    expect(store.data.has(INTENT_KEY)).toBe(false);
  });

  it("drops an intent that is not one, or dated in the future", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ kind: "app", slug: "../x", savedAt: now.toISOString() }),
      JSON.stringify({ kind: "repo", repo: "o/r" }),
      JSON.stringify({ kind: "repo", repo: "o/r", savedAt: "2026-10-28T12:00:00Z" }),
    ]) {
      const store = fakeStore({ [INTENT_KEY]: raw });
      expect(openMemory(() => store).intent(now), raw).toBeNull();
      expect(store.data.has(INTENT_KEY)).toBe(false);
    }
  });

  it("clears the intent once its app is on its way, and only that one", () => {
    const store = fakeStore();
    const memory = openMemory(() => store);
    memory.saveIntent({ kind: "repo", repo: "Owner/Repo" }, now);
    memory.clearIntentFor({ kind: "app", slug: "2fa" });
    expect(memory.intent(now)).not.toBeNull();
    memory.clearIntentFor({ kind: "repo", repo: "owner/repo" });
    expect(memory.intent(now)).toBeNull();
  });

  it("keeps nothing where storage is blocked", () => {
    for (const memory of [
      openMemory(() => fakeStore({}, true)),
      openMemory(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
      openMemory(() => null),
    ]) {
      expect(memory.available).toBe(false);
      expect(memory.rememberManager(origin)).toBe(false);
      expect(memory.manager()).toBeNull();
      expect(memory.saveIntent({ kind: "app", slug: "2fa" }, now)).toBe(false);
      expect(memory.intent(now)).toBeNull();
    }
    expect(blockedMemory.available).toBe(false);
  });

  it("survives a store that starts refusing after the first check", () => {
    let refuse = false;
    const inner = fakeStore();
    const store: KeyValueStore = {
      getItem: (key) => (refuse ? fakeStore({}, true) : inner).getItem(key),
      setItem: (key, value) => (refuse ? fakeStore({}, true) : inner).setItem(key, value),
      removeItem: (key) => (refuse ? fakeStore({}, true) : inner).removeItem(key),
    };
    const memory = openMemory(() => store);
    refuse = true;
    expect(memory.rememberManager(origin)).toBe(false);
    expect(memory.manager()).toBeNull();
    expect(() => memory.forgetManager()).not.toThrow();
  });
});
