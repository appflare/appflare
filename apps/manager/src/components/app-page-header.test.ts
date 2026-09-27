import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ADMINS_ONLY, type AppStat, type HeaderAction, provenance } from "../catalog/app-page";
import { AppPageHeader } from "./app-page-header";
import { AppStatStrip } from "./app-stat-strip";

function header(action: HeaderAction): string {
  return renderToStaticMarkup(
    createElement(AppPageHeader, {
      name: "Cut",
      iconSrc: null,
      tagline: "Short links on your own domain",
      authors: [],
      withAvatars: false,
      provenance: provenance(null, "artifact"),
      action,
      onInstall: () => undefined,
      onManageSeveral: () => undefined,
    }),
  );
}

/** Visible and screen-reader text, tags removed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** The first opening tag that carries `attribute`, whatever the order of its attributes. */
function openingTag(html: string, attribute: string): string {
  const tag = html.match(/<[a-z][^>]*>/g)?.find((t) => t.includes(attribute));
  if (tag === undefined) throw new Error(`no element with ${attribute}`);
  return tag;
}

describe("AppPageHeader", () => {
  it("offers Install, a standard button sized to its label", () => {
    const html = header({ kind: "install", disabled: false, reason: null });
    const button = openingTag(html, 'aria-label="Install Cut"');
    expect(button).toMatch(/^<button /);
    expect(button).not.toContain("min-w-");
    expect(text(html)).toContain("Install");
    expect(text(html)).not.toMatch(/\bGet\b/);
  });

  it("keeps a member's reason in view under the button", () => {
    const html = header({ kind: "install", disabled: true, reason: ADMINS_ONLY });
    expect(html).toContain(`aria-label="Install Cut. ${ADMINS_ONLY}."`);
    expect(text(html)).toContain(ADMINS_ONLY);
    expect(text(html)).not.toContain("Version");
  });

  it("offers Manage once installed", () => {
    const html = header({ kind: "manage", href: "/apps/01J", count: 1 });
    expect(openingTag(html, 'aria-label="Manage Cut"')).toContain('href="/apps/01J"');
  });

  it("puts nothing under the button otherwise: the version is in the stat strip", () => {
    const html = header({ kind: "install", disabled: false, reason: null });
    expect(text(html)).not.toMatch(/Version|Latest build/);
    expect(text(header({ kind: "manage", href: "/apps/01J", count: 1 }))).not.toContain("Version");
  });
});

/** The opening tag of the element whose text starts with `start`. */
function tagBefore(markup: string, start: string): string {
  const at = markup.indexOf(`>${start}`);
  if (at < 0) throw new Error(`no element with text ${start}`);
  return markup.slice(markup.lastIndexOf("<", at), at + 1);
}

describe("AppStatStrip", () => {
  const stat = (id: AppStat["id"], value: string): AppStat => ({
    id,
    label: id,
    value,
    caption: null,
    tooltip: value,
    tone: "default",
  });

  it("keeps every value on one line, cut with an ellipsis", () => {
    const markup = renderToStaticMarkup(
      createElement(AppStatStrip, {
        stats: [stat("plan", "Workers Paid"), stat("version", "Sep 21")],
      }),
    );
    for (const value of ["Workers Paid", "Sep 21"]) {
      const tag = tagBefore(markup, value);
      expect(tag).toContain("truncate");
      expect(tag).toContain("min-w-0");
    }
    expect(markup).not.toContain("overflow-wrap");
  });
});
