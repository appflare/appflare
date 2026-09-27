import { Toasty } from "@cloudflare/kumo";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_SANDBOX_JOBS } from "../sandbox/readiness";
import { capabilitiesView, type StoredCapabilities } from "./capabilities";
import { catalogNeeds } from "./capability-rows";
import type { CapabilityRowsData } from "./capability-rows.server";

// The section reloads through the router and checks through server
// functions, which only exist under the Start Vite plugin.
const invalidate = vi.fn(async () => {});
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate }) }));
const checkCapabilitiesAgain = vi.fn();
const getCapabilityRowsData = vi.fn();
vi.mock("./capability-rows.functions", () => ({ checkCapabilitiesAgain, getCapabilityRowsData }));
const setAccountPlan = vi.fn(async () => "paid");
vi.mock("../account/plan.functions", () => ({ setAccountPlan }));

const { CapabilitiesSection, SetupCapabilities } = await import("./capability-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACC = "acc0000000000000000000000000000a";
/** Kumo's card surface. */
const CARD = '[class*="bg-kumo-base shadow-xs ring ring-kumo-line"]';
const CHECKED = "2026-09-24T10:00:00.000Z";

/** Workers Free, R2 off, no Zero Trust, and Analytics Engine could not be checked. */
const FREE: StoredCapabilities = {
  checkedAt: CHECKED,
  r2: { state: "not-enabled" },
  containers: { state: "needs-workers-paid" },
  workersPlan: { state: "free" },
  zone: { state: "available" },
  emailRouting: { state: "available" },
  workersDev: { state: "registered", subdomain: "acme" },
  zeroTrust: { state: "none" },
  analyticsEngine: { state: "unknown", reason: "error", detail: "HTTP 503 from Cloudflare" },
};

function data(stored: StoredCapabilities | null = FREE, manual: string | null = null) {
  return {
    view: capabilitiesView(manual, stored, ACC),
    sandbox: "off",
    needs: null,
    // An installed app stores files in R2; nothing else is in use.
    inUse: { ...catalogNeeds([]), total: 1, r2: 1 },
    sandboxJobs: NO_SANDBOX_JOBS,
  } satisfies CapabilityRowsData;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(element: ReactElement) {
  // Dialog triggers read the toast manager; the app provides it at its root.
  act(() => root.render(<Toasty>{element}</Toasty>));
}

/** Each row: its anchor, its text (name, badge, why), its links and its buttons. */
function rowsShown() {
  return [...container.querySelectorAll<HTMLElement>('[id^="capability-"]')].map((row) => ({
    id: row.id,
    text: row.textContent ?? "",
    links: [...row.querySelectorAll("a")].map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
    })),
    buttons: [...row.querySelectorAll("button")].map((b) => b.textContent),
  }));
}

function button(name: string, within: Element | Document = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
}

