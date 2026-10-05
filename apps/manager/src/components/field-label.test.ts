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
  withoutOptionalPrefix,
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

describe("help of an optional field", () => {
  const google =
    "Optional. A Web application client from the Google Cloud Console with the Search Console API (and, for Analytics, the Analytics APIs) enabled. Its authorized redirect URIs are the app's address plus /api/gsc/oauth/callback and /api/ga4/oauth/callback.";

  it("drops a leading Optional. or Optional: that repeats the label", () => {
    expect(withoutOptionalPrefix("Optional. The base URL.")).toBe("The base URL.");
    expect(withoutOptionalPrefix("optional: the base URL.")).toBe("The base URL.");
    // "Optional" as a word of the sentence stays.
    expect(withoutOptionalPrefix("Optional keys that may only read.")).toBe(
      "Optional keys that may only read.",
    );
    expect(withoutOptionalPrefix("Optional, for sending.")).toBe("Optional, for sending.");
  });

  it("shows the help's first real sentence when the field is labelled optional", () => {
    const html = renderToStaticMarkup(createElement(FieldHelp, { text: google, optional: true }));
    expect(html).toContain("A Web application client from the Google Cloud Console");
    expect(html).not.toMatch(/>Optional\./);
  });

  it("never folds help down to a word or two", () => {
    const { short, more } = splitHelp(google);
    expect(short.startsWith("Optional. A Web application client")).toBe(true);
    expect(more).toMatch(/^Its authorized redirect URIs/);
    const shortTail = `Optional. ${"A long sentence that goes on. ".repeat(4)}Done here now.`;
    expect(splitHelp(shortTail).short.split(/\s+/).length).toBeGreaterThanOrEqual(4);
  });

  it("shows the whole help when little would be left behind More", () => {
    const text = `This one sentence carries ${"the whole of the field's meaning, ".repeat(4)}and is long. Short end.`;
    expect(splitHelp(text)).toEqual({ short: text.trim(), more: null });
  });
});
