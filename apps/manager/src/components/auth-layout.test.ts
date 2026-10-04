import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { managerSiteLink } from "../site-links";
import { AuthError, AuthLayout, DOCS_URL, OrDivider, setupStepLabel } from "./auth-layout";
import { PasswordInput } from "./password-input";

type LayoutProps = Omit<Parameters<typeof AuthLayout>[0], "children">;

function layout(props: Partial<LayoutProps> = {}): string {
  const all: LayoutProps = {
    title: "Sign in to Appflare",
    description: "Use your email and password, or a passkey.",
    version: "1.4.0",
    ...props,
  };
  return renderToStaticMarkup(
    createElement(
      AuthLayout,
      all as Parameters<typeof AuthLayout>[0],
      createElement("form", { id: "content" }),
    ),
  );
}

describe("AuthLayout", () => {
  it("puts the logo above one card with the title, subtitle and content", () => {
    const html = layout();
    expect(html.indexOf('aria-label="Appflare"')).toBeLessThan(html.indexOf("<h1"));
    expect(html).toMatch(/<h1[^>]*>Sign in to Appflare<\/h1>/);
    expect(html).toContain("Use your email and password, or a passkey.");
    expect(html).toContain('<form id="content">');
    // Dark mode is chosen in the browser; rendered here the page stays in Kumo's default.
    expect(html).not.toContain("data-mode");
  });

  it("shows the setup step only on setup screens", () => {
    expect(layout()).not.toContain('role="meter"');
    const html = layout({ step: 1 });
    expect(html).toContain('role="meter"');
    expect(html).toContain(`aria-valuetext="${setupStepLabel(1)}"`);
    expect(html).toContain("Step 1 of 3");
  });

  it("links the version in the footer to the docs", () => {
    const html = layout();
    const href = managerSiteLink(DOCS_URL, "footer")
      .replaceAll("&", "&amp;")
      .replaceAll("?", "\\?");
    expect(html).toMatch(new RegExp(`<footer[^>]*>.*href="${href}".*1\\.4\\.0.*</footer>`));
    expect(layout({ version: null })).toContain("Appflare documentation");
  });
});

describe("auth screen parts", () => {
  it("announces an error as an alert with the plain message only", () => {
    const html = renderToStaticMarkup(createElement(AuthError, { message: "Try again." }));
    expect(html).toMatch(/^<div role="alert">/);
    expect(html).toContain("Try again.");
  });

  it("writes a visible or between the two sign-in methods", () => {
    expect(renderToStaticMarkup(createElement(OrDivider))).toMatch(/>or</);
  });

  it("labels the password field and gives it the autocomplete hint and a show button", () => {
    const html = renderToStaticMarkup(
      createElement(PasswordInput, {
        label: "Password",
        name: "password",
        autoComplete: "new-password",
        minLength: 12,
      }),
    );
    const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`for="${id}"`);
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<input[^>]*autoComplete="new-password"/);
    expect(html).toMatch(/<input[^>]*required=""/);
    expect(html).toMatch(/<input[^>]*minLength="12"/);
    expect(html).toContain('aria-label="Show password"');
  });
});