describe("What this account can run on Your account", () => {
  it("is one section with one card, the meter in its header and Check again at the right", () => {
    render(<CapabilitiesSection data={data()} isAdmin />);
    const section = container.querySelector("section#capabilities");
    expect(section).not.toBeNull();
    expect(section?.querySelector("h2")?.textContent).toBe("What this account can run");
    // One card, no card inside it.
    expect(section?.querySelectorAll(CARD).length).toBe(1);
    // Nine rows; sandbox builds are paid only; R2, Zero Trust need action;
    // Analytics Engine could not be checked.
    const meter = section?.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuetext")).toBe("5 of 8 ready");
    expect(section?.textContent).toContain("5 of 8 ready");
    expect(button("Check again", section ?? document)).toBeTruthy();
    expect(section?.textContent).toContain("Checked");
    // No tooltips on the rows: every detail is shown inline when opened.
    expect(section?.querySelectorAll('[aria-label^="About "]').length).toBe(0);
  });

  it("shows a state badge on every row, one per state", () => {
    render(<CapabilitiesSection data={data()} isAdmin />);
    const byId = Object.fromEntries(rowsShown().map((r) => [r.id, r.text]));
    expect(Object.keys(byId)).toEqual([
      "capability-workers-plan",
      "capability-workers-dev",
      "capability-r2",
      "capability-zone",
      "capability-email-routing",
      "capability-analytics-engine",
      "capability-zero-trust",
      "capability-sandbox",
      "capability-token-permissions",
    ]);
    expect(byId["capability-workers-plan"]).toContain("Ready");
    expect(byId["capability-r2"]).toContain("Needs action");
    // Off, but no app in the account needs it: quiet, not a warning.
    expect(byId["capability-zero-trust"]).toContain("Not set up");
    expect(byId["capability-zero-trust"]).not.toContain("Needs action");
    expect(byId["capability-sandbox"]).toContain("Paid plan only");
    expect(byId["capability-analytics-engine"]).toContain("Could not check");
    // Each row says why apps need it.
    expect(byId["capability-r2"]).toContain("Apps keep files and uploads in R2.");
  });

  it("gives each row its one action at the right: the dashboard, or Building apps", () => {
    render(<CapabilitiesSection data={data()} isAdmin />);
    const byId = Object.fromEntries(rowsShown().map((r) => [r.id, r]));
    expect(byId["capability-r2"]?.links).toEqual([
      {
        text: "Turn on in Cloudflare",
        href: `https://dash.cloudflare.com/?to=/${ACC}/r2/overview`,
        target: "_blank",
      },
    ]);
    expect(byId["capability-sandbox"]?.links).toEqual([
      { text: "Set up", href: "/settings/building#sandbox", target: null },
    ]);
    // Ready rows have nothing to do.
    expect(byId["capability-workers-dev"]?.links).toEqual([]);
    expect(byId["capability-workers-dev"]?.buttons).toEqual(["Details"]);
  });

  it("keeps the details closed until Details is chosen, then shows them in the row", () => {
    render(<CapabilitiesSection data={data()} isAdmin />);
    const row = container.querySelector("#capability-analytics-engine") as HTMLElement;
    expect(row.textContent).not.toContain("HTTP 503");
    const details = button("Details", row);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    act(() => details.click());
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toContain("The check failed: HTTP 503 from Cloudflare");
    expect(row.textContent).toContain("Checked");
    // Another row keeps its details closed.
    const plan = container.querySelector("#capability-workers-plan") as HTMLElement;
    expect(plan.textContent).not.toContain("detected by Appflare");
    act(() => button("Details", plan).click());
    expect(plan.textContent).toContain("Workers Free, detected by Appflare.");
  });

  it("checks again and reloads the page", async () => {
    checkCapabilitiesAgain.mockResolvedValue(data());
    render(<CapabilitiesSection data={data()} isAdmin />);
    await act(async () => button("Check again").click());
    expect(checkCapabilitiesAgain).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("says when it has not been checked yet", () => {
    render(<CapabilitiesSection data={data(null)} isAdmin />);
    const section = container.querySelector("section#capabilities");
    expect(section?.textContent).toContain("Not checked yet.");
    expect(section?.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe(
      "0 of 8 ready",
    );
  });

  it("offers Choose plan while the plan is not detected, and saves the choice", async () => {
    const undetected = data({
      ...FREE,
      workersPlan: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
      containers: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
    });
    render(<CapabilitiesSection data={undetected} isAdmin />);
    const plan = container.querySelector("#capability-workers-plan") as HTMLElement;
    expect(plan.textContent).toContain("Needs action");
    await act(async () => button("Choose plan", plan).click());
    const paid = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) =>
      r.closest("label")?.textContent?.startsWith("Workers Paid"),
    );
    expect(paid).toBeDefined();
    await act(async () => paid?.click());
    await act(async () => button("Save").click());
    expect(setAccountPlan).toHaveBeenCalledWith({ data: { plan: "paid" } });
    expect(invalidate).toHaveBeenCalled();
  });

  it("gives members no Check again and no Choose plan, but the same rows", () => {
    const undetected = data({
      ...FREE,
      workersPlan: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
      containers: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
    });
    render(<CapabilitiesSection data={undetected} isAdmin={false} />);
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Check again");
    expect(labels).not.toContain("Choose plan");
    expect(rowsShown()).toHaveLength(9);
  });
});

describe("the last setup step", () => {
  it("shows the same rows, states and actions as Your account", () => {
    render(<CapabilitiesSection data={data()} isAdmin />);
    const settings = rowsShown().map(({ id, text, links }) => ({
      id,
      text: text.replace("Details", ""),
      links: links.map((l) => [l.text, l.href]),
    }));
    render(<SetupCapabilities data={data()} onChanged={() => {}} />);
    const setup = rowsShown().map(({ id, text, links }) => ({
      id,
      text: text.replace("Details", ""),
      links: links.map((l) => [l.text, l.href]),
    }));
    expect(setup).toEqual(settings);
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe(
      "5 of 8 ready",
    );
    // No card of its own inside the setup card.
    expect(container.querySelectorAll(CARD).length).toBe(0);
  });

  it("opens Building apps in a new tab, so setup keeps its place", () => {
    render(<SetupCapabilities data={data()} onChanged={() => {}} />);
    const sandbox = rowsShown().find((r) => r.id === "capability-sandbox");
    expect(sandbox?.links).toEqual([
      { text: "Set up", href: "/settings/building#sandbox", target: "_blank" },
    ]);
  });

  it("hands the new reading to the step after Check again", async () => {
    const later = data({ ...FREE, r2: { state: "enabled" } });
    checkCapabilitiesAgain.mockResolvedValue(later);
    const onChanged = vi.fn();
    render(<SetupCapabilities data={data()} onChanged={onChanged} />);
    await act(async () => button("Check again").click());
    expect(onChanged).toHaveBeenCalledWith(later);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
