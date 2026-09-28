import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHANNEL_KINDS, type ChannelKind } from "../notifications/channels";
import {
  CHANNEL_KIND_LOGOS,
  ChannelKindLogo,
  DISCORD_BLURPLE,
  TELEGRAM_BLUE,
} from "./channel-logos";

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

  it("draws Telegram and Discord in their brand blue", () => {
    expect(render("telegram")).toMatch(new RegExp(`<svg[^>]* fill="${TELEGRAM_BLUE}"`));
    expect(render("discord")).toMatch(new RegExp(`<svg[^>]* fill="${DISCORD_BLURPLE}"`));
  });

  it("draws Slack and the webhook in the surrounding text colour", () => {
    expect(render("slack")).toMatch(/<svg[^>]* fill="currentColor"/);
    expect(render("webhook")).toMatch(/<svg[^>]* fill="currentColor"/);
  });
});
