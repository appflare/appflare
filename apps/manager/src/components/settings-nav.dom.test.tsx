import { Sidebar } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleSettingsPages } from "./navigation";
import { SETTINGS_MENU_KEY, SettingsNavigationContext } from "./settings-menu";
import { SettingsNavItem, SettingsPageSelect } from "./settings-nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** The sidebar's Settings entry on `pathname`, expanded or folded into the rail. */
function renderNav(pathname: string, { folded = false, removedApps = 0 } = {}) {
  act(() =>
    root.render(
      <Sidebar.Provider collapsible="icon" open={!folded}>
        <Sidebar>
          <Sidebar.Content>
            <Sidebar.Menu>
              <SettingsNavItem
                pathname={pathname}
                pages={visibleSettingsPages(removedApps, pathname)}
                folded={folded}
              />
            </Sidebar.Menu>
          </Sidebar.Content>
        </Sidebar>
      </Sidebar.Provider>,
    ),
  );
}

function settingsButton(): HTMLElement {
  const button = [...document.querySelectorAll<HTMLElement>("[data-sidebar=menu-button]")].find(
    (b) => b.textContent?.includes("Settings"),
  );
  if (button === undefined) throw new Error("no Settings button");
  return button;
}

/** The page list under Settings, and whether it is open. */
function pageList() {
  const list = document.querySelector('[aria-label="Settings pages"]');
  if (list === null) throw new Error("no page list");
  const region = list.closest("[role=region]");
  return {
    open: region?.getAttribute("aria-hidden") === "false",
    labels: [...list.querySelectorAll("a")].map((a) => a.textContent),
    current: list.querySelector('[aria-current="page"]')?.textContent ?? null,
  };
}

describe("Settings in the sidebar", () => {
  it("is a button with a chevron that opens the page list in place, without a link to follow", () => {
    renderNav("/catalog");
    const button = settingsButton();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("href")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(pageList().open).toBe(false);

    act(() => button.click());
    expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
    expect(pageList().open).toBe(true);
    expect(pageList().labels).toEqual([
      "Your account",
      "Building apps",
      "Updates",
      "Users and sign-in",
      "Domains",
      "Notifications",
      "Catalogs",
      "Usage data",
    ]);
  });

  it("remembers the choice in this browser", () => {
    renderNav("/catalog");
    act(() => settingsButton().click());
    expect(window.localStorage.getItem(SETTINGS_MENU_KEY)).toBe("open");

    // Another page, a new visit: still open.
    act(() => root.unmount());
    root = createRoot(container);
    renderNav("/jobs");
    expect(pageList().open).toBe(true);

    act(() => settingsButton().click());
    expect(window.localStorage.getItem(SETTINGS_MENU_KEY)).toBe("closed");
    expect(pageList().open).toBe(false);
  });

  it("opens by itself on the way into Settings, with that page marked, and does not remember that", () => {
    window.localStorage.setItem(SETTINGS_MENU_KEY, "closed");
    renderNav("/catalog");
    expect(pageList().open).toBe(false);
    renderNav("/settings/building");
    expect(pageList().open).toBe(true);
    expect(pageList().current).toBe("Building apps");
    // Only a click is remembered.
    expect(window.localStorage.getItem(SETTINGS_MENU_KEY)).toBe("closed");
    // The page is marked in the list, so Settings itself is not highlighted.
    expect(settingsButton().hasAttribute("data-active")).toBe(false);

    // Back out of Settings, the remembered choice applies again.
    renderNav("/jobs");
    expect(pageList().open).toBe(false);
  });

  it("stays closed between settings pages once closed by hand", () => {
    renderNav("/settings/account");
    expect(pageList().open).toBe(true);

    act(() => settingsButton().click());
    expect(pageList().open).toBe(false);
    expect(window.localStorage.getItem(SETTINGS_MENU_KEY)).toBe("closed");
    // Settings is highlighted instead of the hidden page.
    expect(settingsButton().hasAttribute("data-active")).toBe(true);

    // A link to another settings page does not open it again.
    renderNav("/settings/users");
    expect(pageList().open).toBe(false);
    expect(window.localStorage.getItem(SETTINGS_MENU_KEY)).toBe("closed");
  });

  it("lists Removed apps only while it has entries", () => {
    renderNav("/settings/account", { removedApps: 0 });
    expect(pageList().labels).not.toContain("Removed apps");
    renderNav("/settings/account", { removedApps: 3 });
    expect(pageList().labels).toContain("Removed apps");
  });

  it("in the folded rail, opens a menu of the same pages from the gear", async () => {
    renderNav("/settings/updates", { folded: true, removedApps: 1 });
    // No list in the rail: the gear is a menu button.
    expect(document.querySelector('[aria-label="Settings pages"]')).toBeNull();
    const gear = settingsButton();
    expect(gear.getAttribute("aria-haspopup")).toBe("menu");

    await act(async () => {
      gear.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      gear.click();
    });
    const menu = await vi.waitFor(() => {
      const found = document.querySelector("[role=menu]");
      if (found === null) throw new Error("menu not open");
      return found;
    });
    const items = [...menu.querySelectorAll("[role=menuitem]")];
    expect(items.map((i) => i.textContent)).toEqual([
      "Your account",
      "Building apps",
      "Updates",
      "Users and sign-in",
      "Domains",
      "Notifications",
      "Catalogs",
      "Removed apps",
      "Usage data",
    ]);
    const updates = items.find((i) => i.textContent === "Updates");
    expect(updates?.getAttribute("href")).toBe("/settings/updates");
    expect(updates?.getAttribute("aria-current")).toBe("page");
  });
});

describe("the settings page list on narrow screens", () => {
  it("shows the page open and opens the page chosen", async () => {
    const navigate = vi.fn();
    const pages = visibleSettingsPages(0, "/settings/updates");
    act(() =>
      root.render(
        <SettingsNavigationContext.Provider value={{ pages, navigate }}>
          <SettingsPageSelect href="/settings/updates" />
        </SettingsNavigationContext.Provider>,
      ),
    );
    const trigger = document.querySelector<HTMLElement>('[aria-label="Settings page"]');
    if (trigger === null) throw new Error("no page list");
    expect(trigger.textContent).toContain("Updates");
    expect(container.firstElementChild?.className).toBe("md:hidden");

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    const options = await vi.waitFor(() => {
      const found = [...document.querySelectorAll("[role=option]")];
      if (found.length === 0) throw new Error("list not open");
      return found;
    });
    expect(options.map((o) => o.textContent)).toEqual(pages.map((p) => p.label));
    expect(options.map((o) => o.textContent)).not.toContain("Removed apps");

    const users = options.find((o) => o.textContent === "Users and sign-in") as HTMLElement;
    await act(async () => users.click());
    expect(navigate).toHaveBeenCalledWith("/settings/users");
  });
});
