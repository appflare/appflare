import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";
import type { InstallSettings } from "../installs/reconfigure.server";
import type { EmailAgainParts } from "../jobs/reconfigure/email-again";

/**
 * "Set up email again" in the Email group of an app's settings. Its server
 * functions only exist under the Start Vite plugin; they and the job page
 * navigation are stubbed.
 */
const server = vi.hoisted(() => ({
  startEmailAgain: vi.fn(async (_: unknown) => ({ jobId: "job-email" })),
  jobStarted: vi.fn(async (_jobId: string, _title: string) => {}),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => server.jobStarted }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/reconfigure.functions", () => ({
  startReconfigure: vi.fn(),
  startEmailAgain: server.startEmailAgain,
}));
vi.mock("./email-routing-fields", () => ({ EmailRoutingFields: () => null }));

const { AppSettingsSection } = await import("./app-settings-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL = {
  id: "install-mail",
  name: "Mailbox",
  label: "Mailbox",
  workerName: "mailbox",
  status: "installed",
  activeJobId: null,
  emailRoutes: [
    {
      id: "r1",
      kind: "rule",
      name: "inbox@example.com",
      label: "Mail to inbox@example.com goes to the Worker",
      onUninstall: "deleted",
    },
  ],
} as InstallDetail;

const LEFT_OUT: EmailAgainParts = {
  zoneId: "0123456789abcdef0123456789abcdef",
  zoneName: "example.com",
  addresses: ["support@example.com"],
  catchAll: true,
  remove: [{ kind: "rule", name: "old@example.com" }],
};

function settings(again: EmailAgainParts | null, leftover: string[] = []): InstallSettings {
  return {
    slug: "mailbox",
    kind: "artifact",
    unavailable: null,
    fields: [],
    placeholders: { workerName: "mailbox", workerUrl: null, appUrl: null, wildcardHostname: null },
    secrets: [],
    databases: [],
    canRemoveSecrets: true,
    email: {
      zoneId: LEFT_OUT.zoneId,
      zoneName: "example.com",
      leftover,
      again,
    },
    skipsPreview: null,
    installer: null,
    appToken: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.startEmailAgain.mockClear();
  server.jobStarted.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(
  again: EmailAgainParts | null,
  {
    isAdmin = true,
    install = INSTALL,
    leftover = [],
  }: { isAdmin?: boolean; install?: InstallDetail; leftover?: string[] } = {},
) {
  await act(async () =>
    root.render(
      <AppSettingsSection
        install={install}
        settings={settings(again, leftover)}
        isAdmin={isAdmin}
      />,
    ),
  );
  return container.textContent ?? "";
}

function buttons(text: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === text,
  );
}

async function click(el: HTMLElement | undefined) {
  if (el === undefined) throw new Error("nothing to click");
  await act(async () => el.click());
}

describe("Set up email again", () => {
  it("is not shown while the app's email is set up as its version asks", async () => {
    const text = await show(null);
    expect(text).toContain(
      "The app receives email for example.com through Cloudflare Email Routing.",
    );
    expect(text).not.toContain("Part of the app's email is not set up");
    expect(buttons("Set up email again")).toEqual([]);
  });

  it("says what was left out and, confirmed, starts the job with the parts it named", async () => {
    const text = await show(LEFT_OUT);
    expect(text).toContain("Part of the app's email is not set up");
    expect(text).toContain(
      "Mail to support@example.com is not routed to the app; the catch-all of example.com does not send mail to it; routes Appflare set up that the installed version no longer asks for are still there (the routing rule for old@example.com).",
    );
    await click(buttons("Set up email again")[0]);
    const dialog = document.body.querySelector("[data-email-again-parts]");
    expect([...(dialog?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
      'Route support@example.com to the Worker "mailbox".',
      'Send mail to every other address at example.com to the Worker "mailbox".',
      'Delete the routing rule for old@example.com, which Appflare set up and the installed version no longer asks for, if it still sends mail to the Worker "mailbox".',
    ]);
    expect(document.body.textContent).toContain(
      "If a routing rule or a catch-all it did not set up is in the way, it stops without changing anything",
    );
    await click(buttons("Set up email again").at(-1));
    expect(server.startEmailAgain).toHaveBeenCalledWith({
      data: { installId: "install-mail", parts: LEFT_OUT },
    });
    expect(server.jobStarted).toHaveBeenCalledWith("job-email", "Setting up email again");
  });

  it("shows a member what was left out, without the action", async () => {
    const text = await show(LEFT_OUT, { isAdmin: false });
    expect(text).toContain("Part of the app's email is not set up");
    expect(buttons("Set up email again")).toEqual([]);
  });

  it("is not shown while a move to another domain is unfinished; finishing it comes first", async () => {
    const text = await show(LEFT_OUT, { leftover: ["old.test"] });
    expect(text).toContain("Moving email did not finish");
    expect(text).not.toContain("Part of the app's email is not set up");
    expect(buttons("Set up email again")).toEqual([]);
    expect(buttons("Finish moving email")).toHaveLength(1);
  });

  it("names the zone on record when no route of the app is set up there now", async () => {
    const text = await show(LEFT_OUT, { install: { ...INSTALL, emailRoutes: [] } });
    expect(text).toContain(
      "The app receives email for example.com through Cloudflare Email Routing, but none of its routes are set up there now.",
    );
    expect(text).toContain("Part of the app's email is not set up");
  });

  it("is not offered while a job of the app runs", async () => {
    await show(LEFT_OUT, { install: { ...INSTALL, activeJobId: "job-update" } });
    expect(buttons("Set up email again")).toEqual([]);
  });
});
