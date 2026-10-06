import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceBuildView } from "../installs/source-builds.functions";

/**
 * Throwing a build away from its review. The route runs under the router
 * and loads through server functions, which only exist under the Start Vite
 * plugin; the build is given here instead.
 */
const loader = vi.hoisted(() => ({ current: null as unknown }));
const calls = vi.hoisted(() => ({ discardSourceBuild: vi.fn(), invalidate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useLoaderData: () => loader.current,
    useRouteContext: () => ({ viewer: { id: "u1", role: "admin" } }),
  }),
  useRouter: () => ({ invalidate: calls.invalidate, subscribe: () => () => {} }),
  useNavigate: () => async () => {},
  getRouteApi: () => ({
    useRouteContext: (opts?: { select?: (c: { accountId: string }) => unknown }) =>
      opts?.select ? opts.select({ accountId: "acc" }) : { accountId: "acc" },
  }),
}));
vi.mock("../installs/source-builds.functions", () => ({
  getSourceBuild: vi.fn(),
  discardSourceBuild: calls.discardSourceBuild,
  installSourceBuild: vi.fn(),
  updateFromSourceBuild: vi.fn(),
  buildForInstallAgain: vi.fn(),
}));
vi.mock("../installs/install-again.functions", () => ({ getInstallAgain: vi.fn() }));
vi.mock("../installs/installs.functions", () => ({ startInstall: vi.fn() }));
vi.mock("../installs/versions.functions", () => ({ startUpdate: vi.fn() }));
vi.mock("../installs/access-change.functions", () => ({ checkAppAccess: vi.fn() }));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));
vi.mock("../installs/custom-domains.functions", () => ({ getDomainOptions: vi.fn() }));
vi.mock("../installs/external-domains.functions", () => ({ getExternalDomainOptions: vi.fn() }));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: vi.fn(),
  previewEmailRoutingInput: vi.fn(),
  previewEmailRouting: vi.fn(),
}));

const { Route } = await import("../routes/_app/catalog/source.$buildId");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A build from a repository that failed: its review is the failure and "Throw away". */
const FAILED: SourceBuildView = {
  id: "b1",
  status: "failed",
  error: "The build command exited with code 1.",
  purpose: "install",
  origin: "repository",
  repo: "ada/links",
  repoUrl: "https://github.com/ada/links",
  requestedRef: null,
  ref: "main",
  commit: null,
  version: null,
  image: null,
  builtAt: null,
  detected: null,
  app: null,
  install: null,
  review: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  loader.current = { build: FAILED, again: null };
  calls.discardSourceBuild.mockReset();
  calls.invalidate.mockReset();
  calls.invalidate.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const Page = Route.options.component as ComponentType;
  act(() => root.render(<Page />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function button(name: string, within: HTMLElement = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="alertdialog"]');
}

describe("throwing a build away", () => {
  it("asks first, and deletes nothing until confirmed", async () => {
    await click(button("Throw away", container));
    const open = dialog();
    expect(open?.textContent).toContain("Throw away this build");
    expect(open?.textContent).toContain(
      "Its log and any files it left in your sandbox Worker's bucket are deleted. Build again to try once more.",
    );
    expect(calls.discardSourceBuild).not.toHaveBeenCalled();

    await click(button("Cancel", open ?? document.body));
    expect(calls.discardSourceBuild).not.toHaveBeenCalled();
  });

  it("throws the build away once confirmed, and shows the page as it is then", async () => {
    calls.discardSourceBuild.mockResolvedValue(undefined);
    await click(button("Throw away", container));
    const open = dialog();
    if (open === null) throw new Error("no dialog");
    await click(button("Throw away", open));
    expect(calls.discardSourceBuild).toHaveBeenCalledWith({ data: { buildId: "b1" } });
    expect(calls.invalidate).toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when it fails", async () => {
    calls.discardSourceBuild.mockRejectedValue(new Error("The build is still in use."));
    await click(button("Throw away", container));
    const open = dialog();
    if (open === null) throw new Error("no dialog");
    await click(button("Throw away", open));
    expect(dialog()).not.toBeNull();
    const alert = open.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The build is still in use.");
    expect(calls.invalidate).not.toHaveBeenCalled();
  });
});
