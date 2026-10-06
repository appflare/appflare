import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app page's health row. "Check now" runs a server function, which only
 * exists under the Start Vite plugin; it and the router are stubbed here.
 * The row reads what the check recorded from the reloaded install.
 */
const invalidate = vi.hoisted(() => vi.fn(async () => {}));
const check = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate }) }));
vi.mock("../installs/health.functions", () => ({ checkInstallHealth: check }));

import { InstallHealth } from "./install-health";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  invalidate.mockClear();
  check.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(status: "verified" | "unverified" | "unhealthy", access: boolean) {
  act(() =>
    root.render(
      <InstallHealth
        installId="i1"
        status={status}
        access={access}
        checkedAt="2026-09-30T10:00:00.000Z"
        canCheck
      />,
    ),
  );
  return container.textContent ?? "";
}

describe("InstallHealth", () => {
  it("says Cloudflare Access answered, not that the Worker did not answer", () => {
    const text = show("unverified", true);
    expect(text).toContain("Behind Cloudflare Access");
    expect(text).toContain(
      "Cloudflare Access answered, so Appflare can't check the app itself. Open the app and sign in to check it.",
    );
    expect(text).not.toContain("Not verified yet");
    expect(text).not.toContain("did not answer");
  });

  it("keeps its own words for an app that did not answer", () => {
    const text = show("unverified", false);
    expect(text).toContain("Not verified yet");
    expect(text).toContain(
      "The last health check could not reach the app. Open the app to check it.",
    );
    // Not every check follows a route going live (a settings change, Check now).
    expect(text).not.toContain("going live");
    expect(text).not.toContain("Cloudflare Access");
  });

  it("ignores a flag left from before when the status says the app answered", () => {
    const text = show("verified", true);
    expect(text).toContain("Verified");
    expect(text).not.toContain("Cloudflare Access");
  });

  it("reloads the install after Check now, which carries the recorded Access answer", async () => {
    show("verified", false);
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Check now"),
    );
    await act(async () => button?.click());
    expect(check).toHaveBeenCalledWith({ data: { installId: "i1" } });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(show("unverified", true)).toContain("Behind Cloudflare Access");
  });
});
