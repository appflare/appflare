import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerStatus } from "../installs/pending-updates";
import type { Viewer } from "../server/session.functions";

/**
 * The signed-in shell's sidebar header on a wide screen. The router and the
 * sidebar's parts that load their own data stand in.
 */
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/", hash: "" }),
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) => select([]),
  useRouter: () => ({ navigate: vi.fn(), subscribe: () => () => {} }),
}));
vi.mock("../home/use-attention", () => ({ useHomeClick: () => () => {} }));
vi.mock("./account-menu", () => ({ AccountMenu: () => null }));
vi.mock("./appflare-card", () => ({ AppflareCard: () => null, AppflareVersion: () => null }));
vi.mock("./settings-nav", () => ({ SettingsNavItem: () => null }));

const { AppShell } = await import("./app-shell");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render() {
  act(() =>
    root.render(
      <AppShell
        viewer={{ role: "admin" } as Viewer}
        manager={{} as ManagerStatus}
        removedApps={0}
        apps={[]}
        badge={{ count: 0, label: "" }}
      >
        <p>Page</p>
      </AppShell>,
    ),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

function trigger(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]');
  if (found === null) throw new Error("no sidebar trigger");
  return found;
}

describe("folding the sidebar", () => {
  it("keeps the keyboard focus on the trigger, which each header renders on its own", async () => {
    render();
    const collapse = trigger();
    expect(collapse.getAttribute("aria-label")).toBe("Collapse sidebar");
    act(() => collapse.focus());
    await act(async () => collapse.click());
    await settle();
    const expand = trigger();
    expect(expand).not.toBe(collapse);
    expect(expand.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(document.activeElement).toBe(expand);

    await act(async () => expand.click());
    await settle();
    expect(trigger().getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves the focus alone when the trigger did not have it", async () => {
    render();
    const page = document.createElement("button");
    document.body.appendChild(page);
    act(() => page.focus());
    await act(async () => trigger().click());
    await settle();
    expect(trigger().getAttribute("aria-label")).toBe("Expand sidebar");
    expect(document.activeElement).toBe(page);
  });
});
