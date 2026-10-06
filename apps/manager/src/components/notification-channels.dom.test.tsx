import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelView, NOTIFICATION_COPY, type TestResult } from "../notifications/channels";

/**
 * The notifications settings' Channels section. Its server functions only
 * exist under the Start Vite plugin; they and the router are stubbed.
 */
const server = vi.hoisted(() => ({
  sendTestNotification: vi.fn<(_: unknown) => Promise<TestResult>>(),
  deleteNotificationChannel: vi.fn(async (_: unknown) => {}),
  createNotificationChannel: vi.fn(),
  updateNotificationChannel: vi.fn(),
  replaceWebhookSigningSecret: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../notifications/channels.functions", () => ({
  sendTestNotification: server.sendTestNotification,
  deleteNotificationChannel: server.deleteNotificationChannel,
  createNotificationChannel: server.createNotificationChannel,
  updateNotificationChannel: server.updateNotificationChannel,
  replaceWebhookSigningSecret: server.replaceWebhookSigningSecret,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: server.invalidate }) }));

const { NotificationChannels } = await import("./notification-channels");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM: ChannelView = {
  id: "c1",
  kind: "telegram",
  label: "Team chat",
  target: "-1001234567890",
  events: ["update_failed"],
  failureCount: 0,
  lastError: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  pending: 0,
  readable: true,
  createdAt: "2026-10-01T10:00:00.000Z",
};

const HOOK: ChannelView = {
  ...TEAM,
  id: "c2",
  kind: "webhook",
  label: "Receiver",
  target: "x.dev",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.sendTestNotification.mockReset();
  server.deleteNotificationChannel.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(channels: ChannelView[] | null) {
  act(() =>
    root.render(
      <TooltipProvider>
        <NotificationChannels channels={channels} />
      </TooltipProvider>,
    ),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent === name,
  );
  if (found === undefined) throw new Error(`no "${name}" button`);
  return found;
}

function row(channel: ChannelView): HTMLElement {
  const found = document.getElementById(`channel-${channel.id}`);
  if (found === null) throw new Error(`no row for ${channel.label}`);
  return found;
}

async function openMenu(channel: ChannelView) {
  const trigger = button(`Actions for ${channel.label}`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await settle();
}

function menuItems(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (i) => i.textContent?.trim() ?? "",
  );
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
}

/** Confirms the removal dialog that is open, typing the channel's name. */
async function confirmRemoval(name: string) {
  const input = document.querySelector<HTMLInputElement>('[role="alertdialog"] input');
  if (input === null) throw new Error("no confirmation input");
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Remove channel").click());
  await settle();
}

async function pick(item: string) {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (i) => i.textContent?.trim() === item,
  );
  if (found === undefined) throw new Error(`no "${item}" in the menu`);
  await act(async () => found.click());
  await settle();
}

