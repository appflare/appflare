import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomDomainCheck, DomainOptions } from "../installs/custom-domains.server";
import type { CustomDomainView, InstallDetail } from "../installs/installs.functions";

/**
 * The app page's custom domains, with the server functions standing in:
 * nothing here touches an account.
 */
const server = vi.hoisted(() => ({
  checkCustomDomain: vi.fn<(_: unknown) => Promise<CustomDomainCheck>>(),
  getDomainOptions: vi.fn<() => Promise<DomainOptions>>(),
  addCustomDomain: vi.fn(),
  removeCustomDomain: vi.fn(),
  invalidate: vi.fn(async () => {}),
  settingsRefresh: vi.fn(async () => {}),
}));
// One router and one refresh for every render, as the app's are: the rows' checks depend on them.
const router = vi.hoisted(() => ({ invalidate: server.invalidate }));
vi.mock("../installs/custom-domains.functions", () => ({
  checkCustomDomain: server.checkCustomDomain,
  getDomainOptions: server.getDomainOptions,
  addCustomDomain: server.addCustomDomain,
  removeCustomDomain: server.removeCustomDomain,
}));
vi.mock("../installs/wildcard-domains.functions", () => ({
  addWildcardDomain: vi.fn(),
  removeWildcardDomain: vi.fn(),
}));
vi.mock("../installs/health.functions", () => ({ checkInstallHealth: vi.fn() }));
vi.mock("./settings-refresh", () => ({
  NEW_ADDRESS_SETTINGS: "Settings are being deployed with the new address",
  useSettingsRefresh: () => server.settingsRefresh,
}));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

const { CustomDomainsSection } = await import("./custom-domains-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINKS: CustomDomainView = {
  id: "domain-1",
  hostname: "links.example.com",
  url: "https://links.example.com",
  wildcard: false,
  status: "active",
  live: true,
} as CustomDomainView;

const WILDCARD: CustomDomainView = {
  id: "domain-2",
  hostname: "tunnels.example.com",
  url: "https://tunnels.example.com",
  wildcard: true,
  status: "active",
  live: true,
} as CustomDomainView;

/** The app answered on the domain. */
const VERIFIED: CustomDomainCheck = {
  hostname: "links.example.com",
  url: "https://links.example.com",
  status: "verified",
  detail: "HTTP 200",
  checkedAt: "2026-10-06T10:00:00.000Z",
  workersDevTurnedOff: false,
  settingsJobId: null,
  settingsNote: null,
};

function install(
  domains: CustomDomainView[],
  externalDomains: CustomDomainView[] = [],
): InstallDetail {
  return {
    id: "install-1",
    label: "Links",
    status: "installed",
    activeJobId: null,
    wildcard: null,
    domains,
    externalDomains,
    workersDevChoice: "auto",
    workersDevEnabled: true,
  } as InstallDetail;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.checkCustomDomain.mockReset();
  server.getDomainOptions.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(detail: InstallDetail) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CustomDomainsSection install={detail} />
      </TooltipProvider>,
    ),
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await new Promise((done) => setTimeout(done, 20));
  });
}

describe("CustomDomainsSection", () => {
  it("lists each domain as a row, its actions named after it", async () => {
    await show(install([LINKS]));
    expect(container.querySelector("table")).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://links.example.com"]');
    expect(link?.textContent).toContain("links.example.com");
    expect(button("Check links.example.com now").textContent).toContain("Check now");
    expect(button("Remove links.example.com").textContent).toContain("Remove");
  });

  it("shows a wildcard domain as its pattern, with what it covers under it", async () => {
    await show(install([WILDCARD]));
    expect(container.textContent).toContain("*.tunnels.example.com");
    expect(container.textContent).toContain(
      "Every name under tunnels.example.com, and tunnels.example.com itself",
    );
    expect(button("Check *.tunnels.example.com now")).toBeDefined();
  });

  it("shows the result of Check now beside the hostname", async () => {
    server.checkCustomDomain.mockResolvedValue(VERIFIED);
    await show(install([LINKS]));
    await click(button("Check links.example.com now"));
    expect(server.checkCustomDomain).toHaveBeenCalledWith({
      data: { installId: "install-1", resourceId: "domain-1" },
    });
    expect(container.textContent).toContain("Verified");
    expect(container.textContent).toContain("HTTP 200 at");
  });

  it("announces a failed check as an alert, with the links in its message", async () => {
    const message =
      "Cloudflare refused the check. See https://dash.cloudflare.com/?to=/:account/workers for the route.";
    server.checkCustomDomain.mockRejectedValue(new Error(message));
    await show(install([LINKS]));
    await click(button("Check links.example.com now"));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(message);
    expect(alert?.querySelector("a")?.getAttribute("href")).toBe(
      "https://dash.cloudflare.com/?to=/:account/workers",
    );
    // A check that fails the same way keeps the alert in place instead of announcing it again.
    await click(button("Check links.example.com now"));
    expect(server.checkCustomDomain).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBe(alert);
  });

  it("drops the error once a check answers", async () => {
    server.checkCustomDomain.mockRejectedValueOnce(new Error("Cloudflare did not answer."));
    server.checkCustomDomain.mockResolvedValueOnce(VERIFIED);
    await show(install([LINKS]));
    await click(button("Check links.example.com now"));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click(button("Check links.example.com now"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("says in one line that there is none, with Add domain in the header", async () => {
    await show(install([]));
    expect(container.textContent).toContain(
      "No custom domains. The app is served on its workers.dev URL only.",
    );
    expect(button("Add domain")).toBeDefined();
  });

  it("claims no workers.dev only while the app has an external domain", async () => {
    await show(install([], [{ ...LINKS, id: "external-1", hostname: "go.example.org" }]));
    expect(container.textContent).toContain("No custom domains.");
    expect(container.textContent).not.toContain("workers.dev URL only");
  });

  it("picks the zone in the add dialog from a searchable list", async () => {
    server.getDomainOptions.mockResolvedValue({
      zones: [
        { id: "z1", name: "example.com" },
        { id: "z2", name: "example.org" },
      ],
      inactiveZones: [],
      missing: [],
      noZones: false,
    } as DomainOptions);
    await show(install([]));
    await click(button("Add domain"));
    const picker = document.querySelector<HTMLElement>('[role="dialog"] [role="combobox"]');
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain("Choose a domain");
  });
});
