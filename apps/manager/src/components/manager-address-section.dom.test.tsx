import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AddressOptions,
  ManagerAddress,
  MoveAddressResult,
  RevertResult,
} from "../domains/manager-address.functions";
import type { JobView } from "../jobs/jobs.functions";

/**
 * Settings, Domains, "Appflare's address", with the server functions
 * standing in: nothing here touches an account.
 */
const calls = vi.hoisted(() => ({
  getManagerAddress: vi.fn(),
  getManagerAddressOptions: vi.fn(),
  moveManagerAddress: vi.fn(),
  changeManagerAddress: vi.fn(),
  revertManagerAddress: vi.fn(),
  retryPendingMove: vi.fn(),
  stayAtWorkersDev: vi.fn(),
  getJob: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../domains/manager-address.functions", () => ({
  getManagerAddress: calls.getManagerAddress,
  getManagerAddressOptions: calls.getManagerAddressOptions,
  moveManagerAddress: calls.moveManagerAddress,
  changeManagerAddress: calls.changeManagerAddress,
  revertManagerAddress: calls.revertManagerAddress,
  retryPendingMove: calls.retryPendingMove,
  stayAtWorkersDev: calls.stayAtWorkersDev,
}));
vi.mock("../jobs/jobs.functions", () => ({ getJob: calls.getJob }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: calls.invalidate, navigate: async () => {} }),
}));

const { ManagerAddressSection } = await import("./manager-address-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WORKERS_DEV = "appflare.ada.workers.dev";
const HOST = "appflare.example.com";
const SIGN_IN = `https://${HOST}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`;
const JOB = "01MOVEJOB00000000000000001";

const AT_WORKERS_DEV: ManagerAddress = {
  hostname: null,
  zoneId: null,
  previousHostname: null,
  movedAt: null,
  workersDevHostname: WORKERS_DEV,
  serving: null,
  attachedByHand: [],
  movingJobId: null,
  movingTo: null,
};

const AT_DOMAIN: ManagerAddress = {
  hostname: HOST,
  zoneId: "z1",
  previousHostname: WORKERS_DEV,
  movedAt: "2026-09-20T10:00:00.000Z",
  workersDevHostname: WORKERS_DEV,
  serving: true,
  attachedByHand: [],
  movingJobId: null,
  movingTo: null,
};

const ONE_ZONE: AddressOptions = {
  zones: [{ id: "z1", name: "example.com", suggestedHostname: HOST }],
  inactiveZones: [],
  missing: [],
  noZones: false,
};

const NO_ZONES: AddressOptions = {
  zones: [],
  inactiveZones: [],
  missing: ["Zone: Read", "DNS: Edit", "Workers Routes: Edit"],
  noZones: true,
};

const STARTED = { ok: true, hostname: HOST, jobId: JOB, url: SIGN_IN } satisfies MoveAddressResult;

/** The move's job as `getJob` answers it. */
function moveJob(
  status: JobView["status"],
  messages: string[],
  over: Partial<JobView> = {},
): JobView {
  return {
    id: JOB,
    kind: "move_address",
    restore: false,
    deleteRetained: false,
    status,
    error: null,
    workerVersionId: null,
    targetVersion: null,
    startedBy: "admin",
    startedAt: "2026-09-28T12:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-09-28T12:03:00.000Z",
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
    ...over,
  };
}

const WAITING = [
  `Moving Appflare to ${HOST}.`,
  `Waiting for the certificate and the new address: https://${HOST}/api/health must answer as Appflare 1.4.0.`,
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const call of Object.values(calls)) call.mockReset();
  calls.getManagerAddressOptions.mockResolvedValue(ONE_ZONE);
  // Only the job's polling interval is faked; the rest of the page runs on real timers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function show(address: ManagerAddress, options: AddressOptions = ONE_ZONE) {
  act(() => root.render(<ManagerAddressSection view={{ address, options, accountId: ACCOUNT }} />));
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

function hasButton(label: string): boolean {
  return [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);
}

function subdomainField(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]');
  if (input === null) throw new Error("no subdomain field");
  return input;
}

function logLines(): string[] {
  return [...document.querySelectorAll("li[data-level]")].map((li) => li.textContent ?? "");
}

