import { describe, expect, it } from "vitest";
import {
  type FlowAction,
  type FlowState,
  loadingState,
  managerFromFragment,
  reduce,
  startInstall,
  startMy,
} from "./flow.ts";
import { INTENT_KEY, MANAGER_KEY, type Memory, openMemory } from "./memory.ts";
import type { InstallRequest } from "./request.ts";
import { fakeStore } from "./test-store.ts";

const now = new Date("2026-09-28T12:00:00Z");
const origin = "https://appflare.example.com";
const app: InstallRequest = { kind: "app", slug: "2fa" };
const repo: InstallRequest = { kind: "repo", repo: "wuzf/2fa" };
const catalogApp = { slug: "2fa", name: "2FA" };

function setup(initial: Record<string, string> = {}, refuse = false) {
  const store = fakeStore(initial, refuse);
  const memory = openMemory(() => store);
  return { store, memory };
}

/** Plays clicks in order, returning the last state. */
function play(start: FlowState, memory: Memory, ...actions: FlowAction[]): FlowState {
  return actions.reduce((state, action) => reduce(state, action, memory, now), start);
}

describe("install page", () => {
  it("says a link is not valid when it names nothing", () => {
    const { memory } = setup();
    expect(startInstall(null, null, memory).view).toEqual({ step: "invalid" });
  });

  it("starts as loading, before the page runs in the browser", () => {
    const state = loadingState({ page: "install", request: app, catalogApp: null });
    expect(state.view).toEqual({ step: "loading" });
  });

  it("forwards a visitor whose Appflare is remembered, showing where", () => {
    const { memory } = setup({ [MANAGER_KEY]: origin });
    expect(startInstall(app, null, memory).view).toEqual({
      step: "opening",
      origin,
      target: `${origin}/install/2fa`,
      remembered: true,
    });
    expect(startInstall({ kind: "repo", repo: "o/r" }, null, memory).view).toMatchObject({
      target: `${origin}/install/github/o/r`,
    });
  });

  it("asks a first-time visitor whether they have Appflare", () => {
    const { memory } = setup();
    expect(startInstall(app, null, memory)).toEqual({
      context: { page: "install", request: app, catalogApp: null },
      canRemember: true,
      view: { step: "ask" },
    });
  });

  it("ignores a remembered value that is not an address", () => {
    const { memory } = setup({ [MANAGER_KEY]: "javascript:alert(1)" });
    expect(startInstall(app, null, memory).view).toEqual({ step: "ask" });
  });

  it("enters an address, asks to remember it, remembers it on the click, then forwards", () => {
    const { store, memory } = setup();
    const start = startInstall(app, null, memory);
    const entered = play(
      start,
      memory,
      { type: "choose-enter" },
      { type: "edit", value: "appflare.example.com/some/page" },
      { type: "submit" },
    );
    expect(entered.view).toEqual({ step: "remember", origin, replaces: null });
    expect(store.data.has(MANAGER_KEY)).toBe(false);
    const remembered = play(entered, memory, { type: "remember" });
    expect(store.data.get(MANAGER_KEY)).toBe(origin);
    expect(remembered.view).toEqual({
      step: "opening",
      origin,
      target: `${origin}/install/2fa`,
      remembered: true,
    });
  });

  it("opens without remembering when asked to, and goes back to the field", () => {
    const { store, memory } = setup();
    const asked = play(
      startInstall(app, null, memory),
      memory,
      { type: "choose-enter" },
      { type: "edit", value: origin },
      { type: "submit" },
    );
    expect(play(asked, memory, { type: "back" }).view).toEqual({
      step: "enter",
      value: origin,
      error: null,
    });
    expect(play(asked, memory, { type: "once" }).view).toMatchObject({
      step: "opening",
      remembered: false,
    });
    expect(store.data.has(MANAGER_KEY)).toBe(false);
  });

  it("refuses an address that is not one, and keeps the visitor on the field", () => {
    const { memory } = setup();
    const entering = play(startInstall(app, null, memory), memory, { type: "choose-enter" });
    for (const value of [
      "javascript:alert(1)",
      "//evil.example",
      "https://user:pw@appflare.example.com",
      "http://appflare.example.com",
      "",
    ]) {
      const state = play(entering, memory, { type: "edit", value }, { type: "submit" });
      expect(state.view.step, value).toBe("enter");
      expect(state.view.step === "enter" && state.view.error, value).toBeTruthy();
    }
    const fixed = play(
      entering,
      memory,
      { type: "edit", value: "javascript:alert(1)" },
      { type: "submit" },
      { type: "edit", value: "j" },
    );
    expect(fixed.view).toEqual({ step: "enter", value: "j", error: null });
  });

  it("stops forwarding on Change, with the address ready to edit", () => {
    const { memory } = setup({ [MANAGER_KEY]: origin });
    const changed = play(startInstall(app, null, memory), memory, { type: "change" });
    expect(changed.view).toEqual({ step: "enter", value: origin, error: null });
    const other = "https://other.example.com";
    const asked = play(changed, memory, { type: "edit", value: other }, { type: "submit" });
    expect(asked.view).toEqual({ step: "remember", origin: other, replaces: origin });
    // The same address again needs no question.
    const same = play(changed, memory, { type: "submit" });
    expect(same.view).toMatchObject({ step: "opening", origin, remembered: true });
  });

  it("saves the app for 7 days while the visitor gets Appflare", () => {
    const { store, memory } = setup();
    const got = play(startInstall(app, null, memory), memory, { type: "choose-get" });
    expect(got.view).toEqual({ step: "get", intentSaved: true });
    expect(JSON.parse(store.data.get(INTENT_KEY) ?? "")).toEqual({
      kind: "app",
      slug: "2fa",
      savedAt: now.toISOString(),
    });
    expect(play(got, memory, { type: "back" }).view).toEqual({ step: "ask" });
    expect(play(got, memory, { type: "choose-enter" }).view).toMatchObject({ step: "enter" });
  });

  it("clears the saved app once it is on its way", () => {
    const { store, memory } = setup();
    memory.saveIntent(app, now);
    memory.rememberManager(origin);
    startInstall(app, null, memory);
    expect(store.data.has(INTENT_KEY)).toBe(false);
  });

  it("offers the catalog's app first for a repository the catalog has", () => {
    const { memory } = setup({ [MANAGER_KEY]: origin });
    const start = startInstall(repo, catalogApp, memory);
    expect(start.view).toEqual({ step: "in-catalog", app: catalogApp });
    expect(play(start, memory, { type: "use-repository" }).view).toEqual({
      step: "opening",
      origin,
      target: `${origin}/install/github/wuzf/2fa`,
      remembered: true,
    });
    const fresh = setup().memory;
    expect(
      play(startInstall(repo, catalogApp, fresh), fresh, { type: "use-repository" }).view,
    ).toEqual({
      step: "ask",
    });
  });

  it("asks each time where storage is blocked, and still opens the Appflare", () => {
    const { memory } = setup({}, true);
    const start = startInstall(app, null, memory);
    expect(start.canRemember).toBe(false);
    expect(start.view).toEqual({ step: "ask" });
    const opened = play(
      start,
      memory,
      { type: "choose-enter" },
      { type: "edit", value: origin },
      { type: "submit" },
    );
    expect(opened.view).toEqual({
      step: "opening",
      origin,
      target: `${origin}/install/2fa`,
      remembered: false,
    });
    expect(play(start, memory, { type: "choose-get" }).view).toEqual({
      step: "get",
      intentSaved: false,
    });
  });

  it("ignores clicks a step does not offer", () => {
    const { memory } = setup();
    const start = startInstall(app, null, memory);
    for (const action of [
      { type: "submit" },
      { type: "remember" },
      { type: "once" },
      { type: "change" },
      { type: "use-repository" },
      { type: "forget" },
      { type: "edit", value: "x" },
    ] satisfies FlowAction[]) {
      expect(reduce(start, action, memory, now), action.type).toBe(start);
    }
  });
});

