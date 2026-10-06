import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallAgainRecord, InstallAgainSource } from "../installs/install-again";

/**
 * "Install again" of an install from a repository whose build is gone: the
 * review says why and builds the same repository again once the cost is
 * confirmed, then opens that build's review for the same install. Server
 * functions and navigation are stubbed.
 */
const calls = vi.hoisted(() => ({
  buildForInstallAgain: vi.fn(async (_: unknown) => ({ jobId: "build-2" })),
  navigate: vi.fn(async (_: unknown) => {}),
}));
vi.mock("../installs/source-builds.functions", () => ({
  buildForInstallAgain: calls.buildForInstallAgain,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: calls.navigate }) }));

const { InstallAgainBuildGone } = await import("./install-again-build-gone");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record: InstallAgainRecord = {
  installId: "old-install",
  appKey: "repository:me/links",
  label: "Team links",
  version: "0.0.0-20260920.0123456",
  workerName: "links",
  displayName: "Team links",
  vars: {},
  access: false,
  domain: null,
  emailZoneId: null,
  autoUpdate: "inherit",
  leftovers: [{ kind: "worker", name: "links" }],
  failedJobId: "job-1",
  refusal: null,
  origin: "repository",
  source: null,
};

const source = (build: InstallAgainSource["build"]): InstallAgainSource => ({
  origin: "repository",
  repo: "me/links",
  ref: "main",
  commit: "0123456789abcdef0123456789abcdef01234567",
  buildId: "build-1",
  build,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.buildForInstallAgain.mockClear();
  calls.navigate.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(build: InstallAgainSource["build"]) {
  act(() =>
    root.render(
      <Toasty>
        <InstallAgainBuildGone again={record} source={source(build)} appName="Links" />
      </Toasty>,
    ),
  );
}

const buildAgainButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Build again");

describe("InstallAgainBuildGone", () => {
  it("says the build is gone and builds the same repository again once the cost is confirmed", async () => {
    render({ state: "gone", cause: "missing", reason: "Its files are no longer there." });
    expect(container.textContent).toContain("The build Team links was installed from is gone");
    expect(container.textContent).toContain("Its files are no longer there.");
    expect(container.textContent).toContain("Builds me/links at main again");
    expect(buildAgainButton()?.disabled).toBe(true);

    // Base UI's checkbox follows its (hidden) native input.
    const cost = container.querySelector<HTMLInputElement>('label input[type="checkbox"]');
    if (cost === null) throw new Error("no cost checkbox");
    await act(async () => cost.click());
    expect(buildAgainButton()?.disabled).toBe(false);
    await act(async () => buildAgainButton()?.click());
    expect(calls.buildForInstallAgain).toHaveBeenCalledWith({
      data: { installId: "old-install", costConfirmed: true },
    });
    // The new build's review, for the same install.
    expect(calls.navigate).toHaveBeenCalledWith({
      to: "/catalog/source/$buildId",
      params: { buildId: "build-2" },
      search: { again: "old-install" },
    });
  });

  it("says sandbox builds are turned on first when they are off", () => {
    render({ state: "gone", cause: "no-sandbox", reason: "Sandbox builds are off." });
    expect(container.textContent).toContain("Sandbox builds are off.");
    expect(buildAgainButton()).toBeDefined();
  });

  it("offers no build when the sandbox Worker only did not answer", () => {
    render({ state: "unknown", reason: "Reload the page to try again." });
    expect(container.textContent).toContain(
      "could not check the build Team links was installed from",
    );
    expect(buildAgainButton()).toBeUndefined();
  });

  it("shows nothing while the build is there", () => {
    render({ state: "ready" });
    expect(container.textContent).toBe("");
  });
});
