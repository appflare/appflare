import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressOptions, MoveAddressResult } from "../domains/manager-address.functions";
import type { JobView } from "../jobs/jobs.functions";

/**
 * Setup's "Where should Appflare live?" step, with the move call and its
 * job standing in: nothing here touches an account.
 */
const calls = vi.hoisted(() => ({
  moveManagerAddress: vi.fn(),
  changeManagerAddress: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock("../domains/manager-address.functions", () => ({
  moveManagerAddress: calls.moveManagerAddress,
  changeManagerAddress: calls.changeManagerAddress,
}));
vi.mock("../jobs/jobs.functions", () => ({ getJob: calls.getJob }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { AddressSkippedNote, AddressStep } = await import("./address-step");
const { MoveProgress } = await import("../components/manager-address-move");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = "appflare.example.com";
const OPTIONS: AddressOptions = {
  zones: [{ id: "z1", name: "example.com", suggestedHostname: HOST }],
  inactiveZones: [],
  missing: [],
  noZones: false,
};
const RESUME = "/setup?checklist=true&address=true";
const SIGN_IN = `https://${HOST}/login?returnTo=%2Fsetup%3Fchecklist%3Dtrue&moved=1`;
const JOB = "01MOVEJOB00000000000000001";
const STARTED = { ok: true, hostname: HOST, jobId: JOB, url: SIGN_IN } satisfies MoveAddressResult;

function moveJob(status: JobView["status"], messages: string[], error: string | null = null) {
  return {
    id: JOB,
    kind: "move_address",
    restore: false,
    deleteRetained: false,
    status,
    error,
    workerVersionId: null,
    targetVersion: null,
    startedBy: "admin",
    startedAt: "2026-09-28T12:00:00.000Z",
    finishedAt: null,
    reportedAt: null,
    install: null,
    logs: messages.map((message, i) => ({
      id: i + 1,
      ts: "2026-09-28T12:00:00.000Z",
      level: "info",
      message,
      requests: [],
      detail: null,
    })),
    logsAfter: null,
    sourceBuild: null,
    addressMove: { hostname: HOST, zoneId: "z1", url: SIGN_IN },
    build: null,
  } satisfies JobView;
}

let container: HTMLDivElement;
let root: Root;
const onDone = vi.fn();
const go = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const call of Object.values(calls)) call.mockReset();
  onDone.mockReset();
  go.mockReset();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function show(options: AddressOptions = OPTIONS) {
  act(() =>
    root.render(
      <AddressStep
        options={options}
        accountId={ACCOUNT}
        returnTo={RESUME}
        onDone={onDone}
        go={go}
      />,
    ),
  );
}

function page(): string {
  return document.body.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

function choice(value: "keep" | "domain"): HTMLElement {
  const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) =>
    r.closest("label")?.textContent?.includes(value === "keep" ? "Keep" : "Use a domain"),
  );
  if (radio === undefined) throw new Error(`no ${value} choice`);
  return radio;
}

describe("the address step", () => {
  it("keeps the workers.dev address by default, showing where Appflare is now", async () => {
    show();
    expect(page()).toContain("Keep the workers.dev address");
    expect(page()).toContain(`Appflare stays at ${window.location.host}.`);
    expect(choice("keep").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('input[aria-label="Subdomain"]')).toBeNull();
    await click(button("Continue"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();
  });

  it("goes on with Later, whatever is chosen", async () => {
    show();
    await click(choice("domain"));
    await click(button("Later"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();
  });

  it("follows the move's job, then opens the sign-in page there, which resumes setup", async () => {
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(moveJob("running", [`Moving Appflare to ${HOST}.`]));
    show();
    await click(choice("domain"));
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]');
    expect(field?.value).toBe("appflare");
    await click(button("Continue"));
    expect(calls.moveManagerAddress).toHaveBeenCalledWith({
      data: { zoneId: "z1", hostname: HOST, returnTo: RESUME },
    });
    await settle();
    expect(page()).toContain(`Moving Appflare to ${HOST}`);
    expect(page()).toContain("You can close this page; the move continues.");
    expect([...document.querySelectorAll("li[data-level]")].map((li) => li.textContent)).toEqual([
      `Moving Appflare to ${HOST}.`,
    ]);
    expect(go).not.toHaveBeenCalled();

    calls.getJob.mockResolvedValue(moveJob("succeeded", [`Moving Appflare to ${HOST}.`]));
    await act(async () => vi.advanceTimersByTime(2000));
    await settle();
    expect(go).toHaveBeenCalledWith(SIGN_IN);
    expect(onDone).not.toHaveBeenCalled();
    expect(page()).toContain(`Appflare moved to ${HOST}`);
  });

  it("shows the job's words and Try again when the move did not complete", async () => {
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(
      moveJob("failed", [], `${HOST} never answered as this Appflare within 15 minutes.`),
    );
    show();
    await click(choice("domain"));
    await click(button("Continue"));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      `${HOST} never answered as this Appflare within 15 minutes.`,
    );
    expect(button("Try again").disabled).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it("shows the server's words when the move cannot start", async () => {
    calls.moveManagerAddress.mockRejectedValue(
      new Error("The Cloudflare token cannot list zones."),
    );
    show();
    await click(choice("domain"));
    await click(button("Continue"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The Cloudflare token cannot list zones.",
    );
    expect(calls.getJob).not.toHaveBeenCalled();
  });
});

describe("the address step's other lines", () => {
  it("links to a new token in the account Appflare runs in when permissions are missing", async () => {
    show({ ...OPTIONS, missing: ["DNS: Edit"] });
    await click(choice("domain"));
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Create a new token",
    );
    expect(link?.getAttribute("href")).toContain(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/api-tokens`,
    );
  });

  it("says in one line why the step was skipped when the domains could not be read", () => {
    act(() => root.render(<AddressSkippedNote />));
    expect(container.textContent).toBe(
      "Could not read your domains; you can set Appflare's address later in Domains settings.",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/settings/domains#address");
  });
});

describe("the move's progress", () => {
  it("links to the job, and says the move goes on without the page", () => {
    act(() => root.render(<MoveProgress hostname={HOST} jobId={JOB} />));
    const open = [...document.querySelectorAll("a")].find((a) => a.textContent === "Open the job");
    expect(open?.getAttribute("href")).toBe(`/jobs/${JOB}`);
    expect(page()).toContain("You can close this page; the move continues.");
  });

  it("says what the request does before the job exists", () => {
    act(() => root.render(<MoveProgress hostname={HOST} jobId={null} />));
    expect(page()).toContain("Checking the name and attaching the domain…");
    expect(page()).not.toContain("You can close this page");
    expect(document.querySelector("a")).toBeNull();
  });

  it("says only where Appflare moved once it has", () => {
    act(() => root.render(<MoveProgress hostname={HOST} jobId={null} done />));
    expect(page()).toBe(`Appflare moved to ${HOST}`);
  });
});