describe("a channel's row", () => {
  it("names its own channel on Send test and on its menu's button", () => {
    render([TEAM, HOOK]);
    expect(row(TEAM).querySelector('[aria-label="Send test to Team chat"]')).not.toBeNull();
    expect(row(HOOK).querySelector('[aria-label="Actions for Receiver"]')).not.toBeNull();
    // Edit and Remove are in the menu now, not loose buttons in the row.
    expect(row(TEAM).textContent).not.toContain("Edit");
    expect(row(TEAM).textContent).not.toContain("Remove");
  });

  it("puts edit and remove in the menu, and the signing secret for a webhook", async () => {
    render([TEAM, HOOK]);
    await openMenu(TEAM);
    expect(menuItems()).toEqual(["Edit", "Remove"]);
    await act(async () =>
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await settle();
    await openMenu(HOOK);
    expect(menuItems()).toEqual(["Edit", "Replace signing secret", "Remove"]);
  });

  it("opens the edit dialog from the menu", async () => {
    render([TEAM]);
    await openMenu(TEAM);
    await pick("Edit");
    expect(document.body.textContent).toContain("Edit Team chat");
  });

  it("asks before removing, then removes, and gives focus back to the menu's button on cancel", async () => {
    render([TEAM]);
    await openMenu(TEAM);
    await pick("Remove");
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Remove Team chat");
    const remove = button("Remove channel");
    expect(remove.disabled || remove.getAttribute("aria-disabled") === "true").toBe(true);

    await act(async () => button("Cancel").click());
    await settle();
    expect(server.deleteNotificationChannel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("Actions for Team chat"));

    await openMenu(TEAM);
    await pick("Remove");
    await confirmRemoval("Team chat");
    expect(server.deleteNotificationChannel).toHaveBeenCalledWith({ data: { id: "c1" } });
  });

  it("offers no new signing secret for a webhook whose credentials cannot be read", async () => {
    render([{ ...HOOK, readable: false }]);
    await openMenu(HOOK);
    expect(menuItems()).toEqual(["Edit", "Remove"]);
  });

  it("gives focus back to the menu's button when the edit dialog closes", async () => {
    render([TEAM]);
    await openMenu(TEAM);
    await pick("Edit");
    await act(async () => button("Cancel").click());
    await settle();
    expect(document.body.textContent).not.toContain("Edit Team chat");
    expect(document.activeElement).toBe(button("Actions for Team chat"));
  });

  it("gives focus back to the menu's button when the signing secret dialog closes", async () => {
    render([HOOK]);
    await openMenu(HOOK);
    await pick("Replace signing secret");
    expect(document.body.textContent).toContain("Makes a new secret for Receiver.");
    await act(async () => button("Cancel").click());
    await settle();
    expect(server.replaceWebhookSigningSecret).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("Actions for Receiver"));
  });

  it("works from the keyboard: ArrowDown opens the menu, Enter picks an item", async () => {
    render([TEAM]);
    const trigger = button("Actions for Team chat");
    act(() => trigger.focus());
    await press(trigger, "ArrowDown");
    expect(menuItems()).toEqual(["Edit", "Remove"]);
    const highlighted = document.activeElement;
    expect(highlighted?.getAttribute("role")).toBe("menuitem");
    expect(highlighted?.textContent?.trim()).toBe("Edit");
    if (highlighted === null) throw new Error("no item has the focus");
    await press(highlighted, "Enter");
    expect(document.body.textContent).toContain("Edit Team chat");
  });
});

describe("removing a channel", () => {
  async function remove(channel: ChannelView) {
    await openMenu(channel);
    await pick("Remove");
    await confirmRemoval(channel.label);
  }

  it("moves the focus to Add channel once the row is gone", async () => {
    render([TEAM, HOOK]);
    await remove(TEAM);
    // The list comes back without it.
    render([HOOK]);
    await settle();
    expect(document.getElementById("channel-c1")).toBeNull();
    expect(document.activeElement).toBe(button("Add channel"));
  });

  it("moves the focus to the empty state's Add channel after the last one", async () => {
    render([TEAM]);
    await remove(TEAM);
    render([]);
    await settle();
    expect(document.body.textContent).toContain("No notification channels");
    expect(document.activeElement).toBe(button("Add channel"));
  });
});

describe("a member's view", () => {
  it("says only admins manage channels, with nothing to add, test or change", () => {
    render(null);
    expect(document.body.textContent).toContain(NOTIFICATION_COPY.membersOnly);
    expect(() => button("Add channel")).toThrow();
    expect(document.querySelector('[id^="channel-"]')).toBeNull();
    expect(document.querySelector('[aria-label^="Actions for"]')).toBeNull();
  });
});

describe("a test message's result", () => {
  it("reads a delivery from a status region that was on the page before it", async () => {
    server.sendTestNotification.mockResolvedValue({ ok: true, detail: "Delivered." });
    render([TEAM]);
    const region = row(TEAM).querySelector('[role="status"]');
    expect(region?.textContent).toBe("");
    await act(async () => button("Send test to Team chat").click());
    await settle();
    expect(row(TEAM).querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toContain("Test message delivered");
    // One live region: the banner inside it is not a second one.
    expect(region?.querySelector('[role="status"]')).toBeNull();
    expect(row(TEAM).querySelector('[role="alert"]')).toBeNull();
  });

  it("announces a failure as an alert, with the reason", async () => {
    server.sendTestNotification.mockResolvedValue({ ok: false, detail: "Chat not found." });
    render([TEAM]);
    await act(async () => button("Send test to Team chat").click());
    await settle();
    const alert = row(TEAM).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Test message not delivered");
    expect(alert?.textContent).toContain("Chat not found.");
    expect(row(TEAM).querySelector('[role="status"]')?.textContent).toBe("");
  });
});
