import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildProgressView, JobView } from "../jobs/jobs.functions";

/**
 * The job page. The route runs under the router and loads through server
 * functions, which only exist under the Start Vite plugin; the job is given
 * here instead, and stays as given (no polling).
 */
const loader = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useLoaderData: () => loader.current,
    useParams: () => ({ jobId: "j1" }),
    useRouteContext: () => ({ viewer: { id: "u1", role: "admin" } }),
  }),
  useRouter: () => ({ invalidate: async () => {}, subscribe: () => () => {} }),
}));
vi.mock("../jobs/jobs.functions", () => ({ getJob: vi.fn() }));
vi.mock("../jobs/live-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobs/live-job")>()),
  useLiveJob: (_id: string, job: JobView) => job,
  useVersionSwitch: () => ({ switching: false }),
}));
vi.mock("../telemetry/telemetry.functions", () => ({
  previewJobReport: vi.fn(),
  sendJobReport: vi.fn(),
}));

const { Route } = await import("../routes/_app/jobs/$jobId");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB: JobView = {
  id: "j1",
  kind: "install",
  restore: false,
  deleteRetained: false,
  status: "running",
  error: null,
  workerVersionId: null,
  targetVersion: null,
  startedBy: "admin",
  startedAt: "2026-10-06T09:00:00.000Z",
  finishedAt: null,
  reportedAt: null,
  install: null,
  logs: [],
  logsAfter: null,
  sourceBuild: null,
  addressMove: null,
  build: null,
};

function build(lines: string[]): BuildProgressView {
  return { kind: "build", stage: "build", updatedAt: "2026-10-06T09:01:00.000Z", lines };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(job: JobView) {
  loader.current = job;
  const Page = Route.options.component as ComponentType;
  act(() => root.render(<Page />));
}

/** Gives the output box a layout: `height` of text in a box `client` tall. */
function layOut(box: HTMLElement, height: number, client = 100) {
  Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(box, "clientHeight", { configurable: true, get: () => client });
}

describe("the job page", () => {
  it("shows a build's output in a box a keyboard can scroll, following new lines", () => {
    render({ ...JOB, build: build(["Installing dependencies"]) });
    const box = container.querySelector<HTMLElement>('[role="group"][aria-label="Build output"]');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.tabIndex).toBe(0);
    expect(box.textContent).toBe("Installing dependencies");

    layOut(box, 1000);
    render({ ...JOB, build: build(["Installing dependencies", "Building", "Bundling"]) });
    expect(box.textContent).toBe("Installing dependencies\nBuilding\nBundling");
    expect(box.scrollTop).toBe(1000);
  });

  it("leaves the output where the admin scrolled up to", () => {
    render({ ...JOB, build: build(["one"]) });
    const box = container.querySelector<HTMLElement>('[role="group"][aria-label="Build output"]');
    if (box === null) throw new Error("no output box");
    layOut(box, 1000);
    box.scrollTop = 200;
    act(() => box.dispatchEvent(new Event("scroll")));
    render({ ...JOB, build: build(["one", "two"]) });
    expect(box.scrollTop).toBe(200);
  });

  it("announces a failure as an alert", () => {
    render({ ...JOB, status: "failed", error: "The Worker could not be uploaded." });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The job failed");
    expect(alert?.textContent).toContain("The Worker could not be uploaded.");
  });

  it("says when the log is empty", () => {
    render({ ...JOB, status: "succeeded", finishedAt: "2026-10-06T09:02:00.000Z" });
    expect(container.textContent).toContain("No log lines were written");
  });
});
