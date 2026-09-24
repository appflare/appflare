import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHANNEL_KINDS, type ChannelKind } from "../notifications/channels";
import { CHANNEL_KIND_LOGOS, ChannelKindLogo, DISCORD_BLURPLE } from "./channel-logos";

function render(kind: ChannelKind, size?: number): string {
  return renderToStaticMarkup(createElement(ChannelKindLogo, { kind, size }));
}

describe("ChannelKindLogo", () => {
  it("has exactly one logo per kind, a different one for each", () => {
    expect(Object.keys(CHANNEL_KIND_LOGOS).sort()).toEqual([...CHANNEL_KINDS].sort());
    expect(new Set(Object.values(CHANNEL_KIND_LOGOS)).size).toBe(CHANNEL_KINDS.length);
  });

  it.each(CHANNEL_KINDS)("renders the %s logo as one decorative, sized svg", (kind) => {
    const html = render(kind, 24);
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain(`data-channel-logo="${kind}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/<svg[^>]* width="24"/);
    expect(html).toMatch(/<svg[^>]* height="24"/);
    expect(html).not.toContain("<title");
  });

  it("draws 20 pixels square when no size is given", () => {
    for (const kind of CHANNEL_KINDS) {
      expect(render(kind)).toMatch(/<svg[^>]* width="20" height="20"/);
    }
  });

  it("keeps the brand colours", () => {
    expect(render("telegram")).toContain('stop-color="#2AABEE"');
    const slack = render("slack");
    for (const colour of ["#36C5F0", "#2EB67D", "#ECB22E", "#E01E5A"]) {
      expect(slack).toContain(`fill="${colour}"`);
    }
  });

  it("draws Discord in currentColor, Discord's blue unless overridden", () => {
    const html = render("discord");
    expect(html).toContain(`color="${DISCORD_BLURPLE}"`);
    expect(html).toContain('fill="currentColor"');
  });

  it("gives each Telegram logo its own gradient id", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, [
        createElement(ChannelKindLogo, { key: "a", kind: "telegram" }),
        createElement(ChannelKindLogo, { key: "b", kind: "telegram" }),
      ]),
    );
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`fill="url(#${id})"`);
  });
});
