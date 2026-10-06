import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountNeed } from "../catalog/account-needs";
import type { SettingItem } from "../catalog/app-page";
import { NeedRow, SettingsList } from "./app-page-sections";

/** Visible and screen-reader text, tags removed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("NeedRow", () => {
  const r2: AccountNeed = {
    key: "r2",
    name: "R2 storage",
    state: "Needs action",
    tone: "missing",
    reason: "This app needs it. Apps keep files and uploads in R2. Turning it on is free.",
    fix: {
      label: "Turn on in Cloudflare",
      href: "https://dash.cloudflare.com/?to=/acc1/r2/overview",
    },
    more: { label: "See in Your account", href: "/settings/account#capability-r2" },
  };

  function links(html: string): string[] {
    return html.match(/<a [^>]*>/g) ?? [];
  }

  it("says why, then links to the fix in a new tab and to the row on Your account", () => {
    const html = renderToStaticMarkup(createElement(NeedRow, { need: r2 }));
    expect(text(html)).toBe(
      "R2 storage · Needs actionThis app needs it. Apps keep files and uploads in R2. Turning it on is free.Turn on in CloudflareSee in Your account",
    );
    const [fix, more] = links(html);
    expect(fix).toContain('href="https://dash.cloudflare.com/?to=/acc1/r2/overview"');
    expect(fix).toContain('target="_blank"');
    expect(fix).toContain('rel="noopener noreferrer"');
    // The row on Your account opens in place.
    expect(more).toContain('href="/settings/account#capability-r2"');
    expect(more).not.toContain("target=");
    expect(html).not.toContain("<button");
  });

  it("puts the banner's explanation in place of the reason", () => {
    const html = renderToStaticMarkup(
      createElement(NeedRow, { need: r2, explanation: "R2 must be enabled on the account." }),
    );
    expect(text(html)).toContain("R2 must be enabled on the account.");
    expect(text(html)).not.toContain("This app needs it.");
  });

  it("offers only the row on Your account when there is no dashboard page", () => {
    const plan: AccountNeed = {
      ...r2,
      key: "plan",
      name: "Workers plan",
      reason: "This app needs Workers Paid, and Appflare cannot tell this account's plan.",
      fix: null,
      more: { label: "Choose plan", href: "/settings/account#capability-workers-plan" },
    };
    const html = renderToStaticMarkup(createElement(NeedRow, { need: plan }));
    const [only, ...rest] = links(html);
    expect(rest).toEqual([]);
    expect(only).toContain('href="/settings/account#capability-workers-plan"');
    expect(text(html)).toMatch(/Choose plan$/);
  });

  it("leaves a ready need as its name and state", () => {
    const ready: AccountNeed = {
      ...r2,
      state: "Ready",
      tone: "ready",
      reason: null,
      fix: null,
      more: null,
    };
    const html = renderToStaticMarkup(createElement(NeedRow, { need: ready }));
    expect(text(html)).toBe("R2 storage · Ready");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
  });
});

describe("SettingsList", () => {
  const item = (description: string | null): SettingItem => ({
    key: "secret:ADMIN_PASSWORD",
    label: "Admin password",
    name: "ADMIN_PASSWORD",
    hint: "Required",
    description,
  });

  it("puts a help button after a label that has a description", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsList, { items: [item("Signs you in to the app.")] }),
    );
    expect(html).toContain('aria-label="About Admin password"');
    // The label comes first, then the button, then the hint.
    expect(text(html)).toBe("Admin passwordRequired");
    expect(html.indexOf("Admin password<")).toBeLessThan(html.indexOf("About Admin password"));
  });

  it("has no help button without a description", () => {
    for (const description of [null, "  "]) {
      const html = renderToStaticMarkup(
        createElement(SettingsList, { items: [item(description)] }),
      );
      expect(html).not.toContain("About Admin password");
    }
  });
});
