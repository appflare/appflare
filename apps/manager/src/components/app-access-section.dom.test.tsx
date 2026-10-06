import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAccessCheck, InstallAccessView } from "../access/app-access";
import type { InstallDetail } from "../installs/installs.functions";

/**
 * The app page's "Cloudflare Access" card. Its server functions only exist
 * under the Start Vite plugin; they and the job page navigation are stubbed.
 */
const server = vi.hoisted(() => ({
  checkAppAccess: vi.fn<() => Promise<AppAccessCheck>>(),
  startAccessChange: vi.fn(async (_: unknown) => ({ jobId: "job-access" })),
  makePublicPaths: vi.fn(async (_: unknown) => ({
    problem: null,
    accepted: ["/s/*", "/x/*"],
    pending: [] as string[],
  })),
  invalidate: vi.fn(async () => {}),
  jobStarted: vi.fn(async (_jobId: string, _title: string) => {}),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => server.jobStarted }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/access-change.functions", () => ({
  checkAppAccess: server.checkAppAccess,
  startAccessChange: server.startAccessChange,
  makePublicPaths: server.makePublicPaths,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: server.invalidate }) }));

const { AppAccessSection } = await import("./app-access-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL = {
  id: "install-links",
  name: "Links",
  label: "Links",
  workerName: "links",
  status: "installed",
  activeJobId: null,
} as InstallDetail;

const PROTECTED: InstallAccessView = {
  offer: "offered",
  protected: true,
  appName: "Appflare: Links (links)",
  teamDomain: "example.cloudflareaccess.com",
  publicPaths: [],
  pendingPublicPaths: [],
  syncFailedAt: null,
  usesAccessValues: false,
  users: 3,
  repair: null,
};