/** Whether leaving the page now would make the browser ask first. */
function leaveIsQuestioned(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

/** The next poll of the job (every 2 seconds while it runs). */
async function nextPoll() {
  await act(async () => vi.advanceTimersByTime(2000));
  await settle();
}

function movedNotice(): Element | undefined {
  return [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent?.includes(`Appflare now lives at ${HOST}`),
  );
}

describe("the domain the install chose, while Appflare waits to move there", () => {
  it("says so in one line, with Stay at workers.dev", async () => {
    show({ ...AT_WORKERS_DEV, pending: { hostname: HOST, failedAt: null, failure: null } });
    expect(page()).toContain("Appflare moves here once it is ready.");
    expect(hasButton("Try again")).toBe(false);
    calls.stayAtWorkersDev.mockResolvedValue(undefined);
    await click(button("Stay at workers.dev"));
    expect(calls.stayAtWorkersDev).toHaveBeenCalledOnce();
    expect(calls.invalidate).toHaveBeenCalled();
  });

  it("after a failed move: one line, why under Details, Try again once and Stay", async () => {
    show({
      ...AT_WORKERS_DEV,
      pending: {
        hostname: HOST,
        failedAt: "2026-09-28T12:20:00.000Z",
        failure: "Moving Cloudflare Access: refused.",
      },
    });
    expect(page()).toContain(`Couldn't move to ${HOST}.`);
    expect(page()).not.toContain("Moving Cloudflare Access: refused.");
    await click(button("Details"));
    expect(page()).toContain("Moving Cloudflare Access: refused.");
    expect(hasButton("Stay at workers.dev")).toBe(true);
    calls.retryPendingMove.mockResolvedValue(STARTED);
    await click(button("Try again"));
    expect(calls.retryPendingMove).toHaveBeenCalledOnce();
    expect(calls.invalidate).toHaveBeenCalled();
  });
});

describe("Appflare's address at workers.dev", () => {
  it("shows the workers.dev address with Open and Use a domain", () => {
    show(AT_WORKERS_DEV);
    const section = document.querySelector("section#address");
    expect(section?.textContent).toContain("Appflare's address");
    expect(page()).toContain(WORKERS_DEV);
    expect(page()).toContain("Appflare lives at its workers.dev address.");
    const open = [...document.querySelectorAll("a")].find((a) => a.textContent === "Open");
    expect(open?.getAttribute("href")).toBe(`https://${WORKERS_DEV}`);
    expect(hasButton("Use a domain")).toBe(true);
    expect(hasButton("Go back to workers.dev")).toBe(false);
  });

  it("moves to the suggested host of the only zone, asking before it replaces DNS records", async () => {
    calls.moveManagerAddress
      .mockResolvedValueOnce({
        ok: false,
        reason: "dns-conflict",
        hostname: HOST,
        records: [{ type: "A", content: "192.0.2.1" }],
      } satisfies MoveAddressResult)
      .mockResolvedValueOnce(STARTED);
    calls.getJob.mockResolvedValue(moveJob("succeeded", WAITING));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    // The only zone is chosen, and the host starts as appflare.<zone>.
    expect(subdomainField().value).toBe("appflare");
    expect(page()).toContain("Appflare answers at https://appflare.example.com.");

    await click(button("Move Appflare"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z1", hostname: HOST },
    });
    expect(page()).toContain("appflare.example.com already has DNS records");
    expect(page()).toContain("A 192.0.2.1");
    expect(page()).toContain("Cloudflare deletes them, and Appflare cannot put them back");
    expect(button("Replace records and move").disabled).toBe(true);
    // The box is described by the warning above it.
    const box = document.querySelector('[role="checkbox"]');
    const warning = document.getElementById(box?.getAttribute("aria-describedby") ?? "");
    expect(warning?.textContent).toContain("Appflare cannot put them back");

    // Base UI's checkbox follows its (hidden) native input.
    const replace = document.querySelector<HTMLInputElement>('label input[type="checkbox"]');
    if (replace === null) throw new Error("no replace checkbox");
    await click(replace);
    expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    await click(button("Replace records and move"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z1", hostname: HOST, overrideExistingDnsRecord: true },
    });
    expect(calls.getJob).toHaveBeenCalledWith({ data: { jobId: JOB } });
    await settle();
    // Once the job has succeeded, a dialog that cannot be dismissed says where
    // Appflare lives now, and links to its sign-in page.
    const notice = movedNotice();
    expect(notice?.textContent).toContain("Sign in again there.");
    expect(notice?.textContent).toContain(
      "Passkeys added at the old address work only there; add new ones in Users and sign-in.",
    );
    expect(notice?.textContent).not.toContain("Move Appflare");
    const go = [...(notice?.querySelectorAll("a") ?? [])].find((a) =>
      a.textContent?.includes(`Go to ${HOST}`),
    );
    expect(go?.getAttribute("href")).toBe(SIGN_IN);
    expect(document.activeElement).toBe(go);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(page()).toContain(`Appflare now lives at ${HOST}`);
  });

  it("shows the job's lines while it runs, lets the page close, and opens the notice when it succeeds", async () => {
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(moveJob("running", WAITING));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    expect(page()).toContain(`Moving Appflare to ${HOST}`);
    expect(page()).toContain("You can close this page; the move continues.");
    expect(logLines()).toEqual(WAITING);
    const open = [...document.querySelectorAll("a")].find((a) => a.textContent === "Open the job");
    expect(open?.getAttribute("href")).toBe(`/jobs/${JOB}`);
    // The dialog stays up while the job runs...
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(page()).toContain(`Moving Appflare to ${HOST}`);
    // ...but leaving the page is never questioned: the job goes on without it.
    expect(leaveIsQuestioned()).toBe(false);

    const later = [
      ...WAITING,
      "Not answering yet; certificates can take a few minutes (last answer: HTTP 526, error code 526).",
    ];
    calls.getJob.mockResolvedValue(moveJob("running", later));
    await nextPoll();
    expect(logLines()).toEqual(later);
    expect(movedNotice()).toBeUndefined();

    calls.getJob.mockResolvedValue(
      moveJob("succeeded", [...later, `${HOST} answers as this Appflare.`]),
    );
    await nextPoll();
    await settle();
    expect(movedNotice()?.textContent).toContain(`Go to ${HOST}`);
    // Nothing at this address is read again: it has nothing more to show.
    expect(calls.invalidate).not.toHaveBeenCalled();
  });

  it("shows the job's message and Try again when the move fails", async () => {
    const message = `${HOST} never answered as this Appflare within 15 minutes (last answer: HTTP 526, error code 526), so Appflare stays at its current address.`;
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(moveJob("failed", WAITING, { error: message }));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(subdomainField().value).toBe("appflare");
    expect(hasButton("Try again")).toBe(true);
    expect(movedNotice()).toBeUndefined();
  });

  it("shows the server's words when the move cannot start, with Try again", async () => {
    const message = `Appflare is moving to other.example.com (job 01X). Wait for it to finish, then try again.`;
    calls.moveManagerAddress.mockRejectedValueOnce(new Error(message));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(hasButton("Try again")).toBe(true);
    expect(calls.getJob).not.toHaveBeenCalled();
  });

  it("reopens on the progress of a move that was running when the page loaded", async () => {
    calls.getJob.mockResolvedValue(moveJob("running", WAITING));
    show({ ...AT_WORKERS_DEV, movingJobId: JOB, movingTo: { hostname: HOST, zoneId: "z1" } });
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(`Moving Appflare to ${HOST}`);
    expect(logLines()).toEqual(WAITING);
    expect(calls.getJob).toHaveBeenCalledWith({ data: { jobId: JOB } });
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();

    calls.getJob.mockResolvedValue(moveJob("succeeded", WAITING));
    await nextPoll();
    await settle();
    expect(movedNotice()?.querySelector("a")?.getAttribute("href")).toBe(SIGN_IN);
  });

  it("offers the job's domain again when a reopened move fails", async () => {
    calls.getJob.mockResolvedValue(moveJob("failed", WAITING, { error: "It stopped." }));
    show({ ...AT_WORKERS_DEV, movingJobId: JOB, movingTo: { hostname: HOST, zoneId: "z1" } });
    await settle();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("It stopped.");
    expect(subdomainField().value).toBe("appflare");
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(moveJob("running", WAITING));
    await click(button("Try again"));
    expect(calls.moveManagerAddress).toHaveBeenCalledWith({
      data: { zoneId: "z1", hostname: HOST },
    });
  });

  it("takes an Access refusal once the job was seen waiting as the switch", async () => {
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(moveJob("running", WAITING));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    // Access now protects the new address, so this one refuses every call.
    calls.getJob.mockRejectedValue(new Error(JSON.stringify({ code: "access_denied" })));
    await nextPoll();
    await settle();
    expect(movedNotice()?.querySelector("a")?.getAttribute("href")).toBe(SIGN_IN);
  });

  it("keeps following refusals before the wait began, and suggests a reload after a few", async () => {
    const started = [`Moving Appflare to ${HOST}.`];
    calls.moveManagerAddress.mockResolvedValue(STARTED);
    calls.getJob.mockResolvedValue(moveJob("running", started));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    calls.getJob.mockRejectedValue(new Error(JSON.stringify({ code: "access_denied" })));
    await nextPoll();
    await nextPoll();
    expect(movedNotice()).toBeUndefined();
    expect(hasButton("Reload")).toBe(false);
    await nextPoll();
    expect(movedNotice()).toBeUndefined();
    expect(page()).toContain(`Moving Appflare to ${HOST}`);
    expect(page()).toContain("Cloudflare Access refused the last few checks of the move");
    expect(hasButton("Reload")).toBe(true);
    // A poll that answers again takes the hint away.
    calls.getJob.mockResolvedValue(moveJob("running", [...started, WAITING[1] ?? ""]));
    await nextPoll();
    expect(hasButton("Reload")).toBe(false);
  });

  it("uses the zone's root when the host is left empty", async () => {
    calls.moveManagerAddress.mockResolvedValue({ ...STARTED, hostname: "example.com" });
    calls.getJob.mockResolvedValue(moveJob("running", []));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await act(async () => {
      const input = subdomainField();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Move Appflare"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z1", hostname: "example.com" },
    });
  });

  it("offers a domain attached by hand as the address", async () => {
    calls.moveManagerAddress.mockResolvedValue({ ...STARTED, hostname: "manage.beta.dev" });
    calls.getJob.mockResolvedValue(moveJob("running", []));
    show({
      ...AT_WORKERS_DEV,
      attachedByHand: [
        { hostname: "manage.beta.dev", zoneId: "z2", zoneName: "beta.dev", leftByMove: false },
      ],
    });
    expect(page()).toContain("A domain already points at Appflare: manage.beta.dev");
    expect(page()).toContain("It was attached to Appflare's Worker in the Cloudflare dashboard.");
    await click(button("Use it as Appflare's address"));
    // The hand-attached domain's zone is offered even though the options lack it.
    expect(subdomainField().value).toBe("manage");
    await click(button("Move Appflare"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z2", hostname: "manage.beta.dev" },
    });
  });

  it("says when an earlier move left a domain attached", () => {
    show({
      ...AT_WORKERS_DEV,
      attachedByHand: [{ hostname: HOST, zoneId: "z1", zoneName: "example.com", leftByMove: true }],
    });
    expect(page()).toContain(
      "An earlier move of Appflare attached it and did not finish. Use it to start the move again.",
    );
  });

  it("says quietly how to get a domain when the account has none", () => {
    show(AT_WORKERS_DEV, NO_ZONES);
    expect(page()).toContain(
      "Add a domain to your Cloudflare account to give Appflare its own address.",
    );
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Add a domain in Cloudflare",
    );
    expect(link?.getAttribute("href")).toBe(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/domains/overview`,
    );
    expect(hasButton("Use a domain")).toBe(false);
  });
});

describe("Appflare's address on a domain", () => {
  it("shows the domain with Open, Change and Go back to workers.dev", () => {
    show(AT_DOMAIN);
    expect(page()).toContain(HOST);
    expect(page()).toContain(`${WORKERS_DEV} sends page visits here.`);
    expect(hasButton("Change")).toBe(true);
    expect(hasButton("Go back to workers.dev")).toBe(true);
    expect(hasButton("Use a domain")).toBe(false);
  });

  it("changes to another host with the change call", async () => {
    calls.changeManagerAddress.mockResolvedValue({ ...STARTED, hostname: "app.example.com" });
    calls.getJob.mockResolvedValue(moveJob("running", []));
    show(AT_DOMAIN);
    await click(button("Change"));
    await act(async () => {
      const input = subdomainField();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "app");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Change address"));
    expect(calls.changeManagerAddress).toHaveBeenCalledWith({
      data: { zoneId: "z1", hostname: "app.example.com" },
    });
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();
  });

  it("goes back to workers.dev after explaining what stops, then offers the sign-in there", async () => {
    calls.revertManagerAddress.mockResolvedValue({
      wasMoved: true,
      url: `https://${WORKERS_DEV}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`,
      previousDomain: "detached",
    } as RevertResult);
    show(AT_DOMAIN);
    await click(button("Go back to workers.dev"));
    expect(page()).toContain("stops sending visits to appflare.example.com");
    expect(page()).toContain("Passkeys added at appflare.example.com work only there");
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent?.trim() === "Go back to workers.dev",
    );
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("no confirm button");
    await click(confirm);
    expect(calls.revertManagerAddress).toHaveBeenCalledWith({ data: {} });
    expect(page()).toContain(`Appflare now lives at ${WORKERS_DEV}`);
  });

  it("warns when Cloudflare no longer lists the domain", () => {
    show({ ...AT_DOMAIN, serving: false });
    expect(page()).toContain("appflare.example.com no longer points at Appflare");
  });
});
