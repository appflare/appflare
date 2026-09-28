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

/** Kumo's layered card: one per section. */
const LAYERED = "bg-kumo-elevated text-base ring ring-kumo-hairline";
/** Its grey top band, which holds the section's header. */
const BAND = "bg-kumo-elevated p-4";
/** Its body, which holds the content. */
const BODY = "bg-kumo-base text-inherit no-underline ring ring-kumo-fill";
/** Kumo's plain card surface: never inside a section. */
const SURFACE = "bg-kumo-base shadow-xs ring ring-kumo-line";

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** One layered card, with one band and one body at most, and no card inside it. */
function expectOneCard(html: string, { body = true } = {}) {
  expect(count(html, LAYERED)).toBe(1);
  expect(count(html, BAND)).toBe(1);
  expect(count(html, BODY)).toBe(body ? 1 : 0);
  expect(count(html, SURFACE)).toBe(0);
}

describe("Section", () => {
  it("is one layered card: heading, line, badge and action in the band, the content below", () => {
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
    expectOneCard(html);
    expect(html).toMatch(/<h2[^>]*id="channels-heading"[^>]*>Channels<\/h2>/);
    expect(count(html, "<button")).toBe(1);
    // The header sits in the band, before the body; the content in the body.
    const band = html.indexOf(BAND);
    const body = html.indexOf(BODY);
    expect(band).toBeLessThan(body);
    for (const part of ["Channels", "Where messages go.", "2 on", "Add channel"]) {
      const at = html.indexOf(part);
      expect(at).toBeGreaterThan(band);
      expect(at).toBeLessThan(body);
    }
    expect(html.indexOf("Body")).toBeGreaterThan(body);
  });

  it("lines the band up with the content's 20 px sides and drops Kumo's body padding", () => {
    const html = renderToStaticMarkup(
      h(Section, { id: "x", title: "X" }, h(SectionBody, null, "Body")),
    );
    // The band keeps its place (Kumo pulls it under the body by default).
    expect(html).toMatch(/class="[^"]*bg-kumo-elevated p-4[^"]*my-0 block px-5 py-3/);
    // Every body layout brings its own padding, so the body has none.
    expect(html).toMatch(/class="[^"]*ring-kumo-fill[^"]*block min-w-0 p-0"/);
    expect(html).not.toMatch(/ring-kumo-fill[^"]*pr-3/);
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
      'class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"',
    );
    // The text only grows beside the action in the row; in the column it is full width.
    expect(html).toContain('class="grid min-w-0 gap-0.5 sm:flex-1"');
    expect(html).toMatch(/<div class="sm:shrink-0"><button/);
  });

  it("is the band alone when it has nothing below its header", () => {
    const html = renderToStaticMarkup(
      h(Section, { id: "x", title: "X", action: h(Button, null, "Do it") }, null, false),
    );
    expectOneCard(html, { body: false });
    expect(text(html)).toContain("Do it");
  });

  it("takes one action at most, by type", () => {
    const one = h(Button, null, "One");
    // @ts-expect-error: a section has one primary action, not a list of them.
    h(Section, { id: "x", title: "X", action: [one, one] });
  });

  it("shows an error as a banner at the top of the body, with a message's links", () => {
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
    expectOneCard(html);
    expect(html.indexOf(BODY)).toBeLessThan(html.indexOf("Enable sandbox"));
    expect(html.indexOf("Enable sandbox")).toBeLessThan(html.indexOf("Body"));
    expect(html).toContain('href="/settings/building#sandbox"');
  });

  it("shows the empty state in the body instead of the content", () => {
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
    expect(html.indexOf(BODY)).toBeLessThan(html.indexOf("No passkeys yet"));
    expectOneCard(html);
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
    expectOneCard(html);
    expect(html).toContain("divide-y");
    expect(html).toMatch(/<div id="rotate" class="[^"]*scroll-mt-6/);
    expect(count(html, "<button")).toBe(2);
    expect(text(html)).toContain("Signs everyone out.");
  });

  it("puts a table flush in the body, scrolling sideways, its outer columns in line with the heading", () => {
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
    expectOneCard(html);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("[&amp;_tr&gt;:first-child]:pl-5 [&amp;_tr&gt;:last-child]:pr-5");
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
