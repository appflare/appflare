import { Sidebar } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppSignal } from "../home/attention";
import { SidebarAppsGroup } from "./sidebar-apps";
import { MAX_VISIBLE_APPS, type SidebarApp, sidebarApps } from "./sidebar-apps-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const NAMES = [
  "Counterscale",
  "Cut",
  "FlareMo",
  "Microfeed",
  "EdgeChat",
  "Emailflare",
  "Projektor",
  "Clist",
  "Isupmap",
  "EdgeKey",
  "Folia",
  "Minshop",
];

function apps(count: number, signals: Record<string, AppSignal> = {}): SidebarApp[] {
  return sidebarApps(
    NAMES.slice(0, count).map((name) => ({
      id: name.toLowerCase(),
      name,
      displayName: null,
      label: name.toLowerCase(),
      icon: null,
    })),
    new Map(Object.entries(signals)),
  );
}

function render(list: SidebarApp[], pathname = "/") {
  act(() =>
    root.render(
      <Sidebar.Provider>
        <Sidebar>
          <Sidebar.Content>
            <SidebarAppsGroup apps={list} pathname={pathname} />
          </Sidebar.Content>
        </Sidebar>
      </Sidebar.Provider>,
    ),
  );
}

const rows = () =>
  [...container.querySelectorAll<HTMLElement>("a[href^='/apps/'] [data-app-label]")].map((a) =>
    a.textContent?.trim(),
  );
const filterButton = () =>
  container.querySelector<HTMLButtonElement>("button[aria-label='Filter your apps']");
const filterInput = () =>
  container.querySelector<HTMLInputElement>("input[aria-label='Filter your apps']");

function typeInto(input: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Your apps in the sidebar", () => {
  it("lists the apps by name, each going to its page, with its status dot", () => {
    render(apps(4, { cut: "failed", microfeed: "update" }));
    expect(rows()).toEqual(["Counterscale", "Cut", "FlareMo", "Microfeed"]);
    const cut = container.querySelector("a[href='/apps/cut']");
    expect(cut?.querySelector("[role=img][aria-label='Something did not finish']")).not.toBeNull();
    expect(
      container.querySelector("a[href='/apps/microfeed'] [aria-label='Update available']"),
    ).not.toBeNull();
    expect(container.querySelector("a[href='/apps/flaremo'] [data-signal]")).toBeNull();
  });

  it("marks the open app's row", () => {
    render(apps(4), "/apps/cut");
    expect(container.querySelector("a[aria-current='page']")?.getAttribute("href")).toBe(
      "/apps/cut",
    );
  });

  it("filters as you type, and Escape clears and closes the filter", () => {
    render(apps(12));
    expect(filterInput()).toBeNull();
    act(() => filterButton()?.click());
    const input = filterInput();
    if (input === null) throw new Error("no filter field");
    expect(document.activeElement).toBe(input);

    typeInto(input, "edge");
    expect(rows()).toEqual(["EdgeChat", "EdgeKey"]);
    typeInto(input, "zzz");
    expect(rows()).toEqual([]);
    expect(container.textContent).toContain("No app matches “zzz”.");

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(filterInput()).toBeNull();
    expect(filterButton()).not.toBeNull();
    expect(rows()).toHaveLength(12);
  });

  it("closes an empty filter when it loses focus", () => {
    render(apps(3));
    act(() => filterButton()?.click());
    act(() => filterInput()?.blur());
    expect(filterInput()).toBeNull();
  });

  it("shows at most eight rows and scrolls the rest inside the group", () => {
    render(apps(MAX_VISIBLE_APPS));
    const list = () =>
      container.querySelector<HTMLElement>("[data-sidebar='group'] [data-sidebar='viewport']");
    expect(list()?.hasAttribute("data-capped")).toBe(false);
    expect(list()?.className).not.toContain("max-h-");

    render(apps(12));
    expect(rows()).toHaveLength(12);
    expect(list()?.hasAttribute("data-capped")).toBe(true);
    expect(list()?.className).toContain("max-h-[279px]");
    expect(list()?.className).toContain("overflow-y-auto");
  });
});
