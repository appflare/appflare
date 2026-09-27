import { describe, expect, it } from "vitest";
import {
  opensSettingsMenu,
  parseSettingsMenu,
  readSettingsMenu,
  SETTINGS_MENU_KEY,
  writeSettingsMenu,
} from "./settings-menu";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("the settings menu's open state", () => {
  it("is closed unless open was stored", () => {
    expect(parseSettingsMenu("open")).toBe("open");
    expect(parseSettingsMenu("closed")).toBe("closed");
    expect(parseSettingsMenu("true")).toBe("closed");
    expect(parseSettingsMenu(null)).toBe("closed");
  });

  it("is remembered in storage under its own key", () => {
    const storage = memoryStorage();
    expect(readSettingsMenu(storage)).toBe("closed");
    writeSettingsMenu(storage, "open");
    expect(storage.map.get(SETTINGS_MENU_KEY)).toBe("open");
    expect(readSettingsMenu(storage)).toBe("open");
    writeSettingsMenu(storage, "closed");
    expect(readSettingsMenu(storage)).toBe("closed");
    expect(SETTINGS_MENU_KEY).not.toBe("appflare:sidebar");
  });

  it("falls back to closed when storage is missing or blocked", () => {
    expect(readSettingsMenu(undefined)).toBe("closed");
    expect(readSettingsMenu(blocked)).toBe("closed");
    expect(() => writeSettingsMenu(blocked, "open")).not.toThrow();
  });
});

describe("opensSettingsMenu", () => {
  it("opens the list on the way into Settings, and on a first load there", () => {
    expect(opensSettingsMenu("/settings/account", null)).toBe(true);
    expect(opensSettingsMenu("/settings/building", "/")).toBe(true);
    expect(opensSettingsMenu("/settings/users", "/catalog")).toBe(true);
  });

  it("leaves it as it is between settings pages, and outside Settings", () => {
    // A list closed on one settings page stays closed on the next.
    expect(opensSettingsMenu("/settings/users", "/settings/account")).toBe(false);
    expect(opensSettingsMenu("/settings/account", "/settings/account")).toBe(false);
    expect(opensSettingsMenu("/", null)).toBe(false);
    expect(opensSettingsMenu("/catalog", "/settings/account")).toBe(false);
  });
});
