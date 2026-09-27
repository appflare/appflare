import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DomainName, DomainNameList } from "./domain-name";
import { WildcardNotes } from "./wildcard-notes";

const wildcard = {
  id: "i1:wildcard_domain:01A",
  hostname: "tunnels.example.com",
  url: "https://tunnels.example.com",
  wildcard: true,
};
const custom = {
  id: "i1:domain:01B",
  hostname: "app.example.com",
  url: "https://app.example.com",
  wildcard: false,
};

describe("DomainName", () => {
  it("shows a wildcard domain as its pattern, linking to its base", () => {
    const html = renderToStaticMarkup(createElement(DomainName, { domain: wildcard }));
    expect(html).toContain('href="https://tunnels.example.com"');
    expect(html).toContain("*.tunnels.example.com");
    expect(html).toContain("Every name under tunnels.example.com, and tunnels.example.com itself");
  });

  it("shows a custom domain as its hostname, or its URL", () => {
    const html = renderToStaticMarkup(createElement(DomainName, { domain: custom }));
    expect(html).toContain(">app.example.com<");
    expect(html).not.toContain("*.");
    expect(
      renderToStaticMarkup(createElement(DomainName, { domain: custom, showUrl: true })),
    ).toContain(">https://app.example.com<");
    expect(
      renderToStaticMarkup(createElement(DomainName, { domain: wildcard, showUrl: true })),
    ).toContain(">https://*.tunnels.example.com<");
  });
});

describe("DomainNameList", () => {
  it("lists each domain once, in order, and nothing for none", () => {
    const html = renderToStaticMarkup(
      createElement(DomainNameList, { domains: [custom, wildcard] }),
    );
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html.indexOf("app.example.com")).toBeLessThan(html.indexOf("*.tunnels.example.com"));
    expect(renderToStaticMarkup(createElement(DomainNameList, { domains: [] }))).toBe("");
  });
});

describe("WildcardNotes", () => {
  const props = { zoneName: "example.com", agreed: false, onAgree: () => {}, disabled: false };

  it("notes the certificate names under a subdomain need", () => {
    const html = renderToStaticMarkup(
      createElement(WildcardNotes, { ...props, base: "tunnels.example.com", wholeDomain: false }),
    );
    expect(html).toContain("Names under tunnels.example.com need a certificate");
    expect(html).toContain("Total TLS");
  });

  it("asks before the whole zone is used", () => {
    const html = renderToStaticMarkup(
      createElement(WildcardNotes, { ...props, base: "example.com", wholeDomain: true }),
    );
    expect(html).toContain("The app gets example.com and *.example.com");
    expect(html).toContain("Serve every name in example.com with this app");
  });
});
