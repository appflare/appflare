import { describe, expect, it } from "vitest";
import {
  arriveAtHash,
  FIND_TIMEOUT_MS,
  type HashTargetElement,
  type HashTargetWindow,
  HIGHLIGHT_CLASSES,
  HIGHLIGHT_MS,
  hashTargetId,
} from "./hash-target";
import {
  followHashTargets,
  type HashTargetLocation,
  type HashTargetRouter,
} from "./use-hash-target";

/** An element that records what was done to it. */
class FakeElement implements HashTargetElement {
  scrolls: ScrollIntoViewOptions[] = [];
  classes = new Set<string>();
  scrollIntoView(options: ScrollIntoViewOptions) {
    this.scrolls.push(options);
  }
  classList = {
    add: (...tokens: string[]) => {
      for (const t of tokens) this.classes.add(t);
    },
    remove: (...tokens: string[]) => {
      for (const t of tokens) this.classes.delete(t);
    },
  };
  get ringed() {
    return HIGHLIGHT_CLASSES.every((c) => this.classes.has(c));
  }
}

/** A window with a hand-driven clock: frames and timers run when the test says. */
class FakeWindow implements HashTargetWindow {
  elements = new Map<string, FakeElement>();
  reduceMotion = false;
  time = 0;
  private next = 1;
  private frames = new Map<number, () => void>();
  private timers = new Map<number, { at: number; run: () => void }>();

  getElementById(id: string) {
    return this.elements.get(id) ?? null;
  }
  prefersReducedMotion() {
    return this.reduceMotion;
  }
  requestAnimationFrame(callback: () => void) {
    const id = this.next++;
    this.frames.set(id, callback);
    return id;
  }
  cancelAnimationFrame(handle: number) {
    this.frames.delete(handle);
  }
  setTimeout(callback: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run: callback });
    return id;
  }
  clearTimeout(handle: number) {
    this.timers.delete(handle);
  }
  now() {
    return this.time;
  }
  /** Runs the pending frames, 16 ms apart. */
  frame() {
    this.time += 16;
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const run of pending) run();
  }
  /** Moves the clock on and runs the timers that are due. */
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.run();
      }
    }
  }
  get pendingFrames() {
    return this.frames.size;
  }
  get pendingTimers() {
    return this.timers.size;
  }
}

describe("hashTargetId", () => {
  it("reads the element id from a hash, with or without its #", () => {
    expect(hashTargetId("#github-access")).toBe("github-access");
    expect(hashTargetId("github-access")).toBe("github-access");
    expect(hashTargetId("#checklist%2Dr2")).toBe("checklist-r2");
    expect(hashTargetId("#")).toBeNull();
    expect(hashTargetId("")).toBeNull();
  });
});

