import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogView } from "../catalog/catalogs.functions";

/**
 * Settings, Catalogs, with the server functions standing in: nothing here
 * touches a catalog.
 */
const calls = vi.hoisted(() => ({
  addCatalog: vi.fn(),
  deleteCatalog: vi.fn(async () => ({})),
  setCatalogEnabled: vi.fn(async () => ({})),
  updateCatalog: vi.fn(async () => ({})),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../catalog/catalogs.functions", () => ({
  addCatalog: calls.addCatalog,
  deleteCatalog: calls.deleteCatalog,
  setCatalogEnabled: calls.setCatalogEnabled,
  updateCatalog: calls.updateCatalog,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: calls.invalidate, navigate: async () => {} }),
}));

const { CatalogsList } = await import("./catalogs-settings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-09-25T10:00:00.000Z";

const OFFICIAL: CatalogView = {
  id: "official",
  label: "Appflare",
  colour: "orange",
  official: true,
  indexUrl: "https://catalog.example.com/index.json",
  enabled: true,
  keys: [],
  addedAt: null,
  refreshedAt: ISO,
  refreshError: null,
  apps: 12,
  installs: 2,
};

const MINE: CatalogView = {
  ...OFFICIAL,
  id: "mine",
  label: "Mine",
  colour: "blue",
  official: false,
  indexUrl: "https://mine.example.com/index.json",
  keys: [{ keyId: "mine-2026", publicKeyBase64: "AAAA", fingerprint: "SHA256:abc" }],
  addedAt: ISO,
  installs: 0,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const call of Object.values(calls)) call.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(catalogs: CatalogView[], isAdmin = true) {
  act(() =>
    root.render(
      <Toasty>
        <TooltipProvider>
          <CatalogsList catalogs={catalogs} isAdmin={isAdmin} />
        </TooltipProvider>
      </Toasty>,
    ),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function menuButton(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${label}"]`);
}

async function pick(label: string, item: string) {
  const trigger = menuButton(label);
  if (trigger === null) throw new Error(`no menu for ${label}`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await settle();
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (i) => i.textContent?.trim() === item,
  );
  if (found === undefined) throw new Error(`no menu item "${item}"`);
  await act(async () => found.click());
  await settle();
}

function dialog(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (found === null) throw new Error("no dialog");
  return found;
}

function button(within: HTMLElement, label: string): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

describe("CatalogsList", () => {
  it("puts an added catalog's Edit and Remove in a menu named after it, and none on the official one", () => {
    show([OFFICIAL, MINE]);
    expect(menuButton("Mine")).not.toBeNull();
    expect(menuButton("Appflare")).toBeNull();
    // No loose row buttons.
    const rowButtons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(rowButtons).not.toContain("Edit");
    expect(rowButtons).not.toContain("Remove");
    expect(rowButtons).toContain("Add catalog");
  });

  it("offers members no menu", () => {
    show([OFFICIAL, MINE], false);
    expect(menuButton("Mine")).toBeNull();
    expect(container.textContent).not.toContain("Add catalog");
  });

  it("opens Edit from the menu with the catalog's saved values", async () => {
    show([OFFICIAL, MINE]);
    await pick("Mine", "Edit");
    expect(dialog().textContent).toContain("Edit Mine");
    const url = dialog().querySelector<HTMLInputElement>('input[type="url"]');
    expect(url?.value).toBe(MINE.indexUrl);
  });

  it("asks before Remove, without a question mark, and removes on confirm", async () => {
    show([OFFICIAL, MINE]);
    await pick("Mine", "Remove");
    expect(dialog().textContent).toContain("Remove Mine");
    expect(dialog().textContent).not.toContain("Remove Mine?");
    expect(calls.deleteCatalog).not.toHaveBeenCalled();
    await act(async () => button(dialog(), "Remove catalog").click());
    await settle();
    expect(calls.deleteCatalog).toHaveBeenCalledWith({ data: { id: "mine" } });
  });

  it("returns the focus to the row's menu button when Edit or Remove is cancelled", async () => {
    show([OFFICIAL, MINE]);
    await pick("Mine", "Edit");
    await act(async () => button(dialog(), "Cancel").click());
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton("Mine"));

    await pick("Mine", "Remove");
    await act(async () => button(dialog(), "Cancel").click());
    await settle();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton("Mine"));
  });

  it("moves the focus to Add catalog once the removed catalog's row is gone", async () => {
    calls.invalidate.mockImplementationOnce(async () => show([OFFICIAL]));
    show([OFFICIAL, MINE]);
    await pick("Mine", "Remove");
    await act(async () => button(dialog(), "Remove catalog").click());
    await settle();
    expect(menuButton("Mine")).toBeNull();
    expect(document.activeElement).toBe(button(container, "Add catalog"));
  });

  it("keeps Remove off while apps installed from the catalog remain", async () => {
    show([OFFICIAL, { ...MINE, installs: 1 }]);
    await pick("Mine", "Remove");
    expect(dialog().textContent).toContain("1 app is installed from Mine");
    expect(button(dialog(), "Remove catalog").disabled).toBe(true);
  });

  it("shows no Off badge beside the switch that already says Off", () => {
    show([{ ...OFFICIAL, enabled: false }]);
    const offs = [...container.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === "Off",
    );
    expect(offs).toHaveLength(1);
  });

  it("shows a failed refresh in error tone, with its links", () => {
    show([
      {
        ...MINE,
        refreshError: "The index did not load; see [the catalogs settings](/settings/catalogs).",
      },
    ]);
    const failed = [...container.querySelectorAll("span")].find((s) =>
      s.textContent?.startsWith(" Last attempt failed"),
    );
    expect(failed?.className).toContain("text-kumo-danger");
    expect(failed?.querySelector("a")?.getAttribute("href")).toBe("/settings/catalogs");
  });
});
