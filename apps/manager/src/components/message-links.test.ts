import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { messageLink, messageSegments, plainMessage } from "./message-links";
import { ErrorMessageBanner, MessageLinkButtons, MessageText } from "./message-text";

const MESSAGE =
  "Appflare is not connected to a sandbox Worker; enable sandbox builds in [Sandbox builds settings](/settings/account#sandbox) and try again";

describe("messageLink", () => {
  it("writes a link token for a path inside the manager", () => {
    expect(messageLink("the domains settings", "/settings/domains#external-domains")).toBe(
      "[the domains settings](/settings/domains#external-domains)",
    );
  });

  it("refuses anything but a path inside the manager, and labels that would break the token", () => {
    expect(() => messageLink("x", "https://example.com")).toThrow();
    expect(() => messageLink("x", "//example.com/a")).toThrow();
    expect(() => messageLink("x", "/a b")).toThrow();
    expect(() => messageLink("[x]", "/settings")).toThrow();
  });
});

describe("messageSegments", () => {
  it("splits a message into text and links, in order", () => {
    expect(messageSegments(MESSAGE)).toEqual([
      {
        kind: "text",
        text: "Appflare is not connected to a sandbox Worker; enable sandbox builds in ",
      },
      { kind: "link", label: "Sandbox builds settings", href: "/settings/account#sandbox" },
      { kind: "text", text: " and try again" },
    ]);
  });

  it("leaves a message without links, and links out of the manager, as text", () => {
    expect(messageSegments("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(messageSegments("see [docs](https://example.com)")).toEqual([
      { kind: "text", text: "see [docs](https://example.com)" },
    ]);
    expect(messageSegments("")).toEqual([]);
  });
});

describe("plainMessage", () => {
  it("keeps each link's label, for places that show text only", () => {
    expect(plainMessage(MESSAGE)).toBe(
      "Appflare is not connected to a sandbox Worker; enable sandbox builds in Sandbox builds settings and try again",
    );
  });
});

describe("MessageText", () => {
  it("renders the links as links, in the same tab by default", () => {
    const html = renderToStaticMarkup(createElement(MessageText, { message: MESSAGE }));
    expect(html).toContain('href="/settings/account#sandbox"');
    expect(html).toContain(">Sandbox builds settings</a>");
    expect(html).not.toContain("target=");
    expect(html.replace(/<[^>]+>/g, "")).toBe(plainMessage(MESSAGE));
  });

  it("opens them in a new tab while the reader is in the middle of something", () => {
    const html = renderToStaticMarkup(
      createElement(MessageText, { message: MESSAGE, newTab: true }),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });
});

describe("ErrorMessageBanner", () => {
  it("puts a message with a link in the description, and a plain one in the title", () => {
    const linked = renderToStaticMarkup(createElement(ErrorMessageBanner, { message: MESSAGE }));
    expect(linked).toContain('href="/settings/account#sandbox"');
    const plain = renderToStaticMarkup(
      createElement(ErrorMessageBanner, { message: "Could not save." }),
    );
    expect(plain).toContain("Could not save.");
    expect(plain).not.toContain("<a ");
  });
});

describe("MessageLinkButtons", () => {
  it("offers each place a message links to as a button, and nothing for a plain message", () => {
    const html = renderToStaticMarkup(createElement(MessageLinkButtons, { message: MESSAGE }));
    expect(html).toContain('href="/settings/account#sandbox"');
    expect(html).toContain("Open Sandbox builds settings");
    expect(renderToStaticMarkup(createElement(MessageLinkButtons, { message: "plain" }))).toBe("");
  });
});