describe("arriveAtHash", () => {
  it("scrolls to the target on the next frame and rings it for 1.5 s", () => {
    const win = new FakeWindow();
    const target = new FakeElement();
    win.elements.set("sandbox", target);
    arriveAtHash(win, "#sandbox");
    // Not before the next frame: the router's own scrolling runs first.
    expect(target.scrolls).toEqual([]);
    win.frame();
    expect(target.scrolls).toEqual([{ block: "start", behavior: "smooth" }]);
    expect(target.ringed).toBe(true);
    win.advance(HIGHLIGHT_MS - 1);
    expect(target.ringed).toBe(true);
    win.advance(1);
    expect(target.ringed).toBe(false);
    expect(win.pendingTimers).toBe(0);
  });

  it("jumps without animation when the reader asked for less motion", () => {
    const win = new FakeWindow();
    win.reduceMotion = true;
    const target = new FakeElement();
    win.elements.set("versions", target);
    arriveAtHash(win, "#versions");
    win.frame();
    expect(target.scrolls).toEqual([{ block: "start", behavior: "auto" }]);
  });

  it("waits for a target that is still loading, then gives up", () => {
    const win = new FakeWindow();
    arriveAtHash(win, "#passkeys");
    win.frame();
    win.frame();
    const target = new FakeElement();
    win.elements.set("passkeys", target);
    win.frame();
    expect(target.scrolls).toHaveLength(1);
    expect(target.ringed).toBe(true);

    const late = new FakeWindow();
    arriveAtHash(late, "#never");
    while (late.pendingFrames > 0 && late.time <= FIND_TIMEOUT_MS + 100) late.frame();
    expect(late.pendingFrames).toBe(0);
    expect(late.time).toBeGreaterThanOrEqual(FIND_TIMEOUT_MS);
    expect(late.time).toBeLessThan(FIND_TIMEOUT_MS + 100);
  });

  it("does nothing without a hash", () => {
    const win = new FakeWindow();
    arriveAtHash(win, "");
    expect(win.pendingFrames).toBe(0);
  });

  it("stops and takes the ring off at once when cleaned up", () => {
    const win = new FakeWindow();
    const target = new FakeElement();
    win.elements.set("access", target);
    const stop = arriveAtHash(win, "#access");
    win.frame();
    expect(target.ringed).toBe(true);
    expect(win.pendingTimers).toBe(1);
    stop();
    expect(target.ringed).toBe(false);
    expect(win.pendingTimers).toBe(0);

    const early = new FakeWindow();
    const stopEarly = arriveAtHash(early, "#access");
    stopEarly();
    expect(early.pendingFrames).toBe(0);
  });
});

describe("followHashTargets", () => {
  function setUp(hash: string) {
    const win = new FakeWindow();
    const hashListeners = new Set<() => void>();
    const location: HashTargetLocation & { hash: string } = {
      hash,
      addEventListener: (_type, listener) => {
        hashListeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        hashListeners.delete(listener);
      },
    };
    const resolve: (e: { hrefChanged: boolean; hash: string }) => void = () => {};
    return { win, location, resolve, hashListeners };
  }

  it("arrives at the hash the page opened with", () => {
    const t = setUp("#github-access");
    const target = new FakeElement();
    t.win.elements.set("github-access", target);
    followHashTargets(t.win, { subscribe: () => () => {} }, t.location);
    t.win.frame();
    expect(target.scrolls).toHaveLength(1);
    expect(target.ringed).toBe(true);
  });

  it("arrives again after a navigation to a new address, not after a data reload", () => {
    const t = setUp("");
    const router: HashTargetRouter = {
      subscribe: (_e, listener) => {
        t.resolve = (e) => listener({ hrefChanged: e.hrefChanged, toLocation: { hash: e.hash } });
        return () => {};
      },
    };
    const sandbox = new FakeElement();
    t.win.elements.set("sandbox", sandbox);
    followHashTargets(t.win, router, t.location);
    // An action reloads the page's data; the address is the same.
    t.resolve({ hrefChanged: false, hash: "sandbox" });
    t.win.frame();
    expect(sandbox.scrolls).toHaveLength(0);
    // A link to another section of the page.
    t.resolve({ hrefChanged: true, hash: "sandbox" });
    t.win.frame();
    expect(sandbox.scrolls).toHaveLength(1);
    expect(sandbox.ringed).toBe(true);
  });

  it("follows hashchange, and lets go of everything on cleanup", () => {
    const t = setUp("");
    let unsubscribed = false;
    const router: HashTargetRouter = {
      subscribe: () => () => {
        unsubscribed = true;
      },
    };
    const users = new FakeElement();
    t.win.elements.set("users", users);
    const stop = followHashTargets(t.win, router, t.location);
    t.location.hash = "#users";
    for (const l of t.hashListeners) l();
    t.win.frame();
    expect(users.ringed).toBe(true);
    stop();
    expect(unsubscribed).toBe(true);
    expect(t.hashListeners.size).toBe(0);
    expect(users.ringed).toBe(false);
  });
});
