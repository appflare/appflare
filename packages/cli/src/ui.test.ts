import { describe, expect, it } from "vitest";
import { bannerFor, colorEnabled, formatBanner } from "./ui.ts";

const terminal = { isTTY: true, hasColors: () => true };

describe("colorEnabled", () => {
  it("colours a terminal that supports it", () => {
    expect(colorEnabled({}, terminal)).toBe(true);
  });
  it("turns colour off for any non-empty NO_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, terminal)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "false" }, terminal)).toBe(false);
  });
  it("ignores an empty NO_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "" }, terminal)).toBe(true);
  });
  it("never colours a pipe or a file", () => {
    expect(colorEnabled({}, { isTTY: false })).toBe(false);
    expect(colorEnabled({}, {})).toBe(false);
  });
  it("respects a terminal without colour support", () => {
    expect(colorEnabled({}, { isTTY: true, hasColors: () => false })).toBe(false);
  });
  it("passes the environment to the terminal's own check", () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const env = { FORCE_COLOR: "0" };
    const hasColors = (e?: NodeJS.ProcessEnv) => {
      if (e !== undefined) seen.push(e);
      return false;
    };
    colorEnabled(env, { isTTY: true, hasColors });
    expect(seen).toEqual([env]);
  });
});

describe("formatBanner", () => {
  it("is one plain line without colour", () => {
    expect(formatBanner(false)).toBe("Appflare · self-hosted app manager for Cloudflare");
  });
  it("adds only bold and dim when coloured", () => {
    const line = formatBanner(true);
    expect(line).not.toContain("\n");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escapes themselves.
    expect(line.replace(/\u001b\[[0-9;]*m/g, "")).toBe(formatBanner(false));
    expect(line.startsWith("\u001b[1mAppflare")).toBe(true);
  });
});

describe("bannerFor", () => {
  it("prints nothing when stderr is a pipe or a file", () => {
    expect(bannerFor({}, { isTTY: false })).toBeNull();
    expect(bannerFor({}, {})).toBeNull();
  });
  it("is coloured on a colour terminal", () => {
    expect(bannerFor({}, terminal)).toBe(formatBanner(true));
  });
  it("is plain on a terminal with NO_COLOR", () => {
    expect(bannerFor({ NO_COLOR: "1" }, terminal)).toBe(formatBanner(false));
  });
});
