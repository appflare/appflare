import { TooltipProvider } from "@cloudflare/kumo";
import { act, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxReadiness } from "../sandbox/readiness";

// The dialog only calls these once a build starts; the anchor needs a router.
vi.mock("../installs/source-builds.functions", () => ({ startSourceBuild: vi.fn() }));
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
vi.mock("./router-anchor", () => ({
  RouterAnchor: forwardRef<HTMLAnchorElement, { href?: string }>(function Anchor(props, ref) {
    return <a ref={ref} {...props} />;
  }),
}));

const { ADD_CATALOG_HREF, CatalogAddMenu } = await import("./catalog-add-menu");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sandbox: SandboxReadiness = { state: "on", missing: null, confirmed: true };

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

function render(repositoryBuilds: boolean) {
  act(() =>
    root.render(
      <TooltipProvider>
        <CatalogAddMenu repositoryBuilds={repositoryBuilds} sandbox={sandbox} />
      </TooltipProvider>,
    ),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function addButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
  if (button === null) throw new Error('no "Add" button');
  return button;
}

async function openMenu() {
  await act(async () => {
    addButton().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    addButton().click();
  });
  await settle();
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("the Catalog page's add menu", () => {
  it("offers building from a repository and adding a catalog", async () => {
    render(true);
    await openMenu();
    expect(menuItems().map((i) => i.textContent?.trim())).toEqual([
      "From a repository…",
      "Add a catalog",
    ]);
  });

  it("links Add a catalog to the Catalogs settings", async () => {
    render(true);
    await openMenu();
    const link = menuItems().find((i) => i.textContent?.includes("Add a catalog"));
    expect(ADD_CATALOG_HREF).toBe("/settings/catalogs#catalogs");
    expect(link?.closest("a")?.getAttribute("href") ?? link?.getAttribute("href")).toBe(
      ADD_CATALOG_HREF,
    );
  });

  it("opens the repository dialog, and gives focus back to + when it closes", async () => {
    render(true);
    await openMenu();
    const item = menuItems().find((i) => i.textContent?.includes("From a repository"));
    await act(async () => item?.click());
    await settle();
    expect(document.body.textContent).toContain("Install from a repository");
    const cancel = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    await settle();
    expect(document.activeElement).toBe(addButton());
  });

  it("offers only Add a catalog when the account cannot build from a repository", async () => {
    render(false);
    await openMenu();
    expect(menuItems().map((i) => i.textContent?.trim())).toEqual(["Add a catalog"]);
  });
});
