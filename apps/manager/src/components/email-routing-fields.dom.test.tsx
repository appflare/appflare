import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailRoutingPreview, EmailZoneOptions } from "../installs/email-routing.server";

/**
 * The install form's Email Routing fields, with the server functions
 * standing in: nothing here touches an account.
 */
const server = vi.hoisted(() => ({
  getEmailZoneOptions: vi.fn<() => Promise<EmailZoneOptions>>(),
  previewEmailRouting: vi.fn<(_: unknown) => Promise<EmailRoutingPreview>>(),
}));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: server.getEmailZoneOptions,
  previewEmailRouting: server.previewEmailRouting,
}));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));

const { EmailRoutingFields } = await import("./email-routing-fields");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TWO_ZONES: EmailZoneOptions = {
  zones: [
    { id: "z1", name: "example.com" },
    { id: "z2", name: "example.org" },
  ],
  inactiveZones: [],
  noZones: false,
};

const BLOCKED = {
  zoneId: "z2",
  zoneName: "example.org",
  routing: { enabled: true, status: "ready" },
  addresses: [],
  wantsCatchAll: true,
  catchAll: null,
  foreignMx: [],
  problems: ["The catch-all of example.org already delivers to ada@example.net."],
  warnings: [],
  missing: [],
  enablesRouting: false,
  sendsEmail: false,
  destinations: null,
} as unknown as EmailRoutingPreview;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.getEmailZoneOptions.mockResolvedValue(TWO_ZONES);
  server.previewEmailRouting.mockResolvedValue(BLOCKED);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The fields as the install form holds them: the zone id in state. */
function Fields({ onReady }: { onReady(ready: boolean): void }) {
  const [zoneId, setZoneId] = useState<string | null>(null);
  return (
    <EmailRoutingFields
      slug="mail"
      workerName="mail"
      disabled={false}
      zoneId={zoneId}
      onZoneChange={setZoneId}
      onReadyChange={onReady}
    />
  );
}

/** A mouse press and release on `el`, the events a pointer click sends. */
async function press(el: Element) {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"] as const) {
      const Event = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(
        new Event(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
      );
    }
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((done) => setTimeout(done, 50));
  });
}

describe("EmailRoutingFields", () => {
  it("picks the domain from a searchable list and announces what stops the install", async () => {
    const onReady = vi.fn();
    await act(async () => root.render(<Fields onReady={onReady} />));
    const picker = container.querySelector('[role="combobox"]');
    expect(picker).not.toBeNull();
    expect(
      document.getElementById(picker?.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("Domain");
    await press(picker as Element);
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent?.trim() === "example.org",
    );
    await press(option as Element);
    // The preview waits for a pause in typing before it reads the zone.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 450));
    });
    expect(server.previewEmailRouting).toHaveBeenCalledWith({
      data: { slug: "mail", zoneId: "z2", workerName: "mail" },
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The app cannot receive email on example.org yet");
    expect(alert?.textContent).toContain("already delivers to ada@example.net");
    expect(onReady).toHaveBeenLastCalledWith(false);
  });
});
