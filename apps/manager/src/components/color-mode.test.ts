import { describe, expect, it } from "vitest";
import {
  COLOR_MODE_KEY,
  COLOR_MODE_SCRIPT,
  COLOR_MODE_SCRIPT_SHA256,
  parseColorModeChoice,
  resolveColorMode,
  THEME_COLOR,
} from "./color-mode";

describe("the colour mode", () => {
  it("is light unless dark or system was chosen", () => {
    expect(parseColorModeChoice(null)).toBe("light");
    expect(parseColorModeChoice(undefined)).toBe("light");
    expect(parseColorModeChoice("auto")).toBe("light");
    expect(parseColorModeChoice("light")).toBe("light");
    expect(parseColorModeChoice("dark")).toBe("dark");
    expect(parseColorModeChoice("system")).toBe("system");
  });

  it("follows the browser only for system", () => {
    expect(resolveColorMode("light", true)).toBe("light");
    expect(resolveColorMode("light", false)).toBe("light");
    expect(resolveColorMode("dark", false)).toBe("dark");
    expect(resolveColorMode("dark", true)).toBe("dark");
    expect(resolveColorMode("system", true)).toBe("dark");
    expect(resolveColorMode("system", false)).toBe("light");
  });

  it("is applied before the first paint from the stored choice, with the same rule", () => {
    expect(COLOR_MODE_SCRIPT).toContain(`localStorage.getItem(k)`);
    expect(COLOR_MODE_SCRIPT).toContain(`const k=${JSON.stringify(COLOR_MODE_KEY)}`);
    // Dark only for "dark", or "system" with a dark browser; light otherwise.
    expect(COLOR_MODE_SCRIPT).toContain(`c==="dark"||(c==="system"&&q.matches)?"dark":"light"`);
    expect(COLOR_MODE_SCRIPT).toContain(JSON.stringify(THEME_COLOR));
  });

  it("publishes the script's hash for Content-Security-Policy", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(COLOR_MODE_SCRIPT),
    );
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(COLOR_MODE_SCRIPT_SHA256).toBe(base64);
  });
});
