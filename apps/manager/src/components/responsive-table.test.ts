import { Table } from "@cloudflare/kumo";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { edgeFadeMask, ResponsiveTable, scrollEdges } from "./responsive-table";

function render(props: { stickyFirstColumn?: boolean; minWidth?: "sm" | "md" | "lg" }): string {
  const body = createElement(
    Table.Body,
    null,
    createElement(Table.Row, null, createElement(Table.Cell, null, "cut")),
  );
  // A wrapper component, so the table's hooks run inside a render.
  const Harness = () => ResponsiveTable({ label: "Apps", ...props, children: body });
  return renderToStaticMarkup(createElement(Harness));
}

/** The class attribute of the scroll region. */
function regionClass(html: string): string {
  const match = html.match(/<section[^>]*class="([^"]*)"/);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("ResponsiveTable", () => {
  it("wraps the table in a named, sideways-scrolling region", () => {
    const html = render({});
    expect(html).toContain('aria-label="Apps"');
    expect(regionClass(html)).toContain("overflow-x-auto");
    expect(regionClass(html)).toContain("[-webkit-overflow-scrolling:touch]");
    expect(html).toMatch(/<table[^>]*class="[^"]*min-w-\[40rem\]/);
    expect(html).toContain(">cut<");
  });

  it("sets the minimum width the caller asks for", () => {
    expect(render({ minWidth: "sm" })).toMatch(/<table[^>]*min-w-\[30rem\]/);
    expect(render({ minWidth: "lg" })).toMatch(/<table[^>]*min-w-\[48rem\]/);
  });

  it("pins the first column only when asked", () => {
    // React escapes the selector's `&` and `>` inside the attribute.
    const pinned = regionClass(render({ stickyFirstColumn: true }));
    expect(pinned).toContain("first-child]:sticky");
    expect(pinned).toContain("first-child]:left-0");
    expect(regionClass(render({}))).not.toContain("sticky");
  });

  it("is not focusable and has no fade before anything is measured as hidden", () => {
    const html = render({});
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("mask-image");
  });
});

describe("scrollEdges", () => {
  it("reports content hidden past either edge", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 })).toEqual({
      start: false,
      end: false,
    });
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 640, clientWidth: 375 })).toEqual({
      start: false,
      end: true,
    });
    expect(scrollEdges({ scrollLeft: 100, scrollWidth: 640, clientWidth: 375 })).toEqual({
      start: true,
      end: true,
    });
    expect(scrollEdges({ scrollLeft: 265, scrollWidth: 640, clientWidth: 375 })).toEqual({
      start: true,
      end: false,
    });
  });

  it("ignores sub-pixel remainders", () => {
    expect(scrollEdges({ scrollLeft: 0.5, scrollWidth: 400.5, clientWidth: 400 })).toEqual({
      start: false,
      end: false,
    });
  });
});

describe("edgeFadeMask", () => {
  it("fades only the edges with content beyond them", () => {
    expect(edgeFadeMask({ start: false, end: false }, false)).toBeUndefined();
    expect(edgeFadeMask({ start: false, end: true }, false)).toBe(
      "linear-gradient(to right, #000, #000 calc(100% - 1.5rem), transparent)",
    );
    expect(edgeFadeMask({ start: true, end: false }, false)).toBe(
      "linear-gradient(to right, transparent, #000 1.5rem, #000)",
    );
    expect(edgeFadeMask({ start: true, end: true }, false)).toBe(
      "linear-gradient(to right, transparent, #000 1.5rem, #000 calc(100% - 1.5rem), transparent)",
    );
  });

  it("never fades the left edge behind a pinned first column", () => {
    expect(edgeFadeMask({ start: true, end: false }, true)).toBeUndefined();
    expect(edgeFadeMask({ start: true, end: true }, true)).toBe(
      "linear-gradient(to right, #000, #000 calc(100% - 1.5rem), transparent)",
    );
  });
});