const OFF: InstallAccessView = {
  ...PROTECTED,
  protected: false,
  appName: null,
  teamDomain: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.checkAppAccess.mockReset();
  server.checkAppAccess.mockResolvedValue({
    problem: null,
    users: 3,
    loginMethods: ["One-time PIN (a code sent by email)"],
    oneTimePin: true,
  });
  server.startAccessChange.mockClear();
  server.jobStarted.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(
  access: InstallAccessView,
  { isAdmin = true, install = INSTALL }: { isAdmin?: boolean; install?: InstallDetail } = {},
) {
  await act(async () =>
    root.render(<AppAccessSection install={install} access={access} isAdmin={isAdmin} />),
  );
  return container.textContent ?? "";
}

/** The whole page, dialogs included (they render outside the card). */
function page(): string {
  return document.body.textContent ?? "";
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function click(el: HTMLElement | undefined) {
  if (el === undefined) throw new Error("nothing to click");
  await act(async () => el.click());
}

describe("AppAccessSection", () => {
  it("shows a protected app: who gets in, public paths, and its Access application", async () => {
    const text = await show(PROTECTED);
    expect(text).toContain("Protected");
    expect(text).toContain("Appflare's users: 3 people, members included");
    expect(text).toContain("example.cloudflareaccess.com");
    expect(text).toContain("None; every path asks for a sign-in, links you share included");
    expect(text).toContain("Appflare: Links (links)");
    const open = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Open in Zero Trust"),
    );
    expect(open?.getAttribute("href")).toBe(
      "https://one.dash.cloudflare.com/?to=/0123456789abcdef0123456789abcdef/access/apps",
    );
    expect(button("Turn off")).toBeDefined();
    // Nothing to repair: no Protect again.
    expect(button("Protect again")).toBeUndefined();
    expect(button("Protect with Cloudflare Access")).toBeUndefined();
    expect(text).not.toContain("Zero Trust Free covers");
  });

  it("lists the paths that stay public", async () => {
    const text = await show({ ...PROTECTED, publicPaths: ["/s/*", "/api/webhook"] });
    expect(text).toContain("/s/*, /api/webhook");
  });

  it("says a failed sync is retried and the addresses stay protected, and offers to try now", async () => {
    const text = await show({
      ...PROTECTED,
      syncFailedAt: "2026-10-01T10:00:00.000Z",
      repair: "sync-failed",
    });
    expect(text).toContain("Appflare tries again every 30 minutes");
    expect(text).toContain("the app's addresses stay protected meanwhile");
    expect(text).toContain("Protecting it again brings its Access applications in step now.");
    expect(button("Protect again")).toBeDefined();
  });

  it("says why a replaced users policy keeps everyone out, next to Protect again", async () => {
    const text = await show({ ...PROTECTED, repair: "users-policy-replaced" });
    expect(text).toContain("This app still names the old one, so nobody can sign in");
    expect(button("Protect again")).toBeDefined();
  });

  it("offers Protect again for a deleted Access application, also when protection is required", async () => {
    const text = await show({ ...PROTECTED, offer: "required", repair: "app-deleted" });
    expect(text).toContain(
      "The Access application was deleted in Cloudflare, so the app's addresses no longer ask for a sign-in. Protect it again.",
    );
    expect(button("Protect again")).toBeDefined();
    expect(button("Turn off")).toBeUndefined();
    await click(button("Protect again"));
    const confirm = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Protect again",
    );
    await click(confirm.at(-1));
    expect(server.startAccessChange).toHaveBeenCalledWith({
      data: { installId: "install-links", access: "on" },
    });
  });

  it("shows a member what to repair, without the action", async () => {
    const text = await show({ ...PROTECTED, repair: "incomplete" }, { isAdmin: false });
    expect(text).toContain("record of this app's Access application is incomplete");
    expect(button("Protect again")).toBeUndefined();
  });

  it("lists paths a catalog revision added, with Make public for admins only", async () => {
    const access = { ...PROTECTED, publicPaths: ["/s/*"], pendingPublicPaths: ["/x/*"] };
    const member = await show(access, { isAdmin: false });
    expect(member).toContain("The catalog now lists /x/* as public.");
    expect(button("Make public")).toBeUndefined();
    const text = await show(access);
    expect(text).toContain("The catalog now lists /x/* as public.");
    await click(button("Make public"));
    expect(page()).toContain("Anyone can then reach this path of Links without signing in");
    const confirm = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Make public",
    );
    await click(confirm.at(-1));
    expect(server.makePublicPaths).toHaveBeenCalledWith({
      data: { installId: "install-links", paths: ["/x/*"] },
    });
    expect(server.invalidate).toHaveBeenCalled();
  });

  it("warns when the catalog now requires protection of an unprotected app, with Turn on for admins", async () => {
    const access = { ...OFF, offer: "required" as const };
    const member = await show(access, { isAdmin: false });
    expect(member).toContain("The catalog now says this app must run behind Cloudflare Access");
    expect(button("Turn on")).toBeUndefined();
    const text = await show(access);
    expect(text).toContain("The catalog now says this app must run behind Cloudflare Access");
    expect(text).toContain("Appflare never protects it on its own");
    expect(button("Turn on")).toBeDefined();
  });

  it("offers no way off for an app whose entry requires protection", async () => {
    const text = await show({ ...PROTECTED, offer: "required", repair: "users-policy-missing" });
    expect(button("Turn off")).toBeUndefined();
    expect(button("Protect again")).toBeDefined();
    expect(text).toContain("It cannot be turned off.");
    expect(text).toContain("Links's catalog entry requires it");
  });

  it("shows a member the state without actions", async () => {
    const text = await show(PROTECTED, { isAdmin: false });
    expect(text).toContain("Protected");
    expect(text).toContain("Only admins can change this.");
    expect(button("Turn off")).toBeUndefined();
    expect(button("Protect again")).toBeUndefined();
  });

  it("waits for another job of the app, with a link to it", async () => {
    const text = await show(OFF, { install: { ...INSTALL, activeJobId: "job-running" } });
    expect(button("Protect with Cloudflare Access")).toBeUndefined();
    expect(text).toContain("Another job of this app is running");
    const log = [...container.querySelectorAll("a")].find((a) => a.textContent === "View its log");
    expect(log?.getAttribute("href")).toBe("/jobs/job-running");
  });

  it("adds one quiet line only above Zero Trust Free's 50 users", async () => {
    expect(await show({ ...PROTECTED, users: 50 })).not.toContain("Zero Trust Free covers");
    expect(await show({ ...PROTECTED, users: 64 })).toContain(
      "Zero Trust Free covers up to 50 users; Appflare has 64.",
    );
  });

  it("turns protection on after a check and a confirmation, and opens the job", async () => {
    const text = await show({ ...OFF, usesAccessValues: true });
    expect(text).toContain("Off");
    expect(text).toContain("anyone with the app's address reaches it");
    await click(button("Protect with Cloudflare Access"));
    expect(server.checkAppAccess).toHaveBeenCalledTimes(1);
    expect(page()).toContain("its workers.dev address, its version previews and its domains");
    expect(page()).toContain("so Appflare deploys it again with them");
    expect(page()).toContain("Only Appflare's users get in: 3 people, members included.");
    expect(page()).toContain("Login methods: One-time PIN (a code sent by email).");
    await click(button("Turn on"));
    expect(server.startAccessChange).toHaveBeenCalledWith({
      data: { installId: "install-links", access: "on" },
    });
    expect(server.jobStarted).toHaveBeenCalledWith(
      "job-access",
      "Cloudflare Access change started",
    );
  });

  it("does not turn on while the account cannot protect apps, and says where to fix it", async () => {
    server.checkAppAccess.mockResolvedValue({
      problem: {
        kind: "no-organization",
        message: "This Cloudflare account has no Zero Trust organization yet.",
      },
      users: 3,
      loginMethods: null,
      oneTimePin: false,
    });
    await show(OFF);
    await click(button("Protect with Cloudflare Access"));
    expect(page()).toContain("This account cannot protect apps yet");
    const fix = [...document.body.querySelectorAll("a")].find(
      (a) => a.textContent === "Zero Trust in Your account",
    );
    expect(fix?.getAttribute("href")).toBe("/settings/account#capability-zero-trust");
    expect(
      button("Turn on")?.disabled || button("Turn on")?.getAttribute("aria-disabled"),
    ).toBeTruthy();
    await click(button("Turn on"));
    expect(server.startAccessChange).not.toHaveBeenCalled();
  });

  it("turns protection off after saying the app becomes reachable by anyone", async () => {
    await show({ ...PROTECTED, usesAccessValues: true });
    await click(button("Turn off"));
    expect(page()).toContain(
      "Anyone with the app's address can then reach it, unless the app has a sign-in of its own.",
    );
    expect(page()).toContain("so Appflare first deploys it again without them");
    const confirm = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Turn off",
    );
    await click(confirm.at(-1));
    expect(server.startAccessChange).toHaveBeenCalledWith({
      data: { installId: "install-links", access: "off" },
    });
    expect(server.jobStarted).toHaveBeenCalledWith(
      "job-access",
      "Cloudflare Access change started",
    );
  });

  it("protects an app again to repair it", async () => {
    await show({ ...PROTECTED, repair: "users-policy-replaced" });
    await click(button("Protect again"));
    expect(page()).toContain("makes it again if it no longer exists");
    const confirm = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Protect again",
    );
    await click(confirm.at(-1));
    expect(server.startAccessChange).toHaveBeenCalledWith({
      data: { installId: "install-links", access: "on" },
    });
  });

  it("lets the change start when the check itself could not run", async () => {
    server.checkAppAccess.mockRejectedValue(new Error("Cloudflare could not be reached."));
    await show(OFF);
    await click(button("Protect with Cloudflare Access"));
    expect(page()).toContain(
      "Cloudflare could not be reached. Appflare checks again when the change starts.",
    );
    await click(button("Turn on"));
    expect(server.startAccessChange).toHaveBeenCalledTimes(1);
  });
});
