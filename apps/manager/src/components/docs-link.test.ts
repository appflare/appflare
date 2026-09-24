import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { docsUrl } from "../docs-topics";
import { DOCS_LINK_LABEL, DocsLink } from "./docs-link";

function render(variant?: "icon" | "inline"): string {
  return renderToStaticMarkup(
    createElement(DocsLink, { topic: "customDomains", ...(variant ? { variant } : {}) }),
  );
}

describe("DocsLink", () => {
  it("renders a labelled help button that opens the topic in a new tab", () => {
    const html = render();
    expect(html).toMatch(/^<a /);
    expect(html).toContain(`href="${docsUrl("customDomains")}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(`aria-label="${DOCS_LINK_LABEL}"`);
  });

  it("renders an inline Learn more link that opens the topic in a new tab", () => {
    const html = render("inline");
    expect(html).toMatch(/^<a /);
    expect(html).toContain(`href="${docsUrl("customDomains")}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Learn more");
  });
});
