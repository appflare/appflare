import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoneSaasCheck } from "../gateway/gateway";
import type { GatewayView } from "../gateway/gateway.server";

/**
 * Settings, Domains, External domains: choosing the gateway's zone, with the
 * server functions standing in. Nothing here touches an account.
 */
const server = vi.hoisted(() => ({
  checkGatewayZone: vi.fn<(_: unknown) => Promise<ZoneSaasCheck & { zoneName: string }>>(),
  setUpGateway: vi.fn(),
  turnOffGateway: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../gateway/gateway.functions", () => ({
  checkGatewayZone: server.checkGatewayZone,
  setUpGateway: server.setUpGateway,
  turnOffGateway: server.turnOffGateway,
}));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: server.invalidate }) }));

const { GatewayCard } = await import("./gateway-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_GATEWAY: GatewayView = {
  gateway: null,
  zones: [
    { id: "z1", name: "example.com" },
    { id: "z2", name: "example.org" },
  ],
  accountId: "0123456789abcdef0123456789abcdef",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.checkGatewayZone.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(view: GatewayView) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GatewayCard view={view} isAdmin />
      </TooltipProvider>,
    ),
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

async function choose(zoneName: string) {
  const picker = container.querySelector('[role="combobox"]');
  if (picker === null) throw new Error("no zone picker");
  const labelId = picker.getAttribute("aria-labelledby");
  expect(document.getElementById(labelId ?? "")?.textContent).toBe("Gateway domain");
  await press(picker);
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent?.trim() === zoneName,
  );
  if (option === undefined) throw new Error(`no option ${zoneName}`);
  await press(option);
}

describe("GatewayCard, choosing the gateway's zone", () => {
  it("checks the chosen zone and says when it is ready", async () => {
    server.checkGatewayZone.mockResolvedValue({
      kind: "ready",
      used: 0,
      allocated: 100,
      zoneName: "example.org",
    });
    await show(NO_GATEWAY);
    await choose("example.org");
    expect(server.checkGatewayZone).toHaveBeenCalledWith({ data: { zoneId: "z2" } });
    const status = [...container.querySelectorAll('[role="status"]')].find((el) =>
      el.textContent?.includes("Cloudflare for SaaS is on for example.org"),
    );
    expect(status).toBeDefined();
  });

  it("announces a failed check as an alert, with the links in its message", async () => {
    const message =
      "Cloudflare refused: see https://dash.cloudflare.com/?to=/:account/ssl-tls for the zone.";
    server.checkGatewayZone.mockResolvedValue({ kind: "error", message, zoneName: "example.com" });
    await show(NO_GATEWAY);
    await choose("example.com");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Cloudflare could not be asked");
    expect(
      alert?.querySelector('a[href="https://dash.cloudflare.com/?to=/:account/ssl-tls"]'),
    ).not.toBeNull();
  });

  it("asks politely when Cloudflare for SaaS is off for the zone", async () => {
    server.checkGatewayZone.mockResolvedValue({
      kind: "saas-off",
      dashboardUrl:
        "https://dash.cloudflare.com/?to=/:account/example.com/ssl-tls/custom-hostnames",
      zoneName: "example.com",
    });
    await show(NO_GATEWAY);
    await choose("example.com");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const status = [...container.querySelectorAll('[role="status"]')].find((el) =>
      el.textContent?.includes("Cloudflare for SaaS is off for example.com"),
    );
    expect(status).toBeDefined();
  });
});
