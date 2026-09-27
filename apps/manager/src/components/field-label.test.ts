import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FieldHelp,
  FieldLabel,
  SHORT_HELP_LENGTH,
  splitHelp,
  TECHNICAL_NAMES_LABEL,
  TechnicalNamesProvider,
  TechnicalNamesSwitch,
} from "./field-label";

function render(node: ReactNode, showNames = false): string {
  return renderToStaticMarkup(createElement(TechnicalNamesProvider, { value: showNames }, node));
}

describe("field labels", () => {
  it("show only the human label, with no (NAME) suffix, while technical names are hidden", () => {
    const html = render(
      createElement(FieldLabel, { label: "Admin password", name: "ADMIN_PASSWORD" }),
    );
    expect(html).toContain("Admin password");
    expect(html).not.toContain("ADMIN_PASSWORD");
    expect(html).not.toContain("(ADMIN_PASSWORD)");
  });

  it("show the name inline in muted monospace once the form's switch is on", () => {
    const html = render(
      createElement(FieldLabel, { label: "Admin password", name: "ADMIN_PASSWORD" }),
      true,
    );
    expect(html).toMatch(
      /<span class="font-mono[^"]*text-kumo-subtle"[^>]*>ADMIN_PASSWORD<\/span>/,
    );
  });

  it("show a label that is the name itself as the name", () => {
    expect(render(createElement(FieldLabel, { label: "OLD_TOKEN", name: "OLD_TOKEN" }))).toBe(
      '<span class="font-mono text-[0.9em]">OLD_TOKEN</span>',
    );
  });

  it("offer the switch under one plain label", () => {
    const html = renderToStaticMarkup(
      createElement(TechnicalNamesSwitch, { checked: false, onChange: () => {} }),
    );
    expect(html).toContain(TECHNICAL_NAMES_LABEL);
    expect(html).toContain('role="switch"');
  });
});

describe("field help", () => {
  const long =
    "The address people use to reach the dashboard. It must be the full URL with https, and it must match the domain you set up in the provider's console exactly, or sign-in fails.";

  it("keeps short help whole", () => {
    expect(splitHelp("Used to sign in.")).toEqual({ short: "Used to sign in.", more: null });
  });

  it("shows the first sentence of long help and folds the rest behind More", () => {
    expect(long.length).toBeGreaterThan(SHORT_HELP_LENGTH);
    const { short, more } = splitHelp(long);
    expect(short).toBe("The address people use to reach the dashboard.");
    expect(more).toMatch(/^It must be the full URL/);
    const html = renderToStaticMarkup(createElement(FieldHelp, { text: long }));
    expect(html).toContain(short);
    expect(html).not.toContain("It must be the full URL");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">More<");
  });
});
