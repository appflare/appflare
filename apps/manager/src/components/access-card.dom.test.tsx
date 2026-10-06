import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessCheck, AccessStatus } from "../server/access.functions";

/**
 * The users settings' Cloudflare Access section. Its server functions only
 * exist under the Start Vite plugin; they and the router are stubbed.
 */
const server = vi.hoisted(() => ({
  checkAccess: vi.fn<() => Promise<AccessCheck>>(),
  resyncAccessAdmins: vi.fn(async () => ({
    ok: true as const,
    on: true as const,
    adminEmails: ["ada@example.com", "grace@example.com"],
  })),
  turnOnAccess: vi.fn(),
  turnOffAccess: vi.fn(),
}));
vi.mock("../server/access.functions", () => server);
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: async () => {} }) }));

const { AccessCard } = await import("./access-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OFF: AccessStatus = {
  enabled: false,
  domain: null,
  teamDomain: null,
  enabledAt: null,
  adminEmails: ["ada@example.com"],
  currentHostname: "appflare.ada.workers.dev",
};

const ON: AccessStatus = {
  ...OFF,
  enabled: true,
  domain: "appflare.ada.workers.dev",
  teamDomain: "ada.cloudflareaccess.com",
  enabledAt: "2026-10-01T10:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.checkAccess.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no "${name}" button`);
  return found;
}

describe("re-syncing the admins", () => {
  it("reads the outcome from a status region that was on the page before it", async () => {
    act(() => root.render(<AccessCard status={ON} isAdmin viewerEmail="ada@example.com" />));
    const region = container.querySelector('[role="status"]');
    expect(region?.textContent).toBe("");
    await act(async () => button("Re-sync admins").click());
    await settle();
    expect(container.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toContain(
      "The Access policy now allows ada@example.com, grace@example.com.",
    );
    expect(region?.querySelector('[role="status"]')).toBeNull();
  });
});

describe("a check that finds a problem", () => {
  it("is an alert whose message keeps its links, opening in a new tab", async () => {
    server.checkAccess.mockResolvedValue({
      ok: false,
      problem: "apps-permission",
      message:
        "The token cannot edit Access applications. Add the permission at https://dash.cloudflare.com/profile/api-tokens.",
    });
    act(() => root.render(<AccessCard status={OFF} isAdmin viewerEmail="ada@example.com" />));
    await act(async () => button("Protect with Cloudflare Access").click());
    await settle();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Cloudflare Access cannot be turned on yet");
    const link = alert?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("is a polite note when only the Zero Trust organization is missing", async () => {
    server.checkAccess.mockResolvedValue({
      ok: false,
      problem: "no-organization",
      message: "This account has no Zero Trust organization yet.",
    });
    act(() => root.render(<AccessCard status={OFF} isAdmin viewerEmail="ada@example.com" />));
    await act(async () => button("Protect with Cloudflare Access").click());
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    const notes = [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent);
    expect(notes.some((t) => t?.includes("Create a Zero Trust organization first"))).toBe(true);
  });
});
