import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LicenseBadge } from "./catalog-badges";

function render(expression: string, note: string | null = null): string {
  return renderToStaticMarkup(createElement(LicenseBadge, { license: { expression, note } }));
}

/** The badge's text, tags removed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("LicenseBadge", () => {
  it("renders an open-source id in a neutral badge", () => {
    const html = render("MIT");
    expect(text(html)).toBe("MIT");
    expect(html).toContain("bg-kumo-badge-neutral");
    expect(html).not.toContain("Source-available");
  });

  it("renders a source-available id after a muted prefix", () => {
    const html = render("BUSL-1.1");
    expect(text(html)).toBe("Source-availableBUSL-1.1");
    expect(html).toContain("bg-kumo-badge-neutral");
    expect(html).toMatch(/<span class="font-normal opacity-75">Source-available<\/span>BUSL-1\.1/);
  });

  it("renders No license in the warning tone", () => {
    const html = render("NONE");
    expect(text(html)).toBe("No license");
    expect(html).toContain("bg-kumo-warning-tint");
    expect(html).not.toContain("NONE");
  });
});
