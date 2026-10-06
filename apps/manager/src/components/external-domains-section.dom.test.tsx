import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalDomainStatus } from "../installs/external-domain-input";
import type { CustomDomainView, InstallDetail } from "../installs/installs.functions";

/**
 * The app page's external domains, with the server functions standing in:
 * nothing here touches an account.
 */
const server = vi.hoisted(() => ({
  getExternalDomainStatus: vi.fn<(_: unknown) => Promise<ExternalDomainStatus>>(),
  invalidate: vi.fn(async () => {}),
  settingsRefresh: vi.fn(async () => {}),
}));
// One router and one refresh for every render, as the app's are: the rows' checks depend on them.
const router = vi.hoisted(() => ({ invalidate: server.invalidate }));
vi.mock("../installs/external-domains.functions", () => ({
  addExternalDomain: vi.fn(),
  getExternalDomainOptions: vi.fn(),
  getExternalDomainStatus: server.getExternalDomainStatus,
  removeExternalDomain: vi.fn(),
}));
vi.mock("../installs/health.functions", () => ({ checkInstallHealth: vi.fn() }));
vi.mock("./settings-refresh", () => ({
  NEW_ADDRESS_SETTINGS: "Settings are being deployed with the new address",
  useSettingsRefresh: () => server.settingsRefresh,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

const { ExternalDomainsSection } = await import("./external-domains-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GO: CustomDomainView = {
  id: "external-1",
  hostname: "go.example.org",
  url: "https://go.example.org",
  wildcard: false,
  status: "active",
  live: true,
} as CustomDomainView;

const ACTIVE: ExternalDomainStatus = {
  hostname: "go.example.org",
  status: "active",
  sslStatus: "active",
  method: "http",
  active: true,
  records: [],
  errors: [],
  health: null,
  checkedAt: "2026-10-06T10:00:00.000Z",
} as ExternalDomainStatus;

function install(externalDomains: CustomDomainView[]): InstallDetail {
  return {
    id: "install-1",
    label: "Links",
    status: "installed",
    activeJobId: null,
    wildcard: null,
    externalDomains,
  } as InstallDetail;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.getExternalDomainStatus.mockReset();
  server.getExternalDomainStatus.mockResolvedValue(ACTIVE);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(detail: InstallDetail) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ExternalDomainsSection install={detail} isAdmin />
      </TooltipProvider>,
    );
    await new Promise((done) => setTimeout(done, 20));
  });
}

function button(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
}

describe("ExternalDomainsSection", () => {
  it("names each row's actions after its hostname", async () => {
    await show(install([GO]));
    expect(button("Check go.example.org now")?.textContent).toContain("Check now");
    expect(button("Remove go.example.org")).toBeDefined();
    await act(async () => {
      button("Check go.example.org now")?.click();
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(server.getExternalDomainStatus).toHaveBeenLastCalledWith({
      data: { installId: "install-1", resourceId: "external-1", probe: true },
    });
  });

  it("shows an empty state that leads to the gateway's settings, with Add external domain in the header", async () => {
    await show(install([]));
    expect(container.textContent).toContain("No external domains");
    expect(container.textContent).toContain(
      "An external domain needs the gateway, set up once in the domains settings.",
    );
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Open the domains settings",
    );
    expect(link?.getAttribute("href")).toBe("/settings/domains#external-domains");
    expect(button("Add external domain")).toBeDefined();
  });
});
