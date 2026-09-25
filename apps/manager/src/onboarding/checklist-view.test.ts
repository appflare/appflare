import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type CapabilitiesView, capabilitiesView } from "../capabilities/capabilities";
import { NO_SANDBOX_JOBS } from "../sandbox/readiness";
import type { ChecklistData } from "./checklist.server";
import { ChecklistBody } from "./checklist-view";

const NEEDS = { total: 5, workersPaid: 1, r2: 2, zone: 1, emailRouting: 1, access: 0, sandbox: 1 };

function data(over: Partial<CapabilitiesView> = {}): ChecklistData {
  const view = capabilitiesView(undefined, {
    checkedAt: "2026-09-25T10:00:00.000Z",
    r2: { state: "enabled" },
    containers: { state: "needs-workers-paid" },
    workersPlan: { state: "free" },
    zone: { state: "available" },
    emailRouting: { state: "available" },
    workersDev: { state: "registered", subdomain: "acme" },
    zeroTrust: { state: "none" },
  });
  return {
    view: { ...view, ...over },
    sandbox: "off",
    needs: NEEDS,
    accountId: null,
    sandboxJobs: NO_SANDBOX_JOBS,
  };
}

const ENABLE_NOW = createElement("button", { type: "button", id: "enable-now" }, "Enable now");

function render(d: ChecklistData, enableNow: ReturnType<typeof createElement> | null = ENABLE_NOW) {
  return renderToStaticMarkup(createElement(ChecklistBody, { data: d, enableNow }));
}

describe("the checklist view", () => {
  it("shows progress as rows done out of the rows that count", () => {
    const html = render(data({ workersDev: { state: "not-registered" } }));
    expect(html).toContain('role="meter"');
    expect(html).toContain("3 of 4 done");
    expect(html).toContain("1 item needs you");
    expect(render(data())).toContain("Nothing here needs you");
  });

  it("lists rows that need the admin first, with their action, before done rows", () => {
    const html = render(data({ workersDev: { state: "not-registered" } }));
    const needs = html.indexOf("workers.dev subdomain");
    const done = html.indexOf("R2");
    expect(needs).toBeGreaterThan(-1);
    expect(needs).toBeLessThan(done);
    // Its one action beside it; the explanation sits in the help tooltip, not the row.
    expect(html).toContain("Register");
    expect(html).toContain('aria-label="About workers.dev subdomain"');
    expect(html).not.toContain("Every app answers on its own workers.dev address");
  });

  it("draws done rows as one line: a tick, the title and the value, no explanation", () => {
    const html = render(data());
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain("acme.workers.dev");
    expect(html).not.toContain("Every app answers on its own workers.dev address");
    expect(html).not.toContain('aria-label="Needs you"');
  });

  it("puts optional rows last, under their own heading", () => {
    const html = render(data());
    const heading = html.indexOf("Optional, for more apps");
    expect(heading).toBeGreaterThan(html.indexOf("acme.workers.dev"));
    expect(html.indexOf("Zero Trust organization")).toBeGreaterThan(heading);
    expect(html.indexOf("Sandbox builds")).toBeGreaterThan(heading);
  });

  it("offers Enable now on the sandbox row only when it is ready and the viewer may enable", () => {
    const paid = data({
      workersPlan: { state: "paid" },
      containers: { state: "available" },
      plan: { plan: "paid", source: "detected" },
    });
    const html = render(paid);
    expect(html).toContain("Ready, turns on when an app needs it");
    expect(html).toContain('id="enable-now"');
    expect(render(paid, null)).not.toContain('id="enable-now"');
    // Free plan: what is missing, and no Enable now.
    const free = render(data());
    expect(free).toContain("Needs Workers Paid");
    expect(free).not.toContain('id="enable-now"');
  });

  it("gives every row an anchor, the sandbox row checklist-sandbox", () => {
    const html = render(data());
    expect(html).toContain('id="checklist-sandbox"');
    expect(html).toContain('id="checklist-workers-dev"');
  });

  it("draws every row as one fixed-height line with no paragraph in it", () => {
    const html = render(data({ workersDev: { state: "not-registered" } }));
    const rowsHtml = html.match(/<li [^>]*>/g) ?? [];
    expect(rowsHtml.length).toBe(7);
    for (const li of rowsHtml) expect(li).toContain("h-11");
    expect(html).not.toMatch(/<li[^>]*>(?:(?!<\/li>).)*<p[ >]/s);
  });

  it("keeps showing Enabling… with a spinner and a link to the job after a reload", () => {
    const html = render({
      ...data({
        workersPlan: { state: "paid" },
        containers: { state: "available" },
        plan: { plan: "paid", source: "detected" },
      }),
      sandboxJobs: { activeEnable: { id: "job-1" }, lastFailure: null },
    });
    expect(html).toContain("Enabling…");
    expect(html).toContain('href="/jobs/job-1"');
    expect(html).not.toContain('id="enable-now"');
  });
});
