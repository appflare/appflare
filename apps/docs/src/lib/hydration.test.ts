import { describe, expect, it, vi } from "vitest";
import { SETTLE_WAIT_MS, type SettlingRouter, settled } from "./hydration.ts";

/** A router showing matches in `statuses`, whose load the test finishes. */
function router(...statuses: string[]) {
  const steps: string[] = [];
  let finish: (failure?: Error) => void = () => {};
  const fake: SettlingRouter = {
    state: { matches: statuses.map((status) => ({ status })) },
    load: vi.fn(
      (options: { sync: true }) =>
        new Promise<void>((resolve, reject) => {
          steps.push(`load ${JSON.stringify(options)}`);
          finish = (failure) => (failure === undefined ? resolve() : reject(failure));
        }),
    ),
  };
  return { fake, steps, finish: (failure?: Error) => finish(failure) };
}

describe("hydrating a page", () => {
  it("waits for the router to load a page it still shows as loading, as on 404.html", async () => {
    // 404.html at an app's address: the root is loaded, the app's route is not.
    const { fake, steps, finish } = router("success", "pending");
    const ready = settled(fake).then((settledRouter) => {
      steps.push("hydrate");
      return settledRouter;
    });
    await Promise.resolve();
    expect(steps).toEqual(['load {"sync":true}']);
    finish();
    expect(await ready).toBe(fake);
    expect(steps).toEqual(['load {"sync":true}', "hydrate"]);
  });

  it("hydrates a prerendered page straight away", async () => {
    const { fake } = router("success", "success");
    expect(await settled(fake)).toBe(fake);
    expect(fake.load).not.toHaveBeenCalled();
  });

  it("still hydrates when the load fails, so the page shows the route's error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, finish } = router("success", "pending");
    const ready = settled(fake);
    await Promise.resolve();
    finish(new Error("chunk failed to load"));
    expect(await ready).toBe(fake);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("hydrates anyway when the load never finishes, so the page is not left dead", async () => {
    vi.useFakeTimers();
    try {
      const { fake } = router("success", "pending");
      let hydrated = false;
      const ready = settled(fake).then(() => {
        hydrated = true;
      });
      await vi.advanceTimersByTimeAsync(SETTLE_WAIT_MS - 1);
      expect(hydrated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await ready;
      expect(hydrated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