describe("managerFromFragment", () => {
  it("reads the address a manager's link carries", () => {
    expect(managerFromFragment(`#manager=${encodeURIComponent(origin)}`)).toBe(origin);
    expect(managerFromFragment(`#manager=${origin}/settings`)).toBe(origin);
    expect(managerFromFragment("")).toBeNull();
    expect(managerFromFragment("#")).toBeNull();
    expect(managerFromFragment("#top")).toBeNull();
  });

  it("refuses anything that is not an address", () => {
    for (const hash of [
      "#manager=javascript:alert(1)",
      "#manager=%2F%2Fevil.example",
      "#manager=http://evil.example",
      "#manager=https://u:p@appflare.example.com",
      "#manager=appflare.example.com",
      "#manager=",
      `#manager=${origin}&manager=https://other.example.com`,
    ]) {
      expect(managerFromFragment(hash), hash).toBe("invalid");
    }
  });
});

describe("/my/", () => {
  const link = `#manager=${encodeURIComponent(origin)}`;

  it("asks before remembering an Appflare, and stores nothing without the click", () => {
    const { store, memory } = setup();
    const start = startMy(link, memory, now);
    expect(start.view).toEqual({ step: "remember", origin, replaces: null });
    expect(store.data.has(MANAGER_KEY)).toBe(false);
    const remembered = play(start, memory, { type: "remember" });
    expect(store.data.get(MANAGER_KEY)).toBe(origin);
    expect(remembered.view).toEqual({ step: "saved", origin, intent: null, justRemembered: true });
  });

  it("says which Appflare a new one replaces, and cancels without a change", () => {
    const other = "https://other.example.com";
    const { store, memory } = setup({ [MANAGER_KEY]: other });
    const start = startMy(link, memory, now);
    expect(start.view).toEqual({ step: "remember", origin, replaces: other });
    const cancelled = play(start, memory, { type: "back" });
    expect(cancelled.view).toEqual({
      step: "saved",
      origin: other,
      intent: null,
      justRemembered: false,
    });
    expect(store.data.get(MANAGER_KEY)).toBe(other);
  });

  it("offers to continue installing the saved app", () => {
    const { memory } = setup();
    memory.saveIntent(app, now);
    const remembered = play(startMy(link, memory, now), memory, { type: "remember" });
    expect(remembered.view).toEqual({
      step: "saved",
      origin,
      intent: { ...app, savedAt: now.toISOString() },
      justRemembered: true,
    });
  });

  it("shows the remembered Appflare and forgets it", () => {
    const { store, memory } = setup({ [MANAGER_KEY]: origin });
    const start = startMy("", memory, now);
    expect(start.view).toEqual({ step: "saved", origin, intent: null, justRemembered: false });
    expect(startMy(link, memory, now).view).toMatchObject({ step: "saved", origin });
    const forgotten = play(start, memory, { type: "forget" });
    expect(forgotten.view).toEqual({ step: "none", forgotten: true });
    expect(store.data.has(MANAGER_KEY)).toBe(false);
  });

  it("lets a visitor enter an address by hand", () => {
    const { memory } = setup();
    const start = startMy("", memory, now);
    expect(start.view).toEqual({ step: "none", forgotten: false });
    const asked = play(
      start,
      memory,
      { type: "choose-enter" },
      { type: "edit", value: "appflare.example.com" },
      { type: "submit" },
    );
    expect(asked.view).toEqual({ step: "remember", origin, replaces: null });
    expect(play(asked, memory, { type: "remember" }).view).toMatchObject({ step: "saved", origin });
    const fresh = setup().memory;
    const back = play(startMy("", fresh, now), fresh, { type: "choose-enter" }, { type: "back" });
    expect(back.view).toEqual({
      step: "none",
      forgotten: false,
    });
  });

  it("says a link with a bad address is not valid", () => {
    const { store, memory } = setup();
    expect(startMy("#manager=javascript:alert(1)", memory, now).view).toEqual({ step: "invalid" });
    expect(store.data.size).toBe(0);
  });

  it("says an address cannot be remembered where storage is blocked", () => {
    const { memory } = setup({}, true);
    const start = startMy(link, memory, now);
    expect(start.view).toEqual({ step: "cannot-remember", origin });
    expect(start.canRemember).toBe(false);
    expect(startMy("", memory, now).view).toEqual({ step: "none", forgotten: false });
    const typed = play(
      startMy("", memory, now),
      memory,
      { type: "choose-enter" },
      { type: "edit", value: origin },
      { type: "submit" },
    );
    expect(typed.view).toEqual({ step: "cannot-remember", origin });
  });
});
