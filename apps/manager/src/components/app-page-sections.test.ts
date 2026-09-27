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
    state: "not turned on",
    tone: "missing",
    detail: "R2 is not turned on for this account.",
    fix: { label: "Turn on", href: "https://dash.cloudflare.com/?to=/acc1/r2/overview" },
  };

  it("ends a missing need with a link to fix it, in a new tab, and no tooltip", () => {
    const html = renderToStaticMarkup(createElement(NeedRow, { need: r2 }));
    expect(text(html)).toBe("R2 storage · not turned on · Turn on");
    const link = html.match(/<a [^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="https://dash.cloudflare.com/?to=/acc1/r2/overview"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain(r2.detail);
  });

  it("leaves a ready need as its name and state", () => {
    const ready: AccountNeed = { ...r2, state: "ready", tone: "ready", fix: null };
    const html = renderToStaticMarkup(createElement(NeedRow, { need: ready }));
    expect(text(html)).toBe("R2 storage · ready");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
  });
});

describe("SettingsList", () => {
  const item = (description: string | null): SettingItem => ({
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
