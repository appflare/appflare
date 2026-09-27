import { Button, Empty, Table } from "@cloudflare/kumo";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Section,
  SectionBody,
  SectionFormActions,
  SectionRow,
  SectionRows,
  SectionTable,
} from "./section";

/** Kumo's card surface: one per section, never one inside another. */
const CARD = "bg-kumo-base shadow-xs ring ring-kumo-line";

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("Section", () => {
  it("renders the heading, one line under it, a badge, and one action at the right", () => {
    const html = renderToStaticMarkup(
      h(
        Section,
        {
          id: "channels",
          title: "Channels",
          description: "Where messages go.",
          badge: h("span", { className: "badge" }, "2 on"),
          action: h(Button, { variant: "primary" }, "Add channel"),
        },
        h(SectionBody, null, "Body"),
      ),
    );
    expect(html).toMatch(/^<section id="channels" aria-labelledby="channels-heading"/);
    expect(html).toContain("scroll-mt-6");
    expect(html).toMatch(/<h2[^>]*id="channels-heading"[^>]*>Channels<\/h2>/);
    expect(text(html)).toContain("Where messages go.");
    expect(text(html)).toContain("2 on");
    expect(count(html, "<button")).toBe(1);
    expect(text(html)).toContain("Add channel");
    // The action comes before the card: it sits in the header, not in the body.
    expect(html.indexOf("Add channel")).toBeLessThan(html.indexOf(CARD));
    expect(count(html, CARD)).toBe(1);
    expect(text(html)).toContain("Body");
  });

  it("stacks the action under the text on phones and puts it at the right from 640 px", () => {
    const html = renderToStaticMarkup(
      h(Section, {
        id: "appflare",
        title: "Appflare version",
        description: "The version of Appflare running here.",
        action: h(Button, { variant: "primary" }, "Update Appflare to 0.5.0"),
      }),
    );
    // A column by default (the text keeps the full width), a row only from `sm`.
    expect(html).toContain(
      'class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"',
    );
    // The text only grows beside the action in the row; in the column it is full width.
    expect(html).toContain('class="grid min-w-0 gap-1 sm:flex-1"');
    expect(html).toMatch(/<div class="sm:shrink-0"><button/);
  });

  it("takes one action at most, by type", () => {
    const one = h(Button, null, "One");
    // @ts-expect-error: a section has one primary action, not a list of them.
    h(Section, { id: "x", title: "X", action: [one, one] });
  });

  it("shows an error as a banner at the top of the card, with a message's links", () => {
    const html = renderToStaticMarkup(
      h(
        Section,
        {
          id: "github-access",
          title: "GitHub access",
          error: "Enable sandbox builds in [Sandbox builds settings](/settings/building#sandbox).",
        },
        h(SectionBody, null, "Body"),
      ),
    );
    expect(count(html, CARD)).toBe(1);
    expect(html.indexOf("Enable sandbox")).toBeLessThan(html.indexOf("Body"));
    expect(html).toContain('href="/settings/building#sandbox"');
  });

  it("shows the empty state instead of the body", () => {
    const html = renderToStaticMarkup(
      h(
        Section,
        {
          id: "passkeys",
          title: "Your passkeys",
          empty: h(Empty, {
            title: "No passkeys yet",
            contents: h(Button, null, "Add passkey"),
          }),
        },
        h(SectionBody, null, "The table"),
      ),
    );
    expect(text(html)).toContain("No passkeys yet");
    expect(text(html)).toContain("Add passkey");
    expect(text(html)).not.toContain("The table");
    expect(count(html, CARD)).toBe(1);
  });
});

describe("the section body layouts", () => {
  it("splits rows with dividers, each with its trailing action and an id to link to", () => {
    const html = renderToStaticMarkup(
      h(
        Section,
        { id: "danger-zone", title: "Danger zone" },
        h(
          SectionRows,
          null,
          h(SectionRow, {
            id: "rotate",
            title: "Rotate the auth secret",
            description: "Signs everyone out.",
            action: h(Button, { variant: "destructive" }, "Rotate auth secret"),
          }),
          h(SectionRow, {
            title: "Remove Appflare from this account",
            action: h(Button, { variant: "destructive" }, "Remove Appflare"),
          }),
        ),
      ),
    );
    expect(html).toContain("divide-y");
    expect(html).toMatch(/<div id="rotate" class="[^"]*scroll-mt-6/);
    expect(count(html, "<button")).toBe(2);
    expect(text(html)).toContain("Signs everyone out.");
  });

  it("puts a table in the section's card, scrolling sideways, without a card of its own", () => {
    const html = renderToStaticMarkup(
      h(
        Section,
        { id: "users", title: "Users" },
        h(
          SectionTable,
          // createElement types the children apart from the props.
          { label: "Users" } as { label: string; children: ReactNode },
          h(Table.Header, null, h(Table.Row, null, h(Table.Head, null, "Email"))),
          h(Table.Body, null, h(Table.Row, null, h(Table.Cell, null, "a@example.com"))),
        ),
      ),
    );
    expect(count(html, CARD)).toBe(1);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('aria-label="Users"');
    expect(text(html)).toContain("a@example.com");
  });

  it("puts a form's Save at the bottom right", () => {
    const html = renderToStaticMarkup(
      h(SectionBody, null, "Fields", h(SectionFormActions, null, h(Button, null, "Save"))),
    );
    expect(html).toContain("justify-end");
    expect(html.indexOf("Fields")).toBeLessThan(html.indexOf("Save"));
  });
});
